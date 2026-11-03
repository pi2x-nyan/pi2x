/**
 * 通知出口 —— 单一通道 + 去重 + 按阶段说话
 *
 * dsh-superagent 的做法：所有对外的话都走 Outbox / notices，工人不直接对人群说话。
 * 好处是「说还是不说」集中在一处判，不散落在各个回调里。
 *
 * 我们这边的教训正好相反：以前子任务完成、主动回合、重启接续各自发消息，
 * 有的走 bridge.sendPrivateMsg，有的走 submit 的流式，最后没人说得清「一共发了几条」。
 */

import { ticketStage } from "./model.mjs";

/** 每条通知都带一个指纹，短时间内重复的只发一次 */
export function noticeKey(ticketId, stage, action) {
  return `${ticketId}:${stage}:${action ?? "-"}`;
}

export class Outbox {
  constructor({ ttlMs = 10 * 60 * 1000 } = {}) {
    this.sent = new Map();   // key -> at
    this.ttlMs = ttlMs;
  }

  /** 该不该发：同一工单同一阶段，10 分钟内只发一次 */
  shouldSend(key) {
    const at = this.sent.get(key);
    if (!at) return true;
    return Date.now() - at > this.ttlMs;
  }

  markSent(key) {
    this.sent.set(key, Date.now());
    if (this.sent.size > 500) {
      const cut = Date.now() - this.ttlMs;
      for (const [k, v] of this.sent) if (v < cut) this.sent.delete(k);
    }
  }
}

/**
 * 把工单当前状态渲染成一句人话。
 * 原则：人必须处理的（验收/回答/卡住/失败）说清楚要什么；在跑的只说一句，不刷屏。
 */
export function renderNotice(ticket, { prefix = "" } = {}) {
  const st = ticketStage(ticket);
  const a = ticket.assignments[ticket.assignments.length - 1];
  const report = a?.report;
  const head = prefix ? `${prefix} ` : "";
  if (st.stage === "ended") {
    const o = ticket.ended?.outcome ?? "ended";
    return `${head}【${ticket.title}】已结束（${o}）`;
  }
  if (st.stage === "person") {
    const map = {
      answer: "需要你回答",
      review: "结果就绪，等你验收",
      blocked: "被卡住了",
      failed: "失败了",
      delivery: "消息没送达",
    };
    const tail = report?.needs ?? ticket.attention?.question ?? "";
    return `${head}【${ticket.title}】${map[st.action] ?? "等人"}${tail ? `：${tail}` : ""}`;
  }
  if (st.action === "queued") return `${head}【${ticket.title}】排队中`;
  return `${head}【${ticket.title}】执行中`;
}

/** 只把这些阶段推给人：其余静默 */
export function shouldNotifyStage(st) {
  return st.stage === "person" || st.stage === "ended";
}
