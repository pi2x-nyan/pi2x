/**
 * active-chat：给「子进程」用的当前会话记录。
 *
 * 被锁定的规则：group_history 对所有人开放，但非特权用户**只能查自己当前所在的群**。
 * 这条边界靠 private/state/active-chat.json 实现，测试必须盖住三件事：
 *   1) 记下来、读得回
 *   2) 过期就作废（不能拿一小时前的记录去查一个早就离开的群）
 *   3) 私聊会话不能被当成群（否则 private 用户凭空拿到一个「当前群」）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config 在导入时就读 STATE_DIR，所以必须先设环境变量再动态 import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "active-chat-"));
process.env.PI2X_STATE_DIR = tmp;

const { rememberChat, currentChatOf, ACTIVE_CHAT_TTL_MS } = await import("../lib/active-chat.mjs");

test("记下来能读回，字段对齐", () => {
  assert.equal(rememberChat("1001", "group", "798322315"), true);
  const cur = currentChatOf("1001");
  assert.ok(cur);
  assert.equal(cur.chatType, "group");
  assert.equal(cur.targetId, "798322315");
});

test("后写的覆盖先写的（人换群了要跟着走）", () => {
  rememberChat("1002", "group", "111");
  rememberChat("1002", "group", "222");
  assert.equal(currentChatOf("1002").targetId, "222");
});

test("过期作废：超过 TTL 视为没有记录", () => {
  const t0 = Date.now();
  rememberChat("1003", "group", "333", t0);
  assert.ok(currentChatOf("1003", t0 + 1000), "TTL 内应有效");
  assert.equal(currentChatOf("1003", t0 + ACTIVE_CHAT_TTL_MS + 1), null, "超过 TTL 必须失效");
});

test("私聊也记录，但 chatType 必须是 private（上层据此拒绝群查询）", () => {
  rememberChat("1004", "private", "1004");
  const cur = currentChatOf("1004");
  assert.equal(cur.chatType, "private");
});

test("没记录的人返回 null（不是空对象）", () => {
  assert.equal(currentChatOf("9999"), null);
});

test("空 userId / 空 targetId 不写（避免写出无主记录）", () => {
  assert.equal(rememberChat("", "group", "123"), false);
  assert.equal(rememberChat("1005", "group", ""), false);
  assert.equal(currentChatOf(""), null);
});

test("过期项会在下次写入时被清掉（文件不会无限长）", () => {
  const old = Date.now() - ACTIVE_CHAT_TTL_MS - 60_000;
  rememberChat("1006", "group", "666", old);
  rememberChat("1007", "group", "777"); // 触发清理
  const all = JSON.parse(fs.readFileSync(path.join(tmp, "active-chat.json"), "utf8"));
  assert.equal(all["1006"], undefined, "过期项应被清掉");
  assert.ok(all["1007"], "新项应在");
});

test("文件损坏时不抛异常，退化为「没有记录」", () => {
  fs.writeFileSync(path.join(tmp, "active-chat.json"), "{not json");
  assert.equal(currentChatOf("1008"), null);
  assert.equal(rememberChat("1008", "group", "888"), true, "损坏后仍应能重建");
  assert.equal(currentChatOf("1008").targetId, "888");
});
