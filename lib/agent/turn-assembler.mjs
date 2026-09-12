/**
 * TurnAssembler —— 同一会话内提交消息 + 组装回复
 *
 * 【为什么需要它】
 * 同一个人可能连续发几条消息。若严格串行处理，第二条要等第一条全部跑完，
 * 体验很差。这里让每条消息立即提交给 session（流式中 SDK 的 followUp 会排队），
 * 每条 submit 各自订阅增量事件、各自结算。
 *
 * 【2026-09 重构说明 —— 删掉了三段死代码】
 * 旧版维护了 `items`(FIFO 待完成队列) + `_grant()` + `_flushFallback()` + `pending` 缓冲，
 * 意图是「按 assistant entry 把回复逐条分配给对应消息」。但核对后确认：
 *   · `submit()` 从未把任何东西 push 进 `items` —— `_grant`/`_flushFallback` 永远找不到 item，
 *     是彻底的 no-op；
 *   · `cancelAll()` 遍历一个恒为空的数组 —— 除了 abort() 之外什么也没做；
 *   · `this.pending` 与 submit 内部的 `buf` 订阅的是同一批事件，内容重复。
 * 现改为：submit 内部自持一个 in-flight 记录（仅用于 /stop 快速结算），
 * 回复内容仍由 submit 的 `buf` 决定。行为对用户不变，但 /stop 现在能**立即**结算
 * 在途回复，不必再依赖 abort 之后 SDK 回调的时序。
 */
import { cosineSim } from "../text.mjs";
import { sentSince } from "./sent-log.mjs";
import { StreamFlusher } from "./stream-flusher.mjs";
import { config } from "../config.mjs";

/** 判定「工具已发内容」与「最终文本」是否算重复的相似度阈值 */
export const DUP_SIM_THRESHOLD = 0.45;

const noopLogger = { log() {}, error() {} };

export class TurnAssembler {
  constructor(session, { logger = console } = {}) {
    this.session = session;
    this.logger = logger;
    /** @type {Set<{done:boolean, resolve:Function}>} 在途提交（仅 /stop 用） */
    this.inflight = new Set();
    /** 最近一次提交的完整文本（供记忆收割等上层使用） */
    this.lastFullText = "";
  }

  /** 提取 assistant message 的文本（content 中的 text parts） */
  static msgText(msg) {
    const content = msg?.content ?? msg?.parts;
    if (Array.isArray(content)) {
      const t = content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
      return t || null;
    }
    return typeof content === "string" ? content : null;
  }

