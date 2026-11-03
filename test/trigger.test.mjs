import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrigger, strengthOf, threadKeyOf, appendDisposition } from "../lib/trigger.mjs";

test("私聊：直接对话，算 explicit", () => {
  const t = buildTrigger({ chatType: "private", chatId: 3573297011, userId: 3573297011, text: "在吗" });
  assert.equal(t.addressed, "direct");
  assert.equal(t.human, true);
  assert.equal(strengthOf(t), "explicit");
  assert.equal(t.threadKey, "qq:private:3573297011");
});

test("群里 @ 我：explicit", () => {
  const t = buildTrigger({ chatType: "group", chatId: 798322315, userId: 1, text: "@2X 看看这个", mentionsMe: true });
  assert.equal(t.addressed, "mention");
  assert.equal(strengthOf(t), "explicit");
  assert.equal(t.threadKey, "qq:group:798322315");
});

test("群里没 @ 我：默认不听", () => {
  const t = buildTrigger({ chatType: "group", chatId: 798322315, userId: 1, text: "今天好热" });
  assert.equal(t.addressed, undefined);
  assert.equal(strengthOf(t), "none");
});

test("群里没 @，但团队放开了整条会话：只能是 inferred，不升级成 explicit", () => {
  const t = buildTrigger({ chatType: "group", chatId: 798322315, userId: 1, text: "今天好热" });
  assert.equal(strengthOf(t, { listenAll: true, allowed: true }), "inferred");
});

test("机器人说的：永远不算人在请求，强度 none", () => {
  const t = buildTrigger({ chatType: "group", chatId: 1, userId: 2, text: "构建失败 #123", mentionsMe: true, isBot: true });
  assert.equal(t.human, false);
  assert.equal(strengthOf(t, { listenAll: true }), "none");
});

test("暂停时什么都不接", () => {
  const t = buildTrigger({ chatType: "private", chatId: 1, userId: 1, text: "hi" });
  assert.equal(strengthOf(t, { paused: true }), "none");
});

test("引用同一条根消息的消息归到同一个 thread", () => {
  const a = buildTrigger({ chatType: "group", chatId: 9, userId: 1, text: "hi", replyRootId: 555 });
  const b = buildTrigger({ chatType: "group", chatId: 9, userId: 2, text: "嗯", replyRootId: 555 });
  const c = buildTrigger({ chatType: "group", chatId: 9, userId: 3, text: "另说一句" });
  assert.equal(a.threadKey, b.threadKey);
  assert.notEqual(a.threadKey, c.threadKey);
  assert.equal(threadKeyOf({ chatType: "group", chatId: 9 }), "qq:group:9");
});

test("处置记录按行追加，字段原样保留", () => {
  const lines = [];
  appendDisposition("x.jsonl", { triggerId: "t1", disposition: { filtered: { code: "not_addressed" } } }, { append: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.triggerId, "t1");
  assert.equal(rec.disposition.filtered.code, "not_addressed");
  assert.ok(rec.at);
});
