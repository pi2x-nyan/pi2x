/**
 * 工单运行时 —— 把 Trigger、闸门、槽位、通知串成一条线
 *
 * 对应 dsh-superagent 的 Engine + Tickets + Assignments 三件套，
 * 按 PI2X 的体量压成一个类：没有多 Source、没有 Eval 队列落盘，
 * 但授权判定、槽位、阶段、报告、影子模式一样不少。
 */

import fs from "node:fs";
import path from "node:path";
import { TicketStore } from "./store.mjs";
import { SlotManager } from "./slots.mjs";
import { Outbox, noticeKey, renderNotice, shouldNotifyStage } from "./notices.mjs";
import { gate, makeMandate, revalidate } from "./policy.mjs";
import {
  createTicket, createAssignment, startAssignment, endAssignment, makeReport,
  ticketStage, addInput, setAttention, endTicket, isLive, latestAssignment, ticketView,
} from "./model.mjs";

export class TicketRuntime {
  constructor({ file, slotLimit = 3, policy = {}, now = () => Date.now() } = {}) {
    this.store = new TicketStore(file);
    this.slots = new SlotManager({ limit: slotLimit });
    this.outbox = new Outbox();
    this.policy = { mode: "off", ...policy };
    this.now = now;
    /** ticketId -> worker 句柄（由宿主注入：session、send 等） */
    this.workers = new Map();
    this.decisions = [];
    this.decisionFile = path.join(path.dirname(file), "decisions.jsonl");
  }

  /**
   * Router 决策记录：accept / ignore / attach / requeue
   *
   * 这是 superagent 里 Router（主会话）的职责，之前我把这块留空了 ——
   * 结果「这条消息为什么被接/被丢」只能靠聊天记录猜。
   * 现在每次决定都落一行，含依据、目标工单、时延。
   *
   * @param {{triggerId?:string, action:"accept"|"ignore"|"attach"|"requeue", ticketId?:string, chatKey?:string, reason?:string, ms?:number}} d
   */
  recordDecision(d) {
    const rec = {
      at: new Date().toISOString(),
      action: d.action,
      triggerId: d.triggerId ?? null,
      ticketId: d.ticketId ?? null,
      chatKey: d.chatKey ?? null,
      reason: d.reason ?? null,
      ms: d.ms ?? null,
    };
    this.decisions.push(rec);
    if (this.decisions.length > 2000) this.decisions = this.decisions.slice(-1000);
    try {
      const file = this.decisionFile ?? path.join(path.dirname(this.store.file), "decisions.jsonl");
      this.decisionFile = file;
      fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    } catch { /* 记账失败不影响回合 */ }
    return rec;
  }

  listDecisions({ limit = 20 } = {}) {
    return this.decisions.slice(-limit);
  }

  setPolicy(p) {
    this.policy = { ...this.policy, ...p };
  }

  /**
   * 接单：过闸门 → 建工单（或影子工单）→ 返回 {ticket, verdict, shadow}
   * 真正的执行由宿主拿 ticket 去跑，跑完调 report()。
   */
  acceptFromTrigger(trigger, { title, channel } = {}) {
    const verdict = gate(trigger, this.policy);
    if (!verdict.admissible) {
      return { accepted: false, verdict, ticket: null };
    }
    const mandate = makeMandate(trigger, verdict, { mode: this.policy.mode });
    const t = createTicket({
      title: title ?? (trigger.text ?? "").slice(0, 60),
      chatKey: `qq:${trigger.channel?.chatType ?? "private"}:${trigger.channel?.chatId ?? ""}`,
      threadKey: trigger.threadKey,
      mandate,
      channel,
    });
    addInput(t, { human: true, text: trigger.text ?? "", triggerId: trigger.id, at: trigger.at });
    this.store.put(t);
    return { accepted: true, verdict, ticket: t, shadow: !!verdict.shadow };
  }

  /** 有人在工单上补一句话 */
  attachInput(ticketId, input) {
    const t = this.store.get(ticketId);
    if (!t || !isLive(t)) return null;
    addInput(t, input);
    this.store.put(t);
    return t;
  }

  /** 开始一次执行：拿槽位（满了排队） */
  async begin(ticketId) {
    const t = this.store.get(ticketId);
    if (!t) return null;
    const a = createAssignment({});
    t.assignments.push(a);
    const slot = this.slots.tryAcquire(ticketId) ?? await this.slots.enqueue(ticketId, () => {});
    startAssignment(a, slot);
    this.store.put(t);
    return a;
  }

  /**
   * 拿槽执行：有空槽立刻开跑；满了就排队，轮到再开。
   * fn 是「启动」函数（不 await 到任务结束），返回 {queued}。
   */
  start(ticketId, fn) {
    const slot = this.slots.tryAcquire(ticketId);
    if (slot == null) {
      const wait = this.slots.enqueue(ticketId, () => {});
      wait.then(async () => {
        await this.begin(ticketId);
        try { fn({ queued: true }); } catch { /* 启动失败由调用方日志记录 */ }
      });
      return { queued: true, ahead: this.slots.queued };
    }
    this.begin(ticketId).then(() => {
      try { fn({ queued: false }); } catch { /* 同上 */ }
    });
    return { queued: false };
  }

  /** 汇报一次进度或终局，返回最新阶段 */
  report(ticketId, { state = "progress", summary = "", needs = null, endReason = null } = {}) {
    const t = this.store.get(ticketId);
    if (!t) return null;
    const a = latestAssignment(t);
    if (!a) return null;
    const rep = makeReport({ state, summary, needs });
    a.report = rep;
    if (state === "ready" || state === "blocked" || state === "failed" || state === "dropped") {
      endAssignment(a, endReason ?? state, rep);
      this.slots.release(ticketId);
      // 卡住/失败不设 attention：那是「等回答」专用档位，混进来会把 blocked 顶成 answer，
      // 人看到的措辞就从「被卡住」变成「需要你回答」，语义错位。
      // 卡住靠 waitsForPerson 判（有没有新的真人输入），够了。
      if (state === "dropped") endTicket(t, { by: "executor", outcome: "dropped" });
    }
    this.store.put(t);
    return { ticket: t, stage: ticketStage(t), notice: this.noticeFor(t) };
  }

  /** 人验收通过或叫停 */
  end(ticketId, { by = "human", outcome = "completed", reason = null } = {}) {
    const t = this.store.get(ticketId);
    if (!t) return null;
    endTicket(t, { by, outcome, reason });
    this.slots.release(ticketId);
    this.store.put(t);
    return t;
  }

  /** 该不该发通知、发什么 */
  noticeFor(ticket) {
    const st = ticketStage(ticket);
    if (!shouldNotifyStage(st)) return null;
    const key = noticeKey(ticket.id, st.stage, st.action);
    if (!this.outbox.shouldSend(key)) return null;
    this.outbox.markSent(key);
    return { key, text: renderNotice(ticket) };
  }

  view(ticketId) {
    const t = this.store.get(ticketId);
    return t ? ticketView(t) : null;
  }

  list({ live = false } = {}) {
    return (live ? this.store.live() : this.store.all()).map(ticketView);
  }

  /** 还成不成立（人可能把人踢出白名单、或全局暂停） */
  stillAuthorized(ticket) {
    return revalidate(ticket?.mandate, this.policy);
  }
}
