/**
 * 工单仓库 —— 落盘 + 原子写 + 查询
 *
 * 为什么不用内存：run_task 的 task 对象活在进程里，重启即散。
 * dsh-superagent 的工单是 Store 里的持久实体，重启后还能接着报状态。
 * 我们的做法简单一层：整个 tickets.json 原子替换（临时文件 + rename），
 * 数据量小（几十个工单），不需要数据库。
 */

import fs from "node:fs";
import path from "node:path";

export class TicketStore {
  constructor(file) {
    this.file = file;
    this.tickets = new Map();
    this.lastError = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const t of arr) this.tickets.set(t.id, t);
    } catch (e) {
      if (e.code !== "ENOENT") this.lastError = e.message;
    }
    return this;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify([...this.tickets.values()], null, 0), "utf8");
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.lastError = e.message;
      return false;
    }
  }

  put(t) {
    this.tickets.set(t.id, t);
    this.save();
    return t;
  }

  get(id) {
    return this.tickets.get(id) ?? null;
  }

  all() {
    return [...this.tickets.values()];
  }

  live() {
    return this.all().filter((t) => !t.ended);
  }

  byThread(threadKey) {
    return this.all().filter((t) => t.threadKey === threadKey);
  }

  liveByThread(threadKey) {
    return this.byThread(threadKey).filter((t) => !t.ended);
  }

  /** 关掉太久以前的已结束工单，避免文件无限长 */
  pruneEnded(maxAgeMs = 7 * 24 * 3600 * 1000) {
    const cut = Date.now() - maxAgeMs;
    let n = 0;
    for (const [id, t] of this.tickets) {
      if (t.ended && Date.parse(t.ended.at) < cut) { this.tickets.delete(id); n++; }
    }
    if (n) this.save();
    return n;
  }
}
