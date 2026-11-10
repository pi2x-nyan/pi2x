/**
 * 系统唤醒通道 —— 把「外部事件」接成一次真正的 Router 唤醒
 *
 * 【要解决的问题】
 * lib/events.mjs 的事件队列本来只有 bridge 的「主动回合」在消费，而主动回合
 * 默认关着（config.pi.proactive.enabled=false）。于是挂课看门狗、磁盘告警这些
 * 真正着急的事写进队列后，永远没人取 —— 2026-11-04 挂课卡死 17 小时，事件
 * 链路完全没参与，就是这个断点。
 *
 * 【为什么单独一条通道，而不是把主动回合打开】
 * 主动回合是「没人说话时找点话说」，受静默时段/冷却/每日上限约束；
 * 系统事件是「出事了，必须让 Router 知道」，两者的闸门语义相反。
 * 所以这里独立轮询、独立节流，与 proactive 开关无关。
 *
 * 【唤醒方式】
 * 不自己拼 submit，而是复用 bridge 里 _wakeSubDone 那套：
 *   - 会话空闲 → sendCustomMessage({triggerTurn:true})  真开新一轮
 *   - 会话正忙 → deliverAs:"steer"                       注入当前回合
 * 见 lib/piagent.mjs 的 _notifySession / lib/restart-resume.mjs 的 pickNotifyOptions。
 *
 * 【节流】
 *   · 同一个事件 key 在 throttleMinutes（默认 30）内只唤醒一次
 *   · 每天唤醒次数不超过 dailyMax（默认 12），超出的只写日志
 *   · 唤醒失败（没有会话 / 抛错）不记节流、不消费，下一轮还能重试
 *   · 模型判断「不用处理」回了 SKIP，也算已消费 —— 否则每分钟重来一次
 *
 * 【状态落盘】
 * private/state/system-wake.json：{ day, count, keys: { <事件key>: 上次唤醒时间 } }
 * 落盘而不是只放内存，是因为 bridge 重启后节流窗口和当日额度都该延续。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR, config } from "./config.mjs";
import { loadEvents, markConsumed } from "./events.mjs";
import { appendDisposition } from "./trigger.mjs";
import { createLogger } from "./log.mjs";
import { runWithTurnCtx } from "./turn-context.mjs";

export const DEFAULT_TYPES = Object.freeze(["mooc", "disk", "job"]);

const DEFAULTS = Object.freeze({
  enabled: true,
  types: DEFAULT_TYPES,
  chat: "",
  intervalSec: 60,
  throttleMinutes: 30,
  dailyMax: 12,
});

export const WAKE_STATE_FILE = path.join(STATE_DIR, "system-wake.json");

/** 归一化配置：写错的字段回落到默认值，不因为一个值写错就整条通道失效 */
export function systemWakeConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const types = Array.isArray(c.types) && c.types.length
    ? c.types.map((t) => String(t)).filter(Boolean)
    : [...DEFAULT_TYPES];
  const num = (v, d, min) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : d;
  };
  return {
    enabled: c.enabled !== false,
    types,
    chat: typeof c.chat === "string" ? c.chat.trim() : "",
    intervalSec: num(c.intervalSec, DEFAULTS.intervalSec, 15),
    throttleMinutes: num(c.throttleMinutes, DEFAULTS.throttleMinutes, 0),
    dailyMax: num(c.dailyMax, DEFAULTS.dailyMax, 0),
  };
}

/**
 * 唤醒目标会话：显式配置优先，否则沿用「主人私聊」的既有约定
 * （config.pi.proactive.chats 的第一项，历来就是 admin 私聊）。
 */
export function resolveWakeChat(cfg, proactiveChats = []) {
  if (cfg?.chat) return cfg.chat;
  const first = Array.isArray(proactiveChats) ? proactiveChats[0] : "";
  return typeof first === "string" ? first : "";
}

