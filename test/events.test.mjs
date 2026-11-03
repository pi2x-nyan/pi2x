/**
 * 事件队列的回归测试
 *
 * 这里锁的是三条不变量：
 *   1. 同 key 的事件只留最新（同一个网页变十次只说一次）
 *   2. 过期事件不再触发（重启后别把三天前的旧事当新闻）
 *   3. 监视基线：首次见到的文件/网页只记基线，不产生事件
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 每个用例用独立的 state 目录，避免污染真实队列
async function freshModule(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi2x-ev-${tag}-`));
  process.env.PI2X_EVENTS_FILE = path.join(dir, "events.json");
  process.env.PI2X_WATCH_FILE = path.join(dir, "watch.json");
  const m = await import("../lib/events.mjs");
  return { m, dir };
}

test("push/load：入队后能读到，未消费", async () => {
  const { m } = await freshModule("basic");
  m.pushEvent({ type: "test", key: "k1", text: "hello" });
  const list = m.loadEvents();
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "hello");
});

test("同 key 覆盖：只留最新一条", async () => {
  const { m } = await freshModule("dedupe");
  m.pushEvent({ type: "url", key: "url:x", text: "旧" });
  m.pushEvent({ type: "url", key: "url:x", text: "新" });
  const list = m.loadEvents();
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "新");
});

test("markConsumed 之后不再出现在待消费列表", async () => {
  const { m } = await freshModule("consume");
  const k = m.pushEvent({ type: "test", key: "k2", text: "bye" });
  m.markConsumed([k]);
  assert.equal(m.loadEvents().length, 0);
});

test("过期事件被清理", async () => {
  const { m } = await freshModule("ttl");
  m.pushEvent({ type: "test", key: "k3", text: "old", ttlMs: 1000, now: Date.now() - 5000 });
  assert.equal(m.loadEvents().length, 0);
});

test("文件监视：首见只记基线，不产生事件；变更才产生", async () => {
  const { m, dir } = await freshModule("file");
  const f = path.join(dir, "watched.txt");
  fs.writeFileSync(f, "v1");
  m.saveWatch({ files: [f], urls: [] });
  assert.equal(m.checkFiles({ files: [f] }).length, 0);   // 基线
  fs.writeFileSync(f, "v2 changed");
  const ev = m.checkFiles({ files: [f] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "file");
});
