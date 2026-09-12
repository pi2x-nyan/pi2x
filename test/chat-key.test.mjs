import test from "node:test";
import assert from "node:assert/strict";

import { chatKeyOf, sessionKeyOf, pickSessionEntry } from "../lib/agent/chat-key.mjs";

// ── 会话键构造 ────────────────────────────────────────────────────────────

test("chatKeyOf：私聊为 private:<uid>", () => {
  assert.equal(chatKeyOf({ chatType: "private", userId: "1000000001" }), "private:1000000001");
  assert.equal(chatKeyOf({ chatType: "private", userId: 123 }), "private:123");
});

test("chatKeyOf：群聊按人隔离（group:<群号>:<用户号>）", () => {
  assert.equal(
    chatKeyOf({ chatType: "group", userId: "1000000001", targetId: "1077971815" }),
    "group:1077971815:1000000001"
  );
});

test("chatKeyOf：信息不足返回 null（而不是拼出半截键）", () => {
  assert.equal(chatKeyOf({}), null);
  assert.equal(chatKeyOf(), null);
  assert.equal(chatKeyOf({ chatType: "private" }), null, "缺 userId");
  assert.equal(chatKeyOf({ chatType: "group", userId: "1" }), null, "缺 targetId");
  assert.equal(chatKeyOf({ chatType: "group", targetId: "1" }), null, "缺 userId");
});

test("sessionKeyOf：群会话追 user 后缀，私聊不动", () => {
  assert.equal(sessionKeyOf("group:1077971815", "1000000001"), "group:1077971815:1000000001");
  assert.equal(sessionKeyOf("private:1000000001", "1000000001"), "private:1000000001");
});

test("一致性：chatKeyOf(群) 等于 sessionKeyOf(收消息基础键)", () => {
  const base = "group:1077971815"; // bridge 收消息时拼的基础键
  assert.equal(sessionKeyOf(base, "1000000001"), chatKeyOf({ chatType: "group", userId: "1000000001", targetId: "1077971815" }));
});

// ── 会话挑选（/status 展示上下文占用用）──────────────────────────────────

const mk = (name, { streaming = false } = {}) => [name, { name, session: { isStreaming: streaming } }];

test("pickSessionEntry：优先命中指定键", () => {
  const m = new Map([mk("private:1"), mk("private:2")]);
  assert.equal(pickSessionEntry(m, "private:2")?.name, "private:2");
});

test("pickSessionEntry：指定键不存在时，优先正在流式输出的那个", () => {
  const m = new Map([mk("private:1"), mk("private:2", { streaming: true })]);
  assert.equal(pickSessionEntry(m, "private:999")?.name, "private:2");
});

test("pickSessionEntry：都没有流式时取最后一个（Map 保留插入序）", () => {
  const m = new Map([mk("private:1"), mk("private:2")]);
  assert.equal(pickSessionEntry(m, null)?.name, "private:2");
});

test("pickSessionEntry：空表 / 非法输入 → null", () => {
  assert.equal(pickSessionEntry(new Map(), "k"), null);
  assert.equal(pickSessionEntry(null), null);
  assert.equal(pickSessionEntry(undefined), null);
  assert.equal(pickSessionEntry({}), null);
  assert.equal(pickSessionEntry("not-a-map"), null);
});

test("pickSessionEntry：entry 结构不完整也不炸", () => {
  const m = new Map([["k", {}], [undefined, null]]);
  assert.doesNotThrow(() => pickSessionEntry(m, "k"));
  assert.doesNotThrow(() => pickSessionEntry(m));
});
