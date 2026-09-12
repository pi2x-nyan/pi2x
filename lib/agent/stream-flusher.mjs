/**
 * StreamFlusher —— 增量流式发送器
 *
 * 把 text_delta 按自然边界（空行分段 > 超长硬切）切块**立即**发给用户，
 * 不再攒到回合结束才发。这样长回复会像打字一样逐段到达，而不是憋到最后。
 *
 * 保护机制：
 *  - 顺序保证：内部 Promise 链串行发送，不会乱序；
 *  - 泄露防护：待发块命中工具调用 XML 文本则中止流式（交上层用整段文本校正重试）；
 *  - 失败降级：发送异常置 failed，上层改用整段文本兜底；
 *  - 空闲强制冲刷：长时间无新增且仍有缓冲 → 发出去（默认关闭，避免把一句话从中间截断）。
 */
import { detectToolLeak } from "../text.mjs";

export class StreamFlusher {
  constructor({ send, minLen = 80, maxLen = 500, idleMs = 0, log = () => {}, leakDetector = detectToolLeak } = {}) {
    this.send = send;
    this.minLen = Math.max(8, minLen);
    this.maxLen = Math.max(this.minLen, maxLen);
    this.idleMs = Math.max(0, idleMs); // 0 = 关闭空闲强制冲刷
    this.log = log;
    this.leakDetector = leakDetector;
    this.buf = "";
    this.sent = [];
    this.aborted = false;
    this.failed = false;
    this._timer = null;
    this._chain = Promise.resolve();
  }

  feed(delta) {
    if (this.aborted) return;
    this.buf += String(delta ?? "");
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._drain(false);
    if (this.buf && !this.aborted) this._armIdle();
  }

  /** 立即发出全部待发内容（用于 text_end / 工具调用开始等**确定性边界**）
   *  场景：模型先说一句话 → 再调工具；这句话应在工具调用开始前就到达用户。 */
  flushNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this.aborted) this._drain(true);
  }

  _armIdle() {
    if (!this.idleMs) return; // 默认关闭：只在空行分段 / 超长硬切 / 回合结束时发送
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._drain(true);
    }, this.idleMs);
    this._timer.unref?.();
  }

  /**
   * 切分点：**只用空行断段（\n\n）**。句子结束标点（。！？!?；; 等）与单换行**不作为切分点**，
   * 以免把一段话拆碎。无空行时仅当累积超过 maxLen 才强制切。
   */
  _cut() {
    const s = this.buf;
    const para = s.lastIndexOf("\n\n");
    if (para >= 0) return para + 2;
    return -1;
  }

  _drain(force) {
    while (!this.aborted) {
      let cut = this._cut();
      if (cut <= 0) {
        if (!force) {
          if (this.buf.length >= this.maxLen) cut = this.maxLen;
          else break;
        } else {
          if (!this.buf) break;
          cut = Math.min(this.buf.length, this.maxLen);
        }
      }
      const unit = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut);
      this._emit(unit);
      if (!force && this.buf.length < this.minLen) break;
    }
  }

  _emit(unit) {
    const text = String(unit ?? "").trim();
    if (!text) return;
    if (this.leakDetector(text)) {
      this.aborted = true;
      this.log("待发内容命中工具调用 XML 文本，停止流式（交上层重试）");
      return;
    }
    this.sent.push(text);
    this._chain = this._chain.then(async () => {
      try {
        await this.send(text);
      } catch (e) {
        this.failed = true;
        this.log(`发送失败: ${e?.message ?? e}`);
      }
    });
  }

  /** 收尾：强制冲刷剩余缓冲并等发送链跑完 */
  async end() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this.aborted) this._drain(true);
    if (this.buf && !this.aborted) {
      // _drain 在中止后可能留下尾巴，这里兜底清空避免下轮串味
      this.buf = "";
    }
    try {
      await this._chain;
    } catch {
      /* 已在 _emit 内消化 */
    }
    return { sent: this.sent, aborted: this.aborted, failed: this.failed };
  }
}

export default StreamFlusher;
