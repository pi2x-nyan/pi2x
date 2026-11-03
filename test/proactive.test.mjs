/**
 * 主动回合的四道闸：这是「别打扰人」的防线，比「能不能主动」重要得多。
 */
import { test } from "node:test";
import assert from "node:assert";
import { proactiveConfig, shouldRun, inQuietHours } from "../lib/proactive.mjs";

const BASE = {
  enabled: true,
  chats: ["private:1"],
  intervalMinutes: 180,
  quietHours: [23, 8],
  dailyMax: 3,
  minIdleMinutes: 15,
};

// 2026-10-28 14:30 本地时间
const T = new Date(2026, 9, 28, 14, 30, 0).getTime();

test("静默时段：跨零点写法（23→8）", () => {
  assert.equal(inQuietHours(23, [23, 8]), true);
  assert.equal(inQuietHours(2, [23, 8]), true);
  assert.equal(inQuietHours(7, [23, 8]), true);
  assert.equal(inQuietHours(8, [23, 8]), false);
  assert.equal(inQuietHours(14, [23, 8]), false);
});

test("静默时段：不跨零点写法（13→15）", () => {
  assert.equal(inQuietHours(14, [13, 15]), true);
  assert.equal(inQuietHours(15, [13, 15]), false);
});

test("未启用 / 会话不在名单：不跑", () => {
  const st = { chats: {} };
  assert.equal(shouldRun({ cfg: { ...BASE, enabled: false }, state: st, chatKey: "private:1", now: T }).run, false);
  assert.equal(shouldRun({ cfg: BASE, state: st, chatKey: "private:2", now: T }).run, false);
});

test("冷却时间未到：不跑", () => {
  const st = { chats: { "private:1": { lastAt: T - 60 * 60000, day: "2026-10-28", count: 1 } } };
  assert.equal(shouldRun({ cfg: BASE, state: st, chatKey: "private:1", now: T }).reason, "cooldown");
});

test("冷却时间已过：跑", () => {
  const st = { chats: { "private:1": { lastAt: T - 200 * 60000, day: "2026-10-28", count: 1 } } };
  assert.equal(shouldRun({ cfg: BASE, state: st, chatKey: "private:1", now: T }).run, true);
});

test("每日上限：达到就不再跑，跨天自动清零", () => {
  const st = { chats: { "private:1": { lastAt: T - 400 * 60000, day: "2026-10-28", count: 3 } } };
  assert.equal(shouldRun({ cfg: BASE, state: st, chatKey: "private:1", now: T }).reason, "daily-cap");
  const st2 = { chats: { "private:1": { lastAt: T - 400 * 60000, day: "2026-10-27", count: 3 } } };
  assert.equal(shouldRun({ cfg: BASE, state: st2, chatKey: "private:1", now: T }).run, true);
});

test("用户刚说过话：不打扰", () => {
  const st = { chats: {} };
  const r = shouldRun({ cfg: BASE, state: st, chatKey: "private:1", now: T, lastUserMsgAt: T - 5 * 60000 });
  assert.equal(r.reason, "user-active");
});

test("静默时段内：不跑", () => {
  const st = { chats: {} };
  const night = new Date(2026, 9, 28, 2, 0, 0).getTime();
  assert.equal(shouldRun({ cfg: BASE, state: st, chatKey: "private:1", now: night }).reason, "quiet-hours");
});

test("配置缺项：用默认值补齐，且默认关闭", () => {
  const c = proactiveConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.intervalMinutes, 180);
  assert.deepEqual(c.quietHours, [23, 8]);
  assert.equal(c.dailyMax, 3);
});