const pad = (n) => String(n).padStart(2, "0");
/** 本地自然日，跨天重置每日额度 */
export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readJson(file, fallback) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d && typeof d === "object" ? d : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function loadState(file, now) {
  const d = readJson(file, {});
  const today = dayKey(now);
  const keys = d && typeof d.keys === "object" && d.keys ? { ...d.keys } : {};
  // 只留 24 小时内的节流记录，免得这个文件无限长
  const cutoff = now - 24 * 3600 * 1000;
  for (const [k, t] of Object.entries(keys)) {
    if (!Number.isFinite(t) || t < cutoff) delete keys[k];
  }
  const sameDay = d?.day === today;
  return {
    day: today,
    count: sameDay && Number.isFinite(d?.count) ? d.count : 0,
    keys,
    lastWakeAt: sameDay && Number.isFinite(d?.lastWakeAt) ? d.lastWakeAt : 0,
  };
}

/**
 * 唤醒正文。
 * 首行固定形状让 Router 一眼分清「这是事件，不是用户说话」；
 * 末尾明确「自动唤醒 + 由你决定」，避免它把系统事件当成用户在催它。
 */
export function formatWakeText(events = []) {
  const lines = events.map(
    (e) => `【系统事件】${e.type}：${String(e.text ?? "").trim()}（事件队列，非用户发言）`,
  );
  lines.push("");
  lines.push("这是系统按事件自动唤醒的一轮，不是用户发来的消息。该做什么由你判断：需要处理就去处理，不需要处理就回 SKIP。");
  return lines.join("\n");
}

/**
 * 把「唤醒 Router」这一步封成 submit —— bridge 里只需 `makePiSessionSubmit(pi)`。
 *
 * 复刻 _wakeSubDone 的提交方式（lib/piagent.mjs 的 _notifySession）：
 *   · 会话空闲 → triggerTurn 开新一轮
 *   · 会话正忙 → deliverAs:"steer" 注入当前回合
 * 并且必须包 runWithTurnCtx，否则记忆来源 / QQ 推送会串到别的会话。
 *
 * @param {object} pi createPiAgent() 的实例
 * @param {{customType?:string}} [o]
 */
export function makePiSessionSubmit(pi, { customType = "system-event" } = {}) {
  return async ({ chatKey, text }) => {
    const [, id] = String(chatKey).split(":");
    const uid = String(id ?? "");
    const entry = await pi._getSession(chatKey, uid);
    const sess = entry?.session;
    if (!sess) return { ok: false, reason: "no-session" };
    const ctx = pi._wakeCtxFromChatKey(chatKey, uid);
    await runWithTurnCtx(ctx, async () => {
      const ok = await pi._notifySession(sess, customType, text);
      if (!ok) throw new Error("notifySession 返回 false");
    });
    return { ok: true };
  };
}

/**
 * 造一个轮询器。
 *
 * 依赖全部可注入，测试里换成内存实现；生产里就是真实的 events.mjs / trigger.mjs。
 *
 * @param {object} o
 * @param {object} [o.cfg]            config.pi.systemWake
 * @param {string} [o.chatKey]        唤醒目标会话（缺省按 resolveWakeChat 推）
 * @param {(x:{chatKey:string,text:string,events:object[]}) => Promise<{ok:boolean,reason?:string,skipped?:boolean}>} o.submit
 * @param {object} [o.logger]         默认 createLogger("system-wake")
 * @param {string} [o.stateFile]      默认 private/state/system-wake.json
 * @param {string} [o.triggersFile]   默认 private/state/triggers.jsonl
 * @param {() => number} [o.now]
 */
