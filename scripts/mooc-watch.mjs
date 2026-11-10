#!/usr/bin/env node
/**
 * 挂课看门狗 —— 按「事故」去重，一次事故只打扰一次
 *
 * 判据（每 5 分钟看一次）：
 *   · tmp/mooc/STOPPED 存在        → 挂课被拦下
 *   · loop/runner 进程没了          → 崩了或跑完了（连续 2 次检查都不在才算）
 *   · state.json 超过 15 分钟没更新  → 停滞
 *   · 任务点数字涨了                → 进度便条（有每日额度才发）
 *
 * 去重核心（2026-11-04 修，第二次同类事故）：
 *   incidentId = md5(STOPPED 内容 + state.json.updatedAt + 进程是否存活)
 *   · 同一个 incidentId 只报一次；之后数字怎么变（分钟数、停滞秒数）都不再报
 *   · 「停滞」不再按分钟数逐条刷：只在**本次事故内首次**越线（>15 分钟）报一次，写进 incident
 *   · 极端兜底：同一自然日最多发 3 条挂课相关便条，超出的只写 watch.log
 *   · 一切判断过程都写 watch.log（含被压掉的条目），便于事后核对
 *
 * 通知走 lib/notes.mjs 的便条队列，由 bridge 用自己的句柄落进会话，
 * 不跟它抢会话文件。
 *
 * 环境变量（只给自测用）：PI2X_MOOC_DIR 换沙箱目录，PI2X_MOOC_ALIVE 强制进程存活判定
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { enqueueNote } from "../lib/notes.mjs";
import { pushEvent } from "../lib/events.mjs";

const DIR = process.env.PI2X_MOOC_DIR || "<PI2X_ROOT>/tmp/mooc";
const STATE = path.join(DIR, "state.json");
const STOP = path.join(DIR, "STOPPED");
const LAST = path.join(DIR, "watcher.json");
const WLOG = path.join(DIR, "watch.log");
const TARGET = "3573297011";

const STALL_MIN = 15;          // 状态超过 15 分钟没更新 = 停滞
const DAILY_CAP = 3;           // 同一自然日最多 3 条挂课便条
const PROGRESS_CAP_RESERVE = 1; // 进度便条只在当天额度还有余量时发（给事故留一条）

const now = Date.now();
const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
function wlog(msg) {
  const d = new Date();
  const t = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  try { fs.appendFileSync(WLOG, `[${t}] ${msg}\n`); } catch {}
}

const last = readJson(LAST) ?? {};
if (!last.incident) last.incident = { id: null, firstSeenAt: 0, reported: {} };
if (!last.incident.reported) last.incident.reported = {};
if (last.day !== today()) { last.day = today(); last.dayNotes = 0; }
if (!Number.isFinite(last.dayNotes)) last.dayNotes = 0;
if (!Number.isFinite(last.loopMiss)) last.loopMiss = 0;

const st = readJson(STATE);
if (!st) { wlog("没有 state.json = 没在挂课，什么也不做"); process.exit(0); }

/* ------------------------- 进程存活（loop / runner 任一在跑就算活） ------------------------- */
let alive = false;
if (process.env.PI2X_MOOC_ALIVE === "1") alive = true;
else if (process.env.PI2X_MOOC_ALIVE === "0") alive = false;
else {
  try {
    const out = execSync("pgrep -fa 'mooc-loop.sh|mooc-runner.mjs' || true", { encoding: "utf8" });
    alive = out.split("\n").some((l) => /mooc-loop\.sh|mooc-runner\.mjs/.test(l) && !/pgrep|mooc-watch/.test(l));
  } catch { alive = false; }
}

/* ------------------------------- incidentId：事故指纹 ------------------------------- */
let stopBody = "";
try { if (fs.existsSync(STOP)) stopBody = fs.readFileSync(STOP, "utf8").trim(); } catch {}
const fingerprint = [stopBody, String(st.updatedAt ?? ""), alive ? "alive" : "dead"].join("\u0001");
const incidentId = crypto.createHash("md5").update(fingerprint).digest("hex");

const isNewIncident = last.incident.id !== incidentId;
if (isNewIncident) {
  wlog(`新事故 ${incidentId.slice(0, 10)}（旧=${(last.incident.id || "无").slice(0, 10)}）：STOPPED=${stopBody ? stopBody.replace(/\s+/g, " ").slice(0, 80) : "(无)"} updatedAt=${st.updatedAt} 存活=${alive}`);
  last.incident = { id: incidentId, firstSeenAt: now, reported: {} };
  last.loopMiss = 0;
  last.loopGoneReported = false;
}

const inc = last.incident;
const alerts = [];

