import test from "node:test";
import assert from "node:assert/strict";

import { memorySourceOf, sourceMatches } from "../lib/memory-source.mjs";

test("私聊来源：private:<用户QQ>", () => {
  assert.equal(memorySourceOf({ chatType: "private", userId: "1000000001" }), "private:1000000001");
  assert.equal(memorySourceOf({ chatType: "private", userId: 123 }), "private:123");
});

test("群聊来源：group:<群号>（不是用户号！）", () => {
  // 这是本次修复的核心：写入端曾写成 `group:${userId}`，把用户 QQ 当群号
  const src = memorySourceOf({ chatType: "group", userId: "1000000001", targetId: "1077971815" });
  assert.equal(src, "group:1077971815");
  assert.notEqual(src, "group:1000000001", "绝不能把用户 QQ 当群号");
  assert.ok(!src.includes("1000000001"), "群来源键里不该出现用户号");
});

test("群聊缺 targetId → null（宁可不写，也不要写进错误的桶）", () => {
  assert.equal(memorySourceOf({ chatType: "group", userId: "1000000001" }), null);
});

test("私聊缺 userId → null", () => {
  assert.equal(memorySourceOf({ chatType: "private" }), null);
  assert.equal(memorySourceOf({}), null);
  assert.equal(memorySourceOf(), null);
});

test("来源匹配：精确 / 前缀 / seed", () => {
  assert.equal(sourceMatches("private:1", "private:1"), true);
  assert.equal(sourceMatches("private:1", "private:2"), false);
  assert.equal(sourceMatches("group:999", "group:"), true, "以冒号结尾的过滤器表示按前缀匹配");
  assert.equal(sourceMatches("private:1", "group:"), false);
  assert.equal(sourceMatches("seed", "seed"), true);
  assert.equal(sourceMatches("private:1", "seed"), false);
  assert.equal(sourceMatches("anything", ""), true, "空过滤 = 不过滤");
  assert.equal(sourceMatches("group:1:2", "group:1"), true, "带后缀的来源也算命中前缀");
});

// ── 回归：写入键与读取键必须一致 ──────────────────────────────────────────

test("回归：群聊写入的来源，必须能被群聊读取的过滤器匹配到", () => {
  // 修复前：写入得到 group:<用户QQ>，读取用 group:<群号>，永远匹配不上
  const ctx = { chatType: "group", userId: "1000000001", targetId: "1077971815" };
  const written = memorySourceOf({ chatType: ctx.chatType, userId: ctx.userId, targetId: ctx.targetId });
  const readFilter = memorySourceOf({ chatType: ctx.chatType, userId: ctx.userId, targetId: ctx.targetId });
  assert.equal(sourceMatches(written, readFilter), true, "写入与读取必须用同一套规则，否则记忆查不到");
});

test("回归：修复前的错误写法确实匹配不上（证明这个 bug 是真的）", () => {
  const buggyWritten = "group:1000000001"; // 旧代码：chatType:userId
  const correctFilter = "group:1077971815"; // 正确读取：group:群号
  assert.equal(sourceMatches(buggyWritten, correctFilter), false, "旧写法与读取过滤器不匹配 —— 这就是丢数据的原因");
});

test("回归：私聊写入与读取同样自洽", () => {
  const w = memorySourceOf({ chatType: "private", userId: "1000000001" });
  const f = memorySourceOf({ chatType: "private", userId: "1000000001" });
  assert.equal(sourceMatches(w, f), true);
});

test("回归：不会把私聊来源与群聊来源混起来", () => {
  const priv = memorySourceOf({ chatType: "private", userId: "1000000001" });
  const grp = memorySourceOf({ chatType: "group", userId: "1000000001", targetId: "1077971815" });
  assert.notEqual(priv, grp);
  assert.equal(sourceMatches(priv, grp), false);
  assert.equal(sourceMatches(grp, priv), false);
});

test("群来源按群隔离：不同群互不可见", () => {
  const a = memorySourceOf({ chatType: "group", userId: "1", targetId: "100" });
  const b = memorySourceOf({ chatType: "group", userId: "1", targetId: "200" });
  assert.equal(sourceMatches(a, b), false);
  assert.equal(sourceMatches(a, a), true);
});
