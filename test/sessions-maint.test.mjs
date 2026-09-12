import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planSlim, parseLines, isStaleName, isEphemeralName, sweepOrphans, survey, slimFile, archiveStale } from "../lib/sessions-maint.mjs";

/** 造一个会话文件内容：session 头 + N 条消息，可选在中间插一条 compaction */
function buildSession({ prefixMsgs = 5, keptMsgs = 3, suffixMsgs = 2, withCompaction = true } = {}) {
  const lines = [];
  lines.push(JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" }));
  let prev = null;
  const mk = (id, text) =>
    JSON.stringify({ type: "message", id, parentId: prev, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text } });

  const ids = {};
  for (let i = 0; i < prefixMsgs; i++) {
    const id = `p${i}`;
    ids[id] = true;
    lines.push(mk(id, "x".repeat(100)));
    prev = id;
  }
  if (!withCompaction) {
    for (let i = 0; i < suffixMsgs; i++) {
      const id = `s${i}`;
      lines.push(mk(id, "y".repeat(100)));
      prev = id;
    }
    return lines.join("\n") + "\n";
  }
  const kept = [];
  for (let i = 0; i < keptMsgs; i++) {
    const id = `k${i}`;
    kept.push(id);
    lines.push(mk(id, "y".repeat(100)));
    prev = id;
  }
  // compaction 条目：parentId 指向最后一条，firstKeptEntryId 指向 kept[0]
  const cid = "c0";
  lines.push(
    JSON.stringify({
      type: "compaction",
      id: cid,
      parentId: prev,
      timestamp: "2026-01-01T00:00:01.000Z",
      summary: "历史摘要",
      firstKeptEntryId: kept[0],
      tokensBefore: 12345,
    })
  );
  prev = cid;
  for (let i = 0; i < suffixMsgs; i++) {
    const id = `a${i}`;
    lines.push(mk(id, "z".repeat(100)));
    prev = id;
  }
  return lines.join("\n") + "\n";
}

test("parseLines：坏行保留占位不炸", () => {
  const r = parseLines('{"a":1}\n坏行\n\n{"b":2}');
  assert.equal(r.length, 3);
  assert.deepEqual(r[0].obj, { a: 1 });
  assert.equal(r[1].obj, null);
  assert.equal(r[1].raw, "坏行");
  assert.deepEqual(r[2].obj, { b: 2 });
});

test("isStaleName：识别测试/调试残留，不误伤正常会话", () => {
  assert.ok(isStaleName("repro_open.jsonl"));
  assert.ok(isStaleName("test-chat.jsonl"));
  assert.ok(isStaleName("ltest.jsonl"));
  assert.ok(isStaleName("cacheTest.jsonl"));
  assert.ok(isStaleName("dbg.jsonl"));
  assert.ok(isStaleName("sim.jsonl"));
  assert.ok(isStaleName("sim2.jsonl"));
  assert.ok(isStaleName("2026-09-02T05-40-56-461Z_01a060a2.jsonl"));
  // 正常会话名不能被误判
  assert.ok(!isStaleName("private_1000000001.jsonl"));
  assert.ok(!isStaleName("group_1077971815.jsonl"));
  assert.ok(!isStaleName("group_1051684964_3101519302.jsonl"));
  assert.ok(!isStaleName("subagent-1788435903946-gq960.jsonl"));
});

test("planSlim：无压缩条目时不丢弃任何东西", () => {
  const text = buildSession({ withCompaction: false });
  const p = planSlim(text);
  assert.equal(p.savedEntries, 0);
  assert.match(p.reason, /无压缩条目/);
  assert.equal(Buffer.byteLength(p.keepLines.join("\n") + "\n", "utf8"), p.before);
});

test("planSlim：丢弃 firstKeptEntryId 之前的条目，保留压缩条目与其后的全部", () => {
  const text = buildSession({ prefixMsgs: 5, keptMsgs: 3, suffixMsgs: 2 });
  const p = planSlim(text);
  const ids = p.keepLines.map((l) => JSON.parse(l).id);
  assert.equal(ids[0], "s1", "session 头必须在最前");
  assert.ok(ids.includes("k0"), "firstKeptEntryId 必须保留");
  assert.ok(ids.includes("c0"), "压缩条目本身必须保留（模型靠它理解历史）");
  assert.ok(ids.includes("a0") && ids.includes("a1"), "压缩之后的条目必须保留");
  for (const gone of ["p0", "p1", "p2", "p3", "p4"]) assert.ok(!ids.includes(gone), `${gone} 应被丢弃`);
  assert.equal(p.savedEntries, 5);
  assert.ok(p.after < p.before, "应真的变小");
});

test("planSlim：首条保留项的 parentId 置空（原指向被丢弃的上一条）", () => {
  const text = buildSession({ prefixMsgs: 5, keptMsgs: 3, suffixMsgs: 2 });
  const p = planSlim(text);
  const first = JSON.parse(p.keepLines[1]); // [0] 是 session 头
  assert.equal(first.id, "k0");
  assert.equal(first.parentId, null, "必须断开悬空引用");
});

