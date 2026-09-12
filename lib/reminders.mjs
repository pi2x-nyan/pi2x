/**
 * PI2X 提醒调度核心库
 *
 * 设计：
 *  - 提醒条目持久化在 state/reminders.json（原子写）
 *  - 由 cron 每分钟调用 scripts/reminders.mjs，到期即经 OneBot WS 发送
 *  - 支持一次性与周期提醒（repeatMinutes + 可选 until）
 *  - 与 bridge 进程解耦：即使 PI2X 重启/挂掉，cron 仍能按时发出提醒
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const STATE_DIR = path.join(ROOT, "state");
export const REMINDERS_FILE = path.join(STATE_DIR, "reminders.json");

/** 读取全部提醒条目 */
export function loadReminders() {
  try {
    const raw = fs.readFileSync(REMINDERS_FILE, "utf8");
    const d = JSON.parse(raw);
    return Array.isArray(d?.reminders) ? d.reminders : [];
  } catch {
    return [];
  }
}

/** 原子写入全部提醒条目 */
export function saveReminders(list) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${REMINDERS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ reminders: list }, null, 2), "utf8");
  fs.renameSync(tmp, REMINDERS_FILE);
}

/** 解析时间：支持 ISO、"YYYY-MM-DD HH:mm[:ss]"（本地时区）、相对 "+90m"/"+2h"/"+3d"、纯数字（epoch 秒/毫秒） */
export function parseTime(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000; // 秒 or 毫秒
  const s = String(v).trim();
  const rel = /^\+(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[rel[2].toLowerCase()];
    return Date.now() + n * unit;
  }
  if (/^\d{10,13}$/.test(s)) return s.length === 13 ? Number(s) : Number(s) * 1000;
  // "YYYY-MM-DD HH:mm" → 本地时区 ISO
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}`).getTime();
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 本地时间格式化（用于展示） */
export function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成简短 id */
function newId() {
  return `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 新增一条提醒
 * @param {{text:string, at?:string|number, inMinutes?:number, repeatMinutes?:number, until?:string|number, target:string|number, chat?:"private"|"group", source?:string}} r
 */
export function addReminder(r) {
  const text = String(r.text ?? "").trim();
  if (!text) throw new Error("提醒内容不能为空");
  const fireAt = r.at !== undefined && r.at !== null && r.at !== ""
    ? parseTime(r.at)
    : r.inMinutes !== undefined
      ? Date.now() + Number(r.inMinutes) * 60000
      : null;
  if (!fireAt || !Number.isFinite(fireAt)) throw new Error(`无法解析提醒时间: ${r.at ?? r.inMinutes}`);
  if (!r.target) throw new Error("缺少 target（发送对象）");
  const item = {
    id: newId(),
    text,
    fireAt,
    target: String(r.target),
    chat: r.chat === "group" ? "group" : "private",
    repeatMinutes: r.repeatMinutes ? Math.max(1, Number(r.repeatMinutes)) : null,
    until: r.until !== undefined && r.until !== null && r.until !== "" ? parseTime(r.until) : null,
    done: false,
    firedCount: 0,
    createdAt: Date.now(),
    source: r.source ?? null,
  };
  const list = loadReminders();
  list.push(item);
  saveReminders(list);
  return item;
}

/** 列出提醒（默认仅未完成的） */
export function listReminders({ all = false } = {}) {
  const list = loadReminders();
  const out = all ? list : list.filter((x) => !x.done);
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

/** 取消/删除提醒：支持按 id 或 id 前缀，或 --all */
export function cancelReminder(idOrPrefix) {
  const list = loadReminders();
  const key = String(idOrPrefix ?? "").trim();
  if (!key) throw new Error("请给出提醒 id");
  const hit = key === "all" ? list : list.filter((x) => x.id === key || x.id.startsWith(key));
  if (!hit.length) return { removed: 0 };
  const ids = new Set(hit.map((x) => x.id));
  saveReminders(list.filter((x) => !ids.has(x.id)));
  return { removed: hit.length, items: hit };
}

/** 发送一条 QQ 消息（复用 send-notify.mjs，走 OneBot WS） */
export function sendQQ(target, message, chat = "private") {
  return new Promise((resolve) => {
    const args = [path.join(ROOT, "scripts", "send-notify.mjs"), String(target), String(message)];
    if (chat === "group") args.push("--group");
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 20000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: String(e?.message) }); });
  });
}

/**
 * 触发所有到期提醒。
 * @param {number} now
 * @returns {Promise<{fired:number, errors:string[]}>}
 */
export async function runDue(now = Date.now()) {
  const list = loadReminders();
  let changed = false;
  let fired = 0;
  const errors = [];
  for (const r of list) {
    if (r.done) continue;
    if (!(r.fireAt <= now)) continue;
    const res = await sendQQ(r.target, r.text, r.chat);
    if (res.code === 0) {
      fired++;
      r.firedCount = (r.firedCount ?? 0) + 1;
      r.lastFiredAt = now;
    } else {
      errors.push(`${r.id}: ${res.out.slice(0, 200)}`);
      // 发送失败重试上限：连续失败 5 次后放弃，避免消息轰炸
      r.failCount = (r.failCount ?? 0) + 1;
      if (r.failCount >= 5) { r.done = true; r.note = "发送连续失败，已停用"; }
    }
    if (!r.done) {
      if (r.repeatMinutes) {
        let next = r.fireAt + r.repeatMinutes * 60000;
        while (next <= now) next += r.repeatMinutes * 60000; // 补跑不刷屏：跳到未来最近一次
        if (r.until && next > r.until) { r.done = true; } else { r.fireAt = next; }
      } else {
        r.done = true;
      }
    }
    changed = true;
  }
  if (changed) saveReminders(list);
  return { fired, errors };
}
