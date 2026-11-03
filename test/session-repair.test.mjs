import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findOrphanToolResults,
  repairEntries,
  repairSessionFile,
  isOrphanToolResultError,
} from "../lib/agent/session-repair.mjs";

// ---------- 构造器 ----------

const asst = (id, parentId, toolIds = []) => ({
  type: "message",
  id,
  parentId,
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "…" },
      ...toolIds.map((t) => ({ type: "toolCall", id: t, name: "x", arguments: {} })),
    ],
  },
});

const tool = (id, parentId, callId, name = "set_reminder") => ({
  type: "message",
  id,
  parentId,
  message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }] },
});

const user = (id, parentId) => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
});

// ---------- 检测 ----------

test("findOrphanToolResults：正常配对不报", () => {
  const entries = [user("u1", null), asst("a1", "u1", ["c1"]), tool("t1", "a1", "c1")];
  assert.deepEqual(findOrphanToolResults(entries), []);
});

test("findOrphanToolResults：结果排在调用前面 → 孤儿（真实事故形态）", () => {
  // 复刻 2026-10-22 现场：toolResult 的 callId 与它前面那条 assistant 的 toolCall 对不上
  const entries = [
    user("u1", null),
    tool("t1", "u1", "call_14c2a48e"),      // ← 调用记录丢了，结果还在
    asst("a1", "t1", ["call_379c8341"]),
  ];
  assert.deepEqual(findOrphanToolResults(entries), [1]);
});

test("findOrphanToolResults：一个 assistant 有多个调用，结果逐个消费", () => {
  const entries = [
    user("u1", null),
    asst("a1", "u1", ["c1", "c2"]),
    tool("t1", "a1", "c1"),
    tool("t2", "t1", "c2"),
  ];
  assert.deepEqual(findOrphanToolResults(entries), []);
});

test("findOrphanToolResults：同一个 callId 出现两次，第二次算孤儿", () => {
  const entries = [
    user("u1", null),
    asst("a1", "u1", ["c1"]),
    tool("t1", "a1", "c1"),
    tool("t2", "t1", "c1"),
  ];
  assert.deepEqual(findOrphanToolResults(entries), [3]);
});

test("findOrphanToolResults：非 message 条目跳过（compaction/custom 等）", () => {
  const entries = [
    { type: "custom", id: "c0", parentId: null, data: {} },
    user("u1", "c0"),
    asst("a1", "u1", ["c1"]),
    tool("t1", "a1", "c1"),
  ];
  assert.deepEqual(findOrphanToolResults(entries), []);
});

// ---------- 修复 ----------

test("repairEntries：删掉孤儿，并把子节点接到祖父节点（不能断链）", () => {
  const entries = [
    user("u1", null),
    tool("t1", "u1", "call_lost"),   // 孤儿
    asst("a1", "t1", ["c1"]),        // 它挂在孤儿下面 → 必须改接到 u1
    tool("t2", "a1", "c1"),
  ];
  const { entries: out, removed } = repairEntries(entries);

  assert.equal(removed.length, 1);
  assert.equal(removed[0].toolCallId, "call_lost");
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.id), ["u1", "a1", "t2"]);
  assert.equal(out[1].parentId, "u1", "子节点的 parentId 必须接到祖父，否则子树断链");
  assert.equal(out[2].parentId, "a1");
});

test("repairEntries：连续多个孤儿，一路向上找活着的祖先", () => {
  const entries = [
    user("u1", null),
    tool("t1", "u1", "lost1"),
    tool("t2", "t1", "lost2"),
    asst("a1", "t2", ["c1"]),
  ];
  const { entries: out, removed } = repairEntries(entries);
  assert.equal(removed.length, 2);
  assert.deepEqual(out.map((e) => e.id), ["u1", "a1"]);
  assert.equal(out[1].parentId, "u1");
});

test("repairEntries：没有孤儿时原样返回同一引用（不做无谓拷贝）", () => {
  const entries = [user("u1", null), asst("a1", "u1", ["c1"]), tool("t1", "a1", "c1")];
  const { entries: out, removed } = repairEntries(entries);
  assert.equal(removed.length, 0);
  assert.equal(out, entries);
});

test("repairEntries：父节点已不在文件里时不动 parentId", () => {
  const entries = [tool("t1", "gone-from-file", "lost")];
  const { entries: out } = repairEntries(entries);
  assert.equal(out.length, 0, "孤儿本身要被删");
});

// ---------- 文件级 ----------

test("repairSessionFile：真实文件读改写，留备份，且其它行逐字节不变", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-repair-"));
  const file = path.join(dir, "x.jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: "s1", timestamp: 1 }),
    JSON.stringify(user("u1", "s1")),
    JSON.stringify(tool("t1", "u1", "call_lost")),
    JSON.stringify(asst("a1", "t1", ["c1"])),
    JSON.stringify(tool("t2", "a1", "c1")),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const r = repairSessionFile(file, { fs });
  assert.equal(r.ok, true);
  assert.equal(r.removed.length, 1);
  assert.ok(fs.existsSync(r.backup), "必须留备份");

  const after = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(after.map((e) => e.id), ["s1", "u1", "a1", "t2"]);
  assert.equal(after[2].parentId, "u1");
  // 未受影响的条目逐字节一致
  assert.equal(JSON.stringify(after[0]), lines[0]);
  assert.equal(JSON.stringify(after[1]), lines[1]);

  // 再跑一次应当幂等
  const r2 = repairSessionFile(file, { fs });
  assert.equal(r2.removed.length, 0);
});

test("repairSessionFile：文件不存在 → 正常返回，不炸", () => {
  const r = repairSessionFile("/tmp/definitely-not-here-xyz.jsonl", { fs });
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed, []);
});

test("repairSessionFile：坏行原样保留（不能因为一行坏数据清掉整段历史）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-repair-"));
  const file = path.join(dir, "y.jsonl");
  const good = JSON.stringify(user("u1", null));
  const orphan = JSON.stringify(tool("t1", "u1", "lost"));
  fs.writeFileSync(file, [good, "{broken json", orphan].join("\n") + "\n");

  const r = repairSessionFile(file, { fs });
  assert.equal(r.removed.length, 1);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.includes("{broken json"), "坏行必须原样保留");
  assert.ok(!after.includes('"t1"'));
});

// ---------- 错误判据 ----------

test("isOrphanToolResultError：认得真实 400 文案", () => {
  const real =
    '400: {"message":"{\\"error\\":{\\"message\\":\\"Messages with role \'tool\' must be a response ' +
    'to a preceding message with \'tool_calls\' (request_id: 806cd069-3a95-4ebf-9362-b22642dead90)\\",' +
    '\\"type\\":\\"AI_APICallError\\"}}"';
  assert.equal(isOrphanToolResultError(real), true);
});

test("isOrphanToolResultError：别的错误不能误判", () => {
  assert.equal(isOrphanToolResultError("Request timed out."), false);
  assert.equal(isOrphanToolResultError(""), false);
  assert.equal(isOrphanToolResultError(null), false);
  assert.equal(isOrphanToolResultError("429 rate limit exceeded"), false);
  assert.equal(isOrphanToolResultError("context_length_exceeded"), false);
});
