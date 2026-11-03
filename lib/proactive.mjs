/**
 * 主动回合（proactive / heartbeat）—— 让 PI2X 在没人说话时也能“想起”该做的事
 *
 * 与已有的「生命周期心跳」区分：那个是 process heartbeat（写 token 给看门狗判断进程活着），
 * 这里是 agent heartbeat —— 周期性跑一个**轻量回合**，由模型判断有没有值得主动说的事。
 *
 * 设计要点（都是踩过的坑换来的）：
 *  - **抑制比触发更重要**：主动行为的失败模式不是“没说话”，是“话太多”。
 *    所以有四道闸：静默时段、冷却时间、每日上限、用户刚说过话就不打扰。
 *  - **SKIP 是一等公民**：模型可以明确说「没事」，这时什么都不发，也不记一条“已说”。
 *  - **状态落盘**：重启不能把冷却时间清零，否则重启几次就轰炸几次。
 *  - 与 bridge 解耦：只做判定与状态，真正“跑回合、发消息”由调用方注入。
 */
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";

export const PROACTIVE_FILE = path.join(STATE_DIR, "proactive.json");

const DEFAULTS = {
  enabled: false,
  chats: [],              // e.g. ["private:3573297011"]
  intervalMinutes: 180,   // 同一会话两次主动之间的最小间隔
  quietHours: [23, 8],    // 本地时间 [起, 止)，跨零点
  dailyMax: 3,
  minIdleMinutes: 15,     // 用户刚说完话不做主动
  maxChars: 120,
};

/** 读配置（config.pi.proactive 优先，缺项用默认值补齐） */
export function proactiveConfig(cfg) {
  const c = cfg ?? {};
  return {
    ...DEFAULTS,
    ...c,
    quietHours: Array.isArray(c.quietHours) && c.quietHours.length === 2 ? c.quietHours : DEFAULTS.quietHours,
    chats: Array.isArray(c.chats) ? c.chats : DEFAULTS.chats,
  };
}

export function loadState() {
  try {
    const raw = fs.readFileSync(PROACTIVE_FILE, "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : { chats: {} };
  } catch {
    return { chats: {} };
  }
}

export function saveState(st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${PROACTIVE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  fs.renameSync(tmp, PROACTIVE_FILE);
}

/** 是否在静默时段（支持跨零点，如 23→8） */
export function inQuietHours(hour, [from, to]) {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** 今天（本地）的日期串，用于每日计数清零 */
function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 判定某个会话这一分钟该不该跑主动回合
 * @returns {{run:boolean, reason:string}}
 */
export function shouldRun({ cfg, state, chatKey, now = Date.now(), lastUserMsgAt = 0 }) {
  if (!cfg.enabled) return { run: false, reason: "disabled" };
  if (!cfg.chats.includes(chatKey)) return { run: false, reason: "not-listed" };
  const d = new Date(now);
  if (inQuietHours(d.getHours(), cfg.quietHours)) return { run: false, reason: "quiet-hours" };
  if (lastUserMsgAt && now - lastUserMsgAt < cfg.minIdleMinutes * 60000) return { run: false, reason: "user-active" };
  const c = state.chats?.[chatKey] ?? {};
  const today = dayKey(now);
  const count = c.day === today ? Number(c.count ?? 0) : 0;
  if (count >= cfg.dailyMax) return { run: false, reason: "daily-cap" };
  if (c.lastAt && now - c.lastAt < cfg.intervalMinutes * 60000) return { run: false, reason: "cooldown" };
  return { run: true, reason: "due" };
}

/** 记录一次“已说” */
export function recordSent({ state, chatKey, now = Date.now() }) {
  const today = dayKey(now);
  const c = state.chats?.[chatKey] ?? {};
  const count = c.day === today ? Number(c.count ?? 0) : 0;
  state.chats = state.chats ?? {};
  state.chats[chatKey] = { lastAt: now, day: today, count: count + 1 };
  saveState(state);
  return state;
}

/** 记录一次“看了但没事可说”（不影响冷却，只留痕便于排查） */
export function recordSkip({ state, chatKey, now = Date.now() }) {
  state.chats = state.chats ?? {};
  const c = state.chats[chatKey] ?? {};
  state.chats[chatKey] = { ...c, lastCheckAt: now };
  saveState(state);
  return state;
}

/**
 * 未完成的主动回合（重启/OOM 打断时留下的）。
 *
 * 为什么需要：静默轮的「回滚」只在轮次正常结束时执行。如果进程在中途死掉，
 * 那轮的内部提示词和半截输出就留在了会话历史里 —— 下次用户说话时模型会看到一个
 * 莫名其妙的自言自语。这里记住「开跑前的 leaf」，下次打开会话时补一次回滚。
 */
export function setPendingRollback({ state, chatKey, leafId, now = Date.now() }) {
  state.pending = state.pending ?? {};
  state.pending[chatKey] = { leafId: leafId ?? null, at: now };
  saveState(state);
  return state;
}

export function getPendingRollback({ state, chatKey }) {
  return state.pending?.[chatKey] ?? null;
}

export function clearPendingRollback({ state, chatKey }) {
  if (state.pending && state.pending[chatKey]) {
    delete state.pending[chatKey];
    saveState(state);
  }
  return state;
}