export function createSystemWake({
  cfg,
  chatKey,
  submit,
  logger = createLogger("system-wake"),
  stateFile = process.env.PI2X_SYSTEM_WAKE_FILE || WAKE_STATE_FILE,
  triggersFile = process.env.PI2X_TRIGGERS_FILE || path.join(STATE_DIR, "triggers.jsonl"),
  now = () => Date.now(),
  load = loadEvents,
  consume = markConsumed,
} = {}) {
  const c = systemWakeConfig(cfg ?? config.pi?.systemWake);
  const target = chatKey || resolveWakeChat(c, config.pi?.proactive?.chats);

  /**
   * 扫一次队列。返回 {woke, reason, keys, count}，方便测试与日志。
   * 不抛异常（调用方是定时器，抛出去只会变成 unhandled rejection）。
   */
  async function tick() {
    const t = now();
    if (!c.enabled) return { woke: false, reason: "disabled" };
    if (!target) return { woke: false, reason: "no-chat" };
    if (typeof submit !== "function") return { woke: false, reason: "no-submit" };

    const all = (load() ?? []).filter(
      (e) => e && !e.consumedAt && c.types.includes(String(e.type)),
    );
    if (!all.length) return { woke: false, reason: "no-events" };

    const st = loadState(stateFile, t);
    const throttleMs = c.throttleMinutes * 60 * 1000;
    const ready = [];
    const throttled = [];
    for (const e of all) {
      const k = e.key || e.id;
      const last = Number(st.keys[k] ?? 0);
      if (throttleMs > 0 && last && t - last < throttleMs) throttled.push(k);
      else ready.push(e);
    }
    if (!ready.length) {
      logger.debug(
        `系统唤醒：${throttled.length} 条事件还在 ${c.throttleMinutes} 分钟节流窗内，跳过（${throttled.join(", ")}）`,
      );
      return { woke: false, reason: "throttled", keys: throttled };
    }
    if (st.count >= c.dailyMax) {
      logger.warn(
        `系统唤醒：今日已达上限 ${st.count}/${c.dailyMax}，${ready.length} 条事件只记日志：` +
          ready.map((e) => `${e.type}:${e.key || e.id}`).join(", "),
      );
      return { woke: false, reason: "daily-max", keys: ready.map((e) => e.key || e.id) };
    }

    const keys = ready.map((e) => e.key || e.id);
    const wakeId = crypto.randomBytes(3).toString("hex");
    const text = formatWakeText(ready);

    let r;
    try {
      r = await submit({ chatKey: target, text, events: ready });
    } catch (e) {
      // 失败不消费、不记节流：下一分钟还能再来一次
      logger.warn(`系统唤醒提交失败（事件保留）：${e?.message}`);
      return { woke: false, reason: "submit-error", keys };
    }
    if (!r || r.ok === false) {
      logger.warn(`系统唤醒未送达（${r?.reason ?? "unknown"}），事件保留：${keys.join(", ")}`);
      return { woke: false, reason: r?.reason ?? "submit-failed", keys };
    }

    // 送达即算消费：模型回 SKIP 也在这里一并销账，否则同一事件每分钟重来一次。
    try {
      consume(keys);
    } catch (e) {
      logger.warn(`系统唤醒：标记事件已消费失败：${e?.message}`);
    }

    // 节流与当日额度
    st.count += 1;
    st.lastWakeAt = t;
    for (const k of keys) st.keys[k] = t;
    try {
      writeJson(stateFile, st);
    } catch (e) {
      logger.warn(`系统唤醒：写节流状态失败（不影响本次唤醒）：${e?.message}`);
    }

    // 留痕：每条事件一条 disposition，事后能查「这次唤醒是因为什么、去了哪个会话」
    for (const e of ready) {
      try {
        appendDisposition(triggersFile, {
          triggerId: `sys-${e.type}-${e.id ?? wakeId}`,
          threadKey: `system:${e.type}`,
          source: "system",
          type: String(e.type),
          eventKey: e.key || e.id,
          chatKey: target,
          disposition: {
            woke: 1,
            wakeId,
            events: ready.length,
            skipped: r?.skipped ? 1 : 0,
            ...(e.meta && typeof e.meta === "object" ? { meta: e.meta } : {}),
          },
        }, { fs });
      } catch (err) {
        logger.warn(`系统唤醒：写 trigger 记录失败：${err?.message}`);
      }
    }

    logger.info(
      `系统唤醒：${target} · ${ready.length} 条（${ready.map((e) => e.type).join("/")}）· ` +
        `今日第 ${st.count}/${c.dailyMax} 次 · ${keys.join(", ")}` +
        (r?.skipped ? " · 模型已跳过" : ""),
    );
    return { woke: true, reason: "woke", keys, count: st.count, chatKey: target, wakeId };
  }

  return { tick, cfg: c, chatKey: target };
}
