/**
 * 临时块注入位置与「不落盘」的回归测试。
 *
 * 【被锁定的设计决策】（每一条都有实测依据，改动前请先看 lib/piagent.mjs 里的长注释）
 *
 * 1) 每请求临时块（权限白名单 / 风险研判 / 记忆）挂在**报文最后一条消息的末尾**，
 *    不放 system prompt。
 *    理由：前缀缓存是「从第 0 个 token 起的最长公共前缀」，system 里任何位置一变，
 *    分叉点之后全部作废。而记忆检索结果每轮都在变 → 放 system 末尾等于每轮清空
 *    整段历史缓存。
 *      实测：同一 system + 历史，动态块在 system 末尾命中 29%；挂消息末尾命中 97%。
 *      生产佐证：system 末尾记忆块换内容那次，命中率 99% → 6%。
 *
 * 2) 用 before_provider_request 钩子，而不是 context 事件。
 *    理由：context 事件的改写会被写回会话状态 → 临时块照样落盘（实测确认）；
 *    before_provider_request 改的是序列化之后的线上报文，不经过会话状态。
 *
 * 3) 这些块都不得出现在会话历史里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appendTailBlock } from "../lib/piagent.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");

// ── appendTailBlock 行为 ──────────────────────────────────────────────

test("appendTailBlock：content 为字符串时追加到末尾", () => {
  const p = { messages: [{ role: "system", content: "S" }, { role: "user", content: "你好" }] };
  assert.equal(appendTailBlock(p, "【临时】X"), true);
  assert.equal(p.messages[1].content, "你好\n\n【临时】X");
  assert.equal(p.messages[0].content, "S", "system 不该被碰");
});

test("appendTailBlock：content 为分片数组时 push 一个 text 分片", () => {
  const p = { messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }] };
  assert.equal(appendTailBlock(p, "【临时】Y"), true);
  assert.equal(p.messages[0].content.length, 2);
  assert.deepEqual(p.messages[0].content[1], { type: "text", text: "【临时】Y" });
});

test("appendTailBlock：只动最后一条，前面的消息逐字节不变（缓存前缀安全）", () => {
  const head = [{ role: "system", content: "S" }, { role: "user", content: "A" }, { role: "tool", content: "R" }];
  const p = { messages: JSON.parse(JSON.stringify(head)) };
  appendTailBlock(p, "Z");
  // 除最后一条外，其余必须逐字节不变 —— 它们构成缓存前缀
  assert.deepEqual(p.messages.slice(0, -1), head.slice(0, -1), "前面的消息被改动了 —— 这会清空前缀缓存");
  assert.equal(p.messages.at(-1).content, "R\n\nZ", "应追加在最后一条尾部");
});

test("appendTailBlock：支持直接传消息数组", () => {
  const arr = [{ role: "user", content: "hi" }];
  assert.equal(appendTailBlock(arr, "K"), true);
  assert.equal(arr[0].content, "hi\n\nK");
});

test("appendTailBlock：最后一条是 assistant 时不挂它身上（会被当成它自己的话）", () => {
  const p = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "嗯" }] };
  appendTailBlock(p, "K");
  assert.equal(p.messages[1].content, "嗯", "不该污染 assistant 消息");
  assert.equal(p.messages.at(-1).role, "user");
  assert.equal(p.messages.at(-1).content, "K");
});

test("appendTailBlock：结构不符预期时返回 false，不抛异常", () => {
  assert.equal(appendTailBlock(null, "x"), false);
  assert.equal(appendTailBlock({}, "x"), false);
  assert.equal(appendTailBlock({ messages: [] }, "x"), false);
  assert.equal(appendTailBlock({ messages: [null] }, "x"), false);
  assert.equal(appendTailBlock({ messages: [{ role: "user" }] }, "x"), true, "content 缺失时应能补上");
});

// ── 源码契约（防回退到 system prompt / context 事件）──────────────────

test("不再用 context 事件注入（它的改写会落盘）", () => {
  assert.doesNotMatch(SRC, /pi\.on\(\s*["']context["']/, "又用上 context 事件了 —— 实测它的改写会被写回会话状态而落盘");
});

test("临时块注入位于 before_provider_request 钩子里", () => {
  const m = SRC.match(/pi\.on\(\s*["']before_provider_request["'][\s\S]{0,900}?appendTailBlock/);
  assert.ok(m, "没找到 before_provider_request 中调用 appendTailBlock");
});

test("before_agent_start 的注入必须都是「同一会话内稳定」的内容", () => {
  // 判据不是「白名单能不能进 system」，而是「**它每轮会不会变**」。
  // system 里一旦有逐轮变化的内容，分叉点之后（整段历史）的缓存全部作废。
  //
  // 允许进 system：
  //   · 人设（同一用户恒定）
  //   · 权限白名单 permBlockSys（同一私聊对象权限稳定；admin 私聊时为空串）
  // 必须留报文末尾（逐轮变化）：
  //   · 记忆检索结果 memInjection
  //   · 风险研判 riskNote（只对当次请求有效）
  //   · 群聊白名单 permBlockTail（群里每次说话的人可能不同）
  const i = SRC.indexOf('pi.on("before_agent_start"');
  assert.ok(i > 0, "没找到 before_agent_start 钩子");
  const end = SRC.indexOf("if (!add) return undefined;", i);
  assert.ok(end > i, "没找到 before_agent_start 的返回点");
  const seg = SRC.slice(i, end);

  assert.doesNotMatch(seg, /memInjection/, "记忆注入进了 system prompt —— 它每轮都变，会清空整段历史缓存");
  assert.doesNotMatch(seg, /riskNote/, "风险研判进了 system prompt —— 它只对当次请求有效且逐次变化");
  assert.doesNotMatch(seg, /permBlockTail/, "群聊白名单进了 system prompt —— 群内说话人可能变化");

  assert.match(seg, /persona/, "人设应仍在 system 中注入");
  assert.match(seg, /permBlockSys/, "私聊权限白名单应并入 system（权限稳定，不破坏缓存）");
});

test("会话文件里不写权限白名单 / 记忆块 / 风险研判", () => {
  const f = SRC.match(/finalText = \([^;]*?;/);
  assert.ok(f, "没找到 finalText 拼接语句");
  assert.doesNotMatch(f[0], /perm|mem|risk/i, "临时块又被拼进 user 消息正文（会持久化）");
});

test("appendTailBlock 已导出（便于测试与复用）", () => {
  assert.match(SRC, /export function appendTailBlock\(/);
});
