/**
 * 系统消息留痕队列的回归测试
 *
 * 锁三条：同内容短时间去重、drain 之后队列清空、落地失败能 requeue 回去。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi2x-notes-${tag}-`));
  process.env.PI2X_NOTES_FILE = path.join(dir, "notes.json");
  const m = await import("../lib/notes.mjs");
  return m;
}

test("入队后可读，字段完整", async () => {
  const m = await fresh("basic");
  m.enqueueNote({ chat: "private", target: "123", text: "12:30 排练" });
  const list = m.loadNotes();
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "12:30 排练");
  assert.equal(list[0].kind, "reminder");
});

test("同内容 10 分钟内重复入队只留一条", async () => {
  const m = await fresh("dedupe");
  const a = m.enqueueNote({ chat: "private", target: "123", text: "同一句" });
  const b = m.enqueueNote({ chat: "private", target: "123", text: "同一句" });
  assert.equal(a, b);
  assert.equal(m.loadNotes().length, 1);
});

test("超过 10 分钟视为新的一条", async () => {
  const m = await fresh("ttl");
  const t0 = Date.now() - 20 * 60000;
  m.enqueueNote({ chat: "private", target: "123", text: "同一句", now: t0 });
  m.enqueueNote({ chat: "private", target: "123", text: "同一句" });
  assert.equal(m.loadNotes().length, 2);
});

test("drain 后队列为空，且把内容交回", async () => {
  const m = await fresh("drain");
  m.enqueueNote({ chat: "private", target: "123", text: "A" });
  const got = m.drainNotes();
  assert.equal(got.length, 1);
  assert.equal(m.loadNotes().length, 0);
});

test("requeue 能把失败的放回队列", async () => {
  const m = await fresh("requeue");
  m.enqueueNote({ chat: "private", target: "123", text: "B" });
  const got = m.drainNotes();
  m.requeueNotes(got);
  assert.equal(m.loadNotes().length, 1);
});
