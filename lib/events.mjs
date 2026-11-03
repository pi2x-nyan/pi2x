/**
 * 事件队列 —— 让 agent 不只被「时间」触发，也能被「事情」触发
 *
 * 三种来源统一成一种结构：
 *   1. 外部推送   脚本/服务用 `node scripts/event.mjs push <type> <text>` 写进队列
 *   2. 文件变化   watchFiles 里配置的路径，mtime/大小变了就生成事件
 *   3. 网页变化   watchUrls 里配置的地址，正文 hash 变了就生成事件
 *
 * 为什么用文件队列而不是 HTTP 端口：
 *   给 bridge 开一个 HTTP 入口等于多一个攻击面，而事件本来就低频。
 *   落文件的还有一个好处——bridge 重启期间产生的事件不会丢。
 *
 * 消费规则（重要）：
 *   - 事件有 ttl，过期就不再触发（避免重启后把三天前的事件当新闻播报）
 *   - 同 key 的重复事件合并，只留最新（同一个网页变了十次，只说一次）
 *   - 消费后 markConsumed，不会重复播报；保留最近 N 条便于排查
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR } from "./config.mjs";

export const EVENTS_FILE = path.join(STATE_DIR, "events.json");
export const WATCH_FILE = path.join(STATE_DIR, "watch.json");

// 允许用环境变量覆盖（测试用；生产不设就不影响）
const evFile = () => process.env.PI2X_EVENTS_FILE || EVENTS_FILE;
const wtFile = () => process.env.PI2X_WATCH_FILE || WATCH_FILE;

const MAX_EVENTS = 200;
const DEFAULT_TTL_MS = 6 * 3600 * 1000; // 6 小时没被消费就作废

function readJson(file, fallback) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d && typeof d === "object" ? d : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 读取未消费事件（顺带清理过期/超量的） */
export function loadEvents(now = Date.now()) {
  const d = readJson(evFile(), { events: [] });
  const list = Array.isArray(d.events) ? d.events : [];
  const live = list.filter((e) => !e.consumedAt && now - (e.at ?? 0) < (e.ttlMs ?? DEFAULT_TTL_MS));
  if (live.length !== list.length) writeJson(evFile(), { events: live });
  return live;
}

/**
 * 写入一条事件。
 * 同 key 的未消费事件会被替换（只留最新），避免同一件事重复播报。
 */
export function pushEvent({ type, key, text, meta, ttlMs, now = Date.now() }) {
  const d = readJson(evFile(), { events: [] });
  let list = Array.isArray(d.events) ? d.events : [];
  const k = key ?? `${type}:${crypto.createHash("sha1").update(String(text ?? "")).digest("hex").slice(0, 8)}`;
  list = list.filter((e) => e.key !== k || e.consumedAt);
  list.push({ id: crypto.randomBytes(3).toString("hex"), type, key: k, text: String(text ?? ""), meta: meta ?? {}, at: now, ttlMs: ttlMs ?? DEFAULT_TTL_MS });
  // 只留最近 N 条（含已消费的尾巴）
  const consumed = list.filter((e) => e.consumedAt).slice(-20);
  const fresh = list.filter((e) => !e.consumedAt).slice(-MAX_EVENTS);
  writeJson(evFile(), { events: [...consumed, ...fresh] });
  return k;
}

/** 标记事件已消费（按 key 或 id） */
export function markConsumed(keys, now = Date.now()) {
  const set = new Set(Array.isArray(keys) ? keys : [keys]);
  const d = readJson(evFile(), { events: [] });
  const list = (Array.isArray(d.events) ? d.events : []).map((e) =>
    set.has(e.key) || set.has(e.id) ? { ...e, consumedAt: now } : e,
  );
  writeJson(evFile(), { events: list.slice(-MAX_EVENTS) });
}

/** 读/写监视列表（文件与网页） */
export function loadWatch() {
  return readJson(wtFile(), { files: [], urls: [] });
}

export function saveWatch(w) {
  writeJson(wtFile(), { files: w.files ?? [], urls: w.urls ?? [] });
}

/**
 * 检查文件监视：mtime+size 变化即产生事件。
 * 首次见到的文件只记基线，不产生事件（否则一上线就把所有文件当成“刚变了”）。
 */
export function checkFiles(watch, now = Date.now()) {
  const state = readJson(wtFile(), { files: [], urls: [], baseline: {} });
  const baseline = state.baseline ?? {};
  const events = [];
  let dirty = false;
  for (const f of watch.files ?? []) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue; // 文件不存在就跳过
    }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (baseline[f] === undefined) {
      baseline[f] = sig;
      dirty = true;
      continue;
    }
    if (baseline[f] !== sig) {
      baseline[f] = sig;
      dirty = true;
      events.push({ type: "file", key: `file:${f}`, text: `文件有更新：${path.basename(f)}（${f}）`, meta: { path: f } });
    }
  }
  if (dirty) writeJson(wtFile(), { ...state, baseline });
  for (const e of events) pushEvent({ ...e, now });
  return events;
}

/**
 * 检查网页监视：抓正文算 hash，变化即产生事件。
 * 用 fetch + 超时；失败不产生事件也不抛（网络抖动不该变成工作量）。
 */
export async function checkUrls(watch, now = Date.now(), timeoutMs = 15000) {
  const state = readJson(wtFile(), { files: [], urls: [], baseline: {} });
  const baseline = state.baseline ?? {};
  const events = [];
  let dirty = false;
  for (const u of watch.urls ?? []) {
    let body = "";
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(u, { signal: ac.signal, headers: { "user-agent": "PI2X-watch/1.0" } });
      clearTimeout(t);
      if (!r.ok) continue;
      body = await r.text();
    } catch {
      continue;
    }
    const h = crypto.createHash("sha1").update(body).digest("hex");
    if (baseline[u] === undefined) {
      baseline[u] = h;
      dirty = true;
      continue;
    }
    if (baseline[u] !== h) {
      baseline[u] = h;
      dirty = true;
      events.push({ type: "url", key: `url:${u}`, text: `网页内容有变化：${u}`, meta: { url: u } });
    }
  }
  if (dirty) writeJson(wtFile(), { ...state, baseline });
  for (const e of events) pushEvent({ ...e, now });
  return events;
}