/* --------------------------- 1. STOPPED：同一事故只报一次 --------------------------- */
if (stopBody && !inc.reported.stopped) {
  alerts.push(`挂课已停止：${stopBody.replace(/\s+/g, " ").slice(0, 300)}`);
  inc.reported.stopped = now;
  wlog(`报 STOPPED（事故 ${incidentId.slice(0, 10)}，首次）`);
}

/* --------------------- 2. 进程没了：连续 2 次检查都不在才报一次 --------------------- */
if (!alive) {
  last.loopMiss += 1;
  if (last.loopMiss >= 2 && !stopBody && !inc.reported.loopGone) {
    alerts.push("挂课的 loop 进程连续两次检查都不在了（崩溃或被停）");
    inc.reported.loopGone = now;
    wlog(`报 loop 不在（事故 ${incidentId.slice(0, 10)}）`);
  } else if (last.loopMiss < 2) {
    wlog(`loop 不在（第 ${last.loopMiss} 次，未连续 2 次，先不报）`);
  }
} else {
  last.loopMiss = 0;
  inc.reported.loopGone = 0;
}

/* --------------- 3. 停滞：本次事故内只在首次越线时报一次，之后一律不报 --------------- */
const updated = Date.parse(String(st.updatedAt ?? "").replace(" ", "T"));
if (Number.isFinite(updated) && now - updated > STALL_MIN * 60_000) {
  const mins = Math.round((now - updated) / 60000);
  if (!inc.reported.stall) {
    alerts.push(`状态已经 ${mins} 分钟没更新，可能卡死（本事故只提醒这一次）`);
    inc.reported.stall = now;
    inc.stalledMinutesAtFirstReport = mins;
    wlog(`报停滞首越线 ${mins} 分钟（事故 ${incidentId.slice(0, 10)}）`);
  } else {
    wlog(`停滞 ${mins} 分钟：同一事故已提醒过，压掉（不刷屏）`);
  }
} else if (!inc.reported.stall) {
  wlog("状态新鲜（未越 15 分钟线）");
}

/* ------------------------ 4. 进度便条：要有额度，且真涨了才发 ------------------------ */
const points = Number((st.progressText ?? "").match(/(\d+)\s*\/\s*(\d+)/)?.[1] ?? 0);
const progressDue = points > (last.lastPoints ?? 0) && now - (last.lastReportAt ?? 0) > 60 * 60 * 1000;
if (progressDue) {
  if (last.dayNotes + alerts.length < DAILY_CAP - PROGRESS_CAP_RESERVE + 1) {
    alerts.push(`进度播报：任务点 ${st.progressText}（已播 ${st.playedVideos ?? "?"} 个视频）`);
    last.lastReportAt = now;
    wlog(`报进度 ${points}`);
  } else {
    wlog(`进度 ${points} 想报，但当天额度不足，压掉`);
  }
}

/* ------------- 5. 出事 → 推事件（走 Trigger 链，让 Router 被唤醒，而不是只发条消息） -------------
 * 便条是「给人看的」，事件是「给调度器看的」。卡死这类事必须两条都走：
 * 便条让人知道，事件让 Router 被叫醒去处理（自动重启/排查），否则就又变成昨天那种
 * 「检测到了、也报了，但没人管」。
 */
if (alerts.length) {
  const evKey = inc.reported.stopped ? "mooc:stopped"
    : !alive ? "mooc:loop-gone"
    : inc.reported.stall ? "mooc:stall"
    : "mooc:progress";
  const isIncident = evKey !== "mooc:progress";
  if (isIncident) {
    try {
      pushEvent({
        type: "mooc",
        key: evKey,
        text: alerts.join("；"),
        meta: { incidentId, video: st.currentVideo ?? "", progress: st.progress ?? "", points },
      });
      wlog(`推事件 ${evKey}（事故 ${incidentId.slice(0, 10)}）`);
    } catch (e) {
      wlog("推事件失败：" + (e && e.message));
    }
  }
}

/* --------------------------------- 发送（含每日额度） --------------------------------- */
if (alerts.length) {
  const text = `【挂课】${alerts.join("；")}`;
  if (last.dayNotes >= DAILY_CAP) {
    wlog(`[额度用尽 ${last.dayNotes}/${DAILY_CAP}] 只写日志不发便条：${text}`);
  } else {
    try {
      enqueueNote({ chat: "private", target: TARGET, kind: "reminder", text });
      last.dayNotes += 1;
      wlog(`发便条 ${last.dayNotes}/${DAILY_CAP}：${text}`);
    } catch (e) {
      wlog(`便条入队失败（不影响下次检查）：${e && e.message}`);
    }
  }
} else {
  wlog(`无事发生（事故 ${incidentId.slice(0, 10)} 已报：${Object.keys(inc.reported).join(",") || "无"}）`);
}

last.lastPoints = points;
last.lastCheckAt = now;
try { fs.writeFileSync(LAST, JSON.stringify(last, null, 1)); } catch (e) { wlog("写 watcher.json 失败：" + e.message); }
