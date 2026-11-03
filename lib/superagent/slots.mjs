/**
 * 工作槽位 —— 什么时候能开新 worker，什么时候排队
 *
 * 抄自 dsh-superagent 的 worker slot 机制（docs/003「Background work and worker slots」）：
 *   · 并发有上限，超出的排队，不硬塞
 *   · 一个工单在跑背景活时仍占着槽位，不算「等人」
 *   · 交接给人时立刻释放槽位
 *
 * 我们这边以前没有上限：连派五个 run_task 就五个子会话同时跑，
 * 内存、模型配额、磁盘全在抢，还不排队。现在统一走这里。
 */

export class SlotManager {
  constructor({ limit = 3 } = {}) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.holders = new Map();  // ticketId -> { slot, since }
    this.queue = [];           // [{ ticketId, run, enqueuedAt }]
    this.nextSlot = 1;
  }

  get busy() { return this.holders.size; }
  get queued() { return this.queue.length; }

  /** 立刻拿一个槽；满了返回 null */
  tryAcquire(ticketId) {
    if (this.holders.has(ticketId)) return this.holders.get(ticketId).slot;
    if (this.holders.size >= this.limit) return null;
    const slot = this.nextSlot++;
    this.holders.set(ticketId, { slot, since: Date.now() });
    return slot;
  }

  /** 排队，返回一个 promise：轮到它时 resolve 槽号 */
  enqueue(ticketId, run) {
    return new Promise((resolve) => {
      this.queue.push({ ticketId, run, resolve, enqueuedAt: Date.now() });
      this._drain();
    });
  }

  release(ticketId) {
    this.holders.delete(ticketId);
    this._drain();
    return this.holders.size;
  }

  _drain() {
    while (this.holders.size < this.limit && this.queue.length) {
      const item = this.queue.shift();
      const slot = this.nextSlot++;
      this.holders.set(item.ticketId, { slot, since: Date.now() });
      try { item.resolve(slot); } catch { /* 调用方自己负责 */ }
    }
  }

  /** 调试/面板用 */
  snapshot() {
    return {
      limit: this.limit,
      holders: [...this.holders.entries()].map(([id, v]) => ({ ticketId: id, slot: v.slot, heldMs: Date.now() - v.since })),
      queued: this.queue.map((q) => ({ ticketId: q.ticketId, waitedMs: Date.now() - q.enqueuedAt })),
    };
  }
}

/** 单次执行的时间上限：到点收活（对应 docs/003 的 30 分钟回合上限） */
export function withDeadline(promiseFactory, ms, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* 收活失败不影响返回值 */ }
      reject(new Error("超时"));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promiseFactory(), deadline]).finally(() => clearTimeout(timer));
}