test("planSlim：firstKeptEntryId 位于压缩条目之前也能正确处理（压缩点回退）", () => {
  // 构造：kept 条目在 compaction 之前（真实数据就是这样，压缩点会回退若干条）
  const lines = [JSON.stringify({ type: "session", id: "s1" })];
  let prev = null;
  for (let i = 0; i < 4; i++) {
    lines.push(JSON.stringify({ type: "message", id: `old${i}`, parentId: prev, message: { role: "user" } }));
    prev = `old${i}`;
  }
  // 先写 kept 三条
  for (let i = 0; i < 3; i++) {
    lines.push(JSON.stringify({ type: "message", id: `keep${i}`, parentId: prev, message: { role: "user" } }));
    prev = `keep${i}`;
  }
  // 再写 compaction，firstKeptEntryId 指向更早的 keep0
  lines.push(JSON.stringify({ type: "compaction", id: "c0", parentId: prev, summary: "s", firstKeptEntryId: "keep0", tokensBefore: 1 }));
  prev = "c0";
  lines.push(JSON.stringify({ type: "message", id: "after0", parentId: prev, message: { role: "assistant" } }));
  const p = planSlim(lines.join("\n") + "\n");
  const ids = p.keepLines.map((l) => JSON.parse(l).id);
  assert.ok(!ids.includes("old0") && !ids.includes("old3"), "压缩点之前的历史应被丢弃");
  assert.ok(ids.includes("keep0") && ids.includes("c0") && ids.includes("after0"));
  assert.equal(JSON.parse(p.keepLines[1]).id, "keep0", "起点应取 firstKeptEntryId");
  assert.equal(JSON.parse(p.keepLines[1]).parentId, null);
});

test("planSlim：firstKeptEntryId 指向不存在的 id → 保守只从压缩条目开始", () => {
  const lines = [
    JSON.stringify({ type: "session", id: "s1" }),
    JSON.stringify({ type: "message", id: "m0", parentId: null, message: {} }),
    JSON.stringify({ type: "compaction", id: "c0", parentId: "m0", summary: "s", firstKeptEntryId: "不存在", tokensBefore: 1 }),
    JSON.stringify({ type: "message", id: "m1", parentId: "c0", message: {} }),
  ];
  const p = planSlim(lines.join("\n") + "\n");
  const ids = p.keepLines.map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, ["s1", "c0", "m1"]);
});

