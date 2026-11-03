/**
 * restart-resume 单测 —— 重启后自动接续
 *
 * 覆盖：会话文件名解析、尾部「未完成回合」判定、时间窗过滤、子任务 pending 生命周期。
 * 这些都是「重启后能不能自己接上」的关键判断，写死行为防止回归。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseSessionName,
  tailInterrupted,
  findInterrupted,
  findLastActive,
  markPendingSub,
  clearPendingSub,
  loadPendingSubs,
  pendingFilePath,
  pickNotifyOptions,
} from "../lib/restart-resume.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rr-"));
}

function writeSession(dir, name, entries) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return f;
}

const userMsg = { message: { role: "user", content: [{ type: "text", text: "干活" }] } };
const assistantToolCall = { message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] } };
const toolResult = { message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } };
const assistantFinal = { message: { role: "assistant", content: [{ type: "text", text: "做完了" }] } };

test("parseSessionName：私聊与群聊都能还原 chatKey/userId", () => {
  assert.deepEqual(parseSessionName("private_3573297011.jsonl"), {
    chatKey: "private:3573297011",
    userId: "3573297011",
  });
  assert.deepEqual(parseSessionName("group_798322315_3573297011.jsonl"), {
    chatKey: "group:798322315",
    userId: "3573297011",
  });
  assert.equal(parseSessionName("subagent-abc.jsonl"), null);
  assert.equal(parseSessionName("随便.jsonl"), null);
});

test("tailInterrupted：工具未返回 / 模型被打断 / 用户未被回复 都算未完成", () => {
  const d = tmpdir();
  const a = writeSession(d, "a.jsonl", [userMsg, assistantToolCall]);
  const b = writeSession(d, "b.jsonl", [userMsg, assistantToolCall, toolResult]);
  const c = writeSession(d, "c.jsonl", [userMsg]);
  assert.equal(tailInterrupted(a)?.reason, "工具调用未返回");
  assert.equal(tailInterrupted(b)?.reason, "模型续写被打断");
  assert.equal(tailInterrupted(c)?.reason, "用户消息未被 reply");
});

test("tailInterrupted：回合已收尾（最后是纯文本 assistant）返回 null", () => {
  const d = tmpdir();
  const f = writeSession(d, "done.jsonl", [userMsg, assistantToolCall, toolResult, assistantFinal]);
  assert.equal(tailInterrupted(f), null);
});

test("tailInterrupted：空文件 / 坏行 不抛异常", () => {
  const d = tmpdir();
  const empty = path.join(d, "empty.jsonl");
  fs.writeFileSync(empty, "");
  assert.equal(tailInterrupted(empty), null);
  const bad = path.join(d, "bad.jsonl");
  fs.writeFileSync(bad, "{not json\n");
  assert.equal(tailInterrupted(bad), null);
});

test("findInterrupted：只挑时间窗内的未完成会话，跳过子代理临时文件", () => {
  const d = tmpdir();
  const now = Date.now();
  writeSession(d, "private_111.jsonl", [userMsg, assistantToolCall]);       // 未完成、新 → 命中
  writeSession(d, "private_222.jsonl", [userMsg, assistantFinal]);          // 已完成 → 不命中
  writeSession(d, "subagent-xyz.jsonl", [userMsg, assistantToolCall]);      // 子代理 → 跳过
  const old = writeSession(d, "private_333.jsonl", [userMsg, assistantToolCall]);
  const past = (now - 3600_000) / 1000;
  fs.utimesSync(old, past, past);                                            // 旧 → 窗口外

  const hits = findInterrupted(d, 10 * 60 * 1000);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chatKey, "private:111");
  assert.equal(hits[0].reason, "工具调用未返回");
});

test("pending 子任务：登记 → 读回 → 销账", () => {
  const d = tmpdir();
  assert.deepEqual(loadPendingSubs(d), {});
  markPendingSub(d, { taskId: "sub_1", chatKey: "private:111", userId: "111", snippet: "跑扫描" });
  markPendingSub(d, { taskId: "sub_2", chatKey: "private:111", userId: "111" });
  const all = loadPendingSubs(d);
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all.sub_1.snippet, "跑扫描");
  assert.ok(all.sub_1.ts > 0);

  clearPendingSub(d, "sub_1");
  const after = loadPendingSubs(d);
  assert.deepEqual(Object.keys(after), ["sub_2"]);

  // 销账不存在的 id 不应出错、也不该写坏文件
  clearPendingSub(d, "不存在");
  assert.deepEqual(Object.keys(loadPendingSubs(d)), ["sub_2"]);
});

test("pending 文件损坏时按空处理（不能让启动流程炸掉）", () => {
  const d = tmpdir();
  fs.writeFileSync(pendingFilePath(d), "{{{ 不是 JSON");
  assert.deepEqual(loadPendingSubs(d), {});
});

test("findLastActive：回合已收尾也要能选出来（重启后仍应恢复对话）", () => {
  const d = tmpdir();
  // 这是一个「已收尾」的会话：最后是纯文本 assistant
  writeSession(d, "private_111.jsonl", [userMsg, assistantFinal]);
  const last = findLastActive(d, 10 * 60 * 1000);
  assert.ok(last, "应当选出最新活动会话来接续对话");
  assert.equal(last.chatKey, "private:111");
  assert.equal(last.tail, null, "已收尾的回合 tail 应为 null");
});

test("findLastActive：选最新的那个，且尊重时间窗", () => {
  const d = tmpdir();
  const newer = writeSession(d, "private_222.jsonl", [userMsg, assistantFinal]);
  const older = writeSession(d, "private_111.jsonl", [userMsg, assistantFinal]);
  fs.utimesSync(older, (Date.now() - 3000) / 1000, (Date.now() - 3000) / 1000);
  const last = findLastActive(d, 10 * 60 * 1000);
  assert.equal(last.name, "private_222.jsonl");

  // 窗口收紧到 1 秒，222 也过期后应返回 null（旧的那个更早）
  const none = findLastActive(d, 1);
  assert.equal(none, null);
});

test("findLastActive：跳过子代理临时文件与空会话", () => {
  const d = tmpdir();
  writeSession(d, "subagent-abc.jsonl", [userMsg, assistantFinal]);
  fs.writeFileSync(path.join(d, "private_999.jsonl"), "");
  assert.equal(findLastActive(d, 10 * 60 * 1000), null);
});

// ===== 叫醒姿势（本次全案的关键）=====
// SDK 里 deliverAs==="nextTurn" 会直接入队并 return，triggerTurn 根本不会被求值，
// 效果就是「通知躺着不动，等用户下一条消息才顺带投递」。
// 这组断言把「空闲绝不能带 deliverAs」钉死。
test("pickNotifyOptions：空闲时只给 triggerTurn，绝不带 deliverAs", () => {
  const o = pickNotifyOptions(false);
  assert.deepEqual(o, { triggerTurn: true });
  assert.equal("deliverAs" in o, false, "带 deliverAs=nextTurn 会导致消息只入队、永不唤醒");
});

test("pickNotifyOptions：流式中用 steer 注入当前回合", () => {
  assert.deepEqual(pickNotifyOptions(true), { deliverAs: "steer", triggerTurn: true });
});