  /**
   * 提交一条消息，返回其回复的 Promise。
   *
   * 行为：
   *  - **增量即时发送**：opts.send 存在时，每个 text_delta 一到自然边界就发给用户；
   *  - **超时保护**：超时（默认 config.pi.submitTimeoutMs）→ abort 并结算已有内容，
   *    绝不永久挂住（否则该会话后续消息全被堵死）；
   *  - **监听器必释放**：settle 只执行一次，内部保证 unsub()；
   *  - 记 lastFullText 供上层（记忆收割等）使用（流式时返回值可能为空串）。
   */
  submit(text, images, opts = {}) {
    const t0 = Date.now(); // 本轮起点（去重日志按时间过滤）
    const self = this;
    const logger = opts.logger ?? this.logger ?? noopLogger;
    return new Promise((resolve) => {
      const promptOpts = { streamingBehavior: "followUp" };
      if (images?.length) promptOpts.images = images;
      const timeoutMs = Number(opts.timeoutMs ?? config.pi.submitTimeoutMs);
      let buf = "";
      let deltaCount = 0;
      let settled = false;

      // in-flight 记录：让 /stop 能立即结算这条在途消息
      // `cancel` 由下方在 timer/unsub 就绪后装上（/stop 路径用它清掉超时定时器，
      // 否则被中止的回合会留下一个悬空 10 分钟定时器，并在到期后误打「超时」日志）
      const item = {
        done: false,
        resolve: (v) => {
          if (item.done) return;
          item.done = true;
          resolve(v);
        },
        cancel: null,
      };
      this.inflight.add(item);
      const releaseItem = () => {
        item.done = true;
        self.inflight.delete(item);
      };

      // 增量流式发送器（可选）
      const flusher = opts.send
        ? new StreamFlusher({
            send: opts.send,
            minLen: Number(opts.flushMin ?? config.pi.streamFlushMin),
            maxLen: Number(opts.flushMax ?? config.pi.streamFlushMax),
            idleMs: Number(opts.flushIdleMs ?? config.pi.streamFlushIdleMs),
            log: (m) => logger.log(`[stream] ${m}`),
          })
        : null;

      const onDelta = (ev) => {
        if (ev.type === "message_update" && ev.assistantMessageEvent) {
          const e = ev.assistantMessageEvent;
          const kind = String(e.type ?? "");
          if (kind === "text_delta") {
            const d = String(e.delta ?? "");
            buf += d;
            deltaCount++;
            flusher?.feed(d);
          } else if (kind === "text_end" || kind.startsWith("toolcall")) {
            // 文本块结束 / 模型开始调用工具 → 立即把已积压的话发出去（不等回合结束）
            flusher?.flushNow();
          }
        }
      };
      const unsub = this.session.subscribe(onDelta);

      const settle = async ({ err = null, timedOut = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          unsub();
        } catch {
          /* ignore */
        }
        let fin = null;
        if (flusher) {
          try {
            fin = await flusher.end();
          } catch {
            fin = { sent: flusher.sent, aborted: flusher.aborted, failed: true };
          }
        }

        const bufText = buf.trim();
        self.lastFullText = bufText; // 供上层（记忆收割）使用
        const toolSent = self._sentByQqToolThisTurn();
        const streamedOk = !!(fin && fin.sent.length > 0 && !fin.aborted && !fin.failed);
        let out = bufText;
        let maxSim = 0;
        let dup = toolSent;
        if (streamedOk) {
          out = ""; // 已增量送达 → 不再整段重发
        } else if (toolSent && bufText) {
          const sentList = sentSince(t0);
          if (sentList.length) {
            maxSim = Math.max(...sentList.map((s) => cosineSim(s, bufText)));
            dup = maxSim >= DUP_SIM_THRESHOLD;
          }
          if (dup) out = "";
        }
        logger.log(
          `[dbg-submit] settle · deltaCount=${deltaCount} · buf=${bufText.length}字 · toolSent=${toolSent}` +
            ` · cos=${maxSim.toFixed(3)} · dup=${dup} · streamed=${fin ? fin.sent.length : 0}块` +
            `${fin?.aborted ? "(中止)" : ""}${fin?.failed ? "(发送失败)" : ""}` +
            `${timedOut ? " · ⏱超时" : ""}${err ? ` · err=${err.message}` : ""}`
        );
        self.inflight.delete(item);
        if (item.done) return; // 已被 /stop 结算过，不再覆盖

        // 超时且一个字都没送给用户时，必须说一声，不能沉默。
        // 否则用户只看到「没人理我」，无法区分「在处理」和「已经挂了」。
        if (timedOut && !out && !toolSent && !streamedOk) {
          return item.resolve("（这轮处理超时了，没能给出回复。可以换个说法再试，或稍后再问。）");
        }
        item.resolve(err ? (err?.message ? `（出错了，请稍后再试：${err.message}）` : "") : out || "");
      };

      const timer = setTimeout(async () => {
        logger.log(`[dbg-submit] ⏱ 超时(${timeoutMs}ms)，abort 并结算已有内容`);
        // ⚠ abort() 必须给一个上限，不能直接 await。
        // 上游卡死时 abort 本身也可能迟迟不返回（它要等流关闭）；若在此干等，
        // settle 永远不会执行 → Promise 永不 resolve → entry.tail 永不释放 →
        // **整个会话的所有后续消息全部被堵死**（真实事故：用户连发三条消息，一条都没被处理）。
        // 所以这里 race 一个短上限：abort 尽力而为，结算不能被它拖住。
        try {
          await Promise.race([this.session.abort(), new Promise((r) => setTimeout(r, 5000))]);
        } catch {
          /* ignore */
        }
        await settle({ timedOut: true });
      }, timeoutMs);

      // /stop 路径：立即清干净（定时器 / 订阅 / 在途记录）并结算
      item.cancel = (reason) => {
        if (item.done) return false;
        clearTimeout(timer);
        settled = true; // 接管结算，阻止后续 settle 再跑一遍
        try {
          unsub();
        } catch {
          /* ignore */
        }
        try {
          flusher?.end(); // 不 await：/stop 不应被发送链延滞
        } catch {
          /* ignore */
        }
        self.lastFullText = buf.trim();
        self.inflight.delete(item);
        item.resolve(reason);
        return true;
      };

      this.session
        .prompt(text, promptOpts)
        .then(() => settle())
        .catch((e) => settle({ err: e }))
        .finally(() => releaseItem());
    });
  }

  /** 判断本轮（最后一个 user 之后）是否成功调用了 qq_send_message 工具（避免最终文本重复发送） */
  _sentByQqToolThisTurn() {
    const msgs = this.session.agent?.state?.messages ?? [];
    if (!msgs.length) return false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role === "user") break; // 到达本轮输入起点，停止
      if (m?.role === "assistant") {
        const content = Array.isArray(m.content) ? m.content : [];
        const tc = content.find((c) => c?.type === "toolCall" && c?.name === "qq_send_message");
        if (tc) {
          // 找到对应 toolResult：成功（无 isError）才算真正已发送
          for (let j = i + 1; j < msgs.length; j++) {
            const r = msgs[j];
            if (r?.role === "toolResult" && (r?.toolCallId === tc.id || r?.toolCallId === undefined) && !r?.isError) return true;
          }
          return false; // 有调用但无成功结果 → 不吞（文本兜底）
        }
      }
    }
    return false;
  }

  /**
   * 显式中止（/stop）：立即结算所有在途消息为中止提示，再 abort agent 运行。
   * @returns {Promise<number>} 被结算的在途消息数
   */
  async cancelAll(reason = "（已中止）") {
    let n = 0;
    for (const item of [...this.inflight]) {
      if (item.done) {
        this.inflight.delete(item);
        continue;
      }
      if (typeof item.cancel === "function") {
        if (item.cancel(reason)) n++;
      } else {
        n++;
        item.resolve(reason);
        this.inflight.delete(item);
      }
    }
    await this.session.abort().catch(() => {});
    return n;
  }
}

export default TurnAssembler;