test("slimFile：空闲不足则跳过（保护正在会话中的文件）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const f = path.join(dir, "a.jsonl");
  fs.writeFileSync(f, buildSession());
  const r = slimFile(f, { minIdleMs: 60_000, now: Date.now() });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /正在会话中/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("slimFile：dry-run 不改文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const f = path.join(dir, "a.jsonl");
  const text = buildSession();
  fs.writeFileSync(f, text);
  const r = slimFile(f, { dryRun: true, minIdleMs: 0 });
  assert.equal(r.dryRun, true);
  assert.equal(fs.readFileSync(f, "utf8"), text, "文件内容不该变");
  assert.ok(!fs.existsSync(path.join(dir, ".backup")), "dry-run 不该建备份目录");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("slimFile：真瘦身会备份原文件，且内容是原样", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const f = path.join(dir, "a.jsonl");
  const text = buildSession();
  fs.writeFileSync(f, text);
  const r = slimFile(f, { minIdleMs: 0 });
  assert.ok(r.after < r.before);
  const newText = fs.readFileSync(f, "utf8");
  assert.ok(Buffer.byteLength(newText, "utf8") === r.after);
  const bdir = path.join(dir, ".backup");
  const baks = fs.readdirSync(bdir);
  assert.equal(baks.length, 1);
  assert.equal(fs.readFileSync(path.join(bdir, baks[0]), "utf8"), text, "备份必须与原文件逐字节一致");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("slimFile：已是最简时跳过，不产生备份", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const f = path.join(dir, "a.jsonl");
  const original = buildSession();
  fs.writeFileSync(f, original);
  const r1 = slimFile(f, { minIdleMs: 0 }); // 第一次瘦身
  const text1 = fs.readFileSync(f, "utf8");
  const r2 = slimFile(f, { minIdleMs: 0 }); // 再来一次
  const text2 = fs.readFileSync(f, "utf8");
  assert.equal(
    r2.skipped,
    true,
    `第二次应跳过。\n原始 ${Buffer.byteLength(original)} 字节\n` +
      `第一次: ${JSON.stringify(r1)}\n第一次后 ${Buffer.byteLength(text1)} 字节\n` +
      `第二次: ${JSON.stringify(r2)}\n第二次后 ${Buffer.byteLength(text2)} 字节\n` +
      `两次产物是否一致: ${text1 === text2}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("survey：统计总量并挑出陈旧文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  fs.writeFileSync(path.join(dir, "private_1.jsonl"), "x".repeat(1000));
  fs.writeFileSync(path.join(dir, "dbg.jsonl"), "y".repeat(500));
  fs.writeFileSync(path.join(dir, "notes.txt"), "should be ignored");
  const s = survey(dir, { staleBeforeMs: 0, now: Date.now() + 1000 });
  assert.equal(s.files.length, 2, "只统计 .jsonl");
  assert.equal(s.totalBytes, 1500);
  assert.equal(s.stale.length, 1);
  assert.equal(s.stale[0].name, "dbg.jsonl");
  assert.equal(s.staleBytes, 500);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archiveStale：移动到 .archive 且 dry-run 不动手", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const f = path.join(dir, "dbg.jsonl");
  fs.writeFileSync(f, "z");
  const rows = [{ name: "dbg.jsonl", path: f, bytes: 1 }];
  archiveStale(dir, rows, { dryRun: true });
  assert.ok(fs.existsSync(f), "dry-run 不该移动");
  archiveStale(dir, rows, {});
  assert.ok(!fs.existsSync(f));
  assert.ok(fs.existsSync(path.join(dir, ".archive", "dbg.jsonl")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("瘦身不改变模型可见上下文（保留项集合与顺序）", () => {
  const text = buildSession({ prefixMsgs: 6, keptMsgs: 2, suffixMsgs: 3 });
  const p = planSlim(text);
  const ids = p.keepLines.map((l) => JSON.parse(l).id);
  // 期望：session 头 + keep0,keep1,c0,a0,a1,a2（严格按原文件顺序）
  assert.deepEqual(ids, ["s1", "k0", "k1", "c0", "a0", "a1", "a2"]);
});

test("isEphemeralName：只认子代理一次性文件，不误伤正式会话", () => {
  assert.ok(isEphemeralName("subagent-1788435903946-gq960.jsonl"));
  assert.ok(isEphemeralName("subagent-1789054494000-abc12.jsonl"));
  assert.ok(isEphemeralName("subtask-1789054494000-x1.jsonl"));
  assert.ok(!isEphemeralName("private_1000000001.jsonl"));
  assert.ok(!isEphemeralName("group_1077971815.jsonl"));
  assert.ok(!isEphemeralName("subagent.jsonl"), "缺时间戳/随机段的不算");
});

test("sweepOrphans：清掉子代理孤儿，保留正式会话", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  fs.writeFileSync(path.join(dir, "subagent-1788435903946-gq960.jsonl"), "x".repeat(2048));
  fs.writeFileSync(path.join(dir, "subtask-1789054494000-x1.jsonl"), "y".repeat(1024));
  fs.writeFileSync(path.join(dir, "private_1.jsonl"), "keep-me");
  fs.writeFileSync(path.join(dir, "group_2.jsonl"), "keep-me-too");
  const r = sweepOrphans(dir);
  assert.equal(r.removed.length, 2);
  assert.equal(r.freed, 3072);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ["group_2.jsonl", "private_1.jsonl"], "正式会话必须原样保留");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepOrphans：dryRun 只报告不删", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  const f = path.join(dir, "subagent-1-a.jsonl");
  fs.writeFileSync(f, "z".repeat(100));
  const r = sweepOrphans(dir, { dryRun: true });
  assert.equal(r.removed.length, 1);
  assert.equal(r.freed, 100);
  assert.ok(fs.existsSync(f), "dry-run 不该删文件");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepOrphans：minAgeMs 给新建文件留余地", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  const f = path.join(dir, "subagent-1-a.jsonl");
  fs.writeFileSync(f, "z");
  const r = sweepOrphans(dir, { minAgeMs: 60_000, now: Date.now() });
  assert.equal(r.removed.length, 0, "刚写入的不该被当孤儿清掉");
  assert.ok(fs.existsSync(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepOrphans：目录不存在时不抛异常", () => {
  const r = sweepOrphans("/nonexistent/dir/xyz");
  assert.deepEqual(r, { removed: [], freed: 0 });
});

test("回归：mtime 有一丝丝在未来时，minIdleMs=0 也必须执行瘦身", () => {
  // 曾经的 flaky 根因：文件系统 mtime 是浮点数（如 ...972.005），Date.now() 是整数毫秒，
  // 两者落在同一毫秒时 now-mtime 为负 → 刚写完的文件被误判为「正在会话中」而跳过。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const f = path.join(dir, "a.jsonl");
  fs.writeFileSync(f, buildSession());
  const futureNow = fs.statSync(f).mtimeMs - 5; // 故意让「现在」早于 mtime
  const r = slimFile(f, { minIdleMs: 0, now: futureNow });
  assert.equal(r.skipped, undefined, "不该被跳过");
  assert.ok(r.after < r.before, "应真的完成瘦身");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mtime 在未来 + minIdleMs>0 → 仍应保守跳过（保护刚写入的文件）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const f = path.join(dir, "a.jsonl");
  fs.writeFileSync(f, buildSession());
  const past = fs.statSync(f).mtimeMs - 60000;
  const r = slimFile(f, { minIdleMs: 300_000, now: past });
  assert.equal(r.skipped, true, "空闲时长按 0 算，仍小于 5 分钟，应跳过");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("正常空闲超过阈值 → 不跳过", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const f = path.join(dir, "a.jsonl");
  fs.writeFileSync(f, buildSession());
  const later = Date.now() + 10 * 60_000;
  const r = slimFile(f, { minIdleMs: 300_000, now: later });
  assert.equal(r.skipped, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
