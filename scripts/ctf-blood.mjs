#!/usr/bin/env node
/**
 * ctf-blood —— SUSCTF 抢血通报
 *
 * 监听各赛道的事件流（WebSocket），把「一血 / 二血 / 三血」实时通报到 QQ 群。
 *
 * 【为什么长这样】
 *  · 平台事件流：wss://ctf.seusus.com/api/event/connect?game_id=<id>&token=<event token>
 *    每帧形如 { submission: { submission:{challenge_id,team_id,solved,...},
 *                            blood_state: 1|2|3|null, operator:{account,nickname},
 *                            team:{name, game_id, score} } }
 *    blood_state: 1=一血 2=二血 3=三血 null=普通解题；award_rates [5,3,1] 即三档倍率。
 *  · **必须区分赛道**：多个赛道同时跑（新生赛 / 其他赛道），通报里写清是哪条赛道。
 *  · 口吻按人设走：口语化、猫娘语气、纯文本；**不使用书名号、不贴网址**（「」可用），不堆 Markdown。
 *  · 题名：通报要直接写题目名（不是“第 N 题”），所以需要 id→名称 映射。
 *    平台题目接口需要认证（401 + www-authenticate: Basic realm="ret2shell"），
 *    而**两个赛道题名相同、题号不同**，因此每个赛道配自己的账号：
 *      games[].account / games[].password（不填则回落顶层 platform）。
 *    拉取结果缓存到 private/ctf-blood-challenges.json，并定期刷新。
 *
 * 配置：private/ctf-blood.json（含 token，属私密数据）
 * 状态：private/state/ctf-blood-seen.json（去重，防重连后重复播报）
 * 日志：private/logs/ctf-blood.log
 *
 * 用法：node scripts/ctf-blood.mjs            # 常驻
 *       node scripts/ctf-blood.mjs --test     # 自检：连一次、打印赛道名后退出
 *       node scripts/ctf-blood.mjs --say "x"  # 发一条测试【默认私聊给 admin】
 *       node scripts/ctf-blood.mjs --say "x" --group  # 显式指定才发通报群（慎用）
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { CONFIG_PATH, PRIVATE_DIR, ROOT } from "../lib/config.mjs";

const CFG_PATH = path.join(PRIVATE_DIR, "ctf-blood.json");
const NAMES_PATH = path.join(PRIVATE_DIR, "ctf-blood-challenges.json");
const SEEN_PATH = path.join(PRIVATE_DIR, "state", "ctf-blood-seen.json");
const LOG_PATH = path.join(PRIVATE_DIR, "logs", "ctf-blood.log");
const EVENT_BASE = "wss://ctf.seusus.com/api/event/connect";
const API_BASE = "https://ctf.seusus.com/api";
const SITE = "https://ctf.seusus.com";

const argv = process.argv.slice(2);
const MODE_TEST = argv.includes("--test");
const sayIdx = argv.indexOf("--say");

// ── 依赖：OneBot 连接参数沿用主配置（单一数据源）──
const mainCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const ob = mainCfg.napcat?.onebot ?? {};

function log(msg) {
  const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); fs.appendFileSync(LOG_PATH, line + "\n"); } catch {}
}

function readCfg() {
  if (!fs.existsSync(CFG_PATH)) {
    log(`缺少配置文件 ${CFG_PATH}，退出`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
}

// ── 题名映射（id → 题目名）──
let challengeNames = {};
try { challengeNames = JSON.parse(fs.readFileSync(NAMES_PATH, "utf8")); } catch {}

/**
 * 刷新题名映射。
 * 平台题目接口要认证（Basic realm="ret2shell"），所以用配置里的 platform 账号拉。
 * 拉不到（未配账号/密码错/接口变动）就保留旧缓存，不影响通报（只是名字显示不出来）。
 */
async function refreshChallengeNames(games) {
  let changed = false;
  for (const g of games) {
    const acc = g.account ?? cfg.platform?.account;
    const pwd = g.password ?? cfg.platform?.password;
    if (!acc || !pwd) { log(`赛道 game ${g.gameId} 未配账号，跳过题名`); continue; }
    const auth = "Basic " + Buffer.from(`${acc}:${pwd}`).toString("base64");
    try {
      const r = await fetch(`${API_BASE}/game/${g.gameId}/challenge`, {
        headers: { authorization: auth, accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) { log(`题名拉取失败(game ${g.gameId}): HTTP ${r.status}`); continue; }
      const list = await r.json();
      // 平台返回可能是嵌套数组（按标签分组）如 [[{id,name},...],[...]]，这里先扁平化一层
      const flat = Array.isArray(list)
        ? list.flatMap((x) => (Array.isArray(x) ? x : [x]))
        : (list?.challenges ?? list?.data ?? []);
      const arr = (Array.isArray(flat) ? flat : []).filter((c) => c && (c.id ?? c.challenge_id));
      if (!arr.length) { log(`题名列表为空(game ${g.gameId})`); continue; }
      const map = {};
      for (const c of arr) {
        const id = String(c.id ?? c.challenge_id ?? "");
        const name = c.name ?? c.title ?? c.challenge_name;
        if (id && name) map[id] = String(name);
      }
      if (Object.keys(map).length) { challengeNames[String(g.gameId)] = map; changed = true; log(`题名已刷新(game ${g.gameId}): ${Object.keys(map).length} 题`); }
    } catch (e) {
      log(`题名拉取异常(game ${g.gameId}): ${e?.message}`);
    }
  }
  if (changed) {
    try { fs.writeFileSync(NAMES_PATH, JSON.stringify(challengeNames, null, 2)); } catch {}
  }
  return changed;
}

// ── 去重状态 ──
let seen = new Set();
try { seen = new Set(JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")).ids ?? []); } catch {}
function markSeen(id) {
  seen.add(id);
  if (seen.size > 2000) seen = new Set([...seen].slice(-1000));
  try {
    fs.mkdirSync(path.dirname(SEEN_PATH), { recursive: true });
    fs.writeFileSync(SEEN_PATH, JSON.stringify({ ids: [...seen] }));
  } catch {}
}

// ── 发消息：复用主配置里的 OneBot 地址，自己维持一条连接 ──
// 说明：默认只发群（正式通报）；--say 调试时默认改发私聊给 admin，
// 只有显式加 --group 才会发到通报群 —— 避免把测试消息打进几百人的群里。
let sendWs = null;
let sendQueue = [];
function ensureSendWs() {
  if (sendWs && sendWs.readyState === WebSocket.OPEN) return sendWs;
  const url = `ws://${ob.wsHost ?? "127.0.0.1"}:${ob.wsPort ?? 3001}/?access_token=${encodeURIComponent(ob.token ?? "")}`;
  const ws = new WebSocket(url);
  sendWs = ws;
  ws.on("open", () => {
    log("OneBot 发送通道已连接");
    const q = sendQueue; sendQueue = [];
    for (const m of q) sendText(m.message, { group: m.group });
  });
  ws.on("close", () => { sendWs = null; setTimeout(ensureSendWs, 3000).unref?.(); });
  ws.on("error", () => {});
  return ws;
}
function sendGroup(message) { sendText(message, { group: true }); }
function sendText(message, { group = true } = {}) {
  const ws = ensureSendWs();
  const params = group ? { group_id: Number(cfg.groupId), message } : { user_id: Number(cfg.debugUserId ?? 3573297011), message };
  const payload = JSON.stringify({ action: group ? "send_group_msg" : "send_private_msg", params, echo: `blood_${Date.now()}` });
  if (ws.readyState === WebSocket.OPEN) { try { ws.send(payload); } catch { sendQueue.push({ message, group }); } }
  else sendQueue.push({ message, group });
}

// ── 赛道名（启动时拉一次，拿不到就回落配置里的 label）──
async function gameName(g) {
  try {
    const r = await fetch(`${API_BASE}/game/${g.gameId}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j?.name) return j.name;
  } catch {}
  return g.label ?? `game ${g.gameId}`;
}

// ── 通报文案（猫娘口语 / 纯文本 / 无书名号 / 标明赛道）──
const BLOOD_WORD = { 1: "一血", 2: "二血", 3: "三血" };
/**
 * 取题目名：**只用本赛道自己的映射**。
 *
 * 【重要教训】两个赛道（新生赛 game 7 / 其他赛道 game 4）**题名相同、但题号不同**：
 *   同一道 [Misc] Easter Egg-2 在 game 4 是 50、在 game 7 是 129；
 *   Singing & Signin 在 game 4 是 88、在 game 7 是 140。
 * 因此**绝不能**跨赛道共用题名表（会张冠李戴）。每个赛道必须用自己的账号拉自己的列表。
 */
function challengeName(gameId, challengeId) {
  return challengeNames[String(gameId)]?.[String(challengeId)] ?? null;
}

function formatBlood({ trackName, gameId, bloodState, team, operator, challengeId, score }) {
  const head = bloodState ? BLOOD_WORD[bloodState] ?? `${bloodState}血` : "解题";
  const who = team?.name ?? operator?.nickname ?? "某队";
  const nick = operator?.nickname && operator?.nickname !== team?.name ? `（${operator.nickname}）` : "";
  // 直接写题目名（拿不到名字时才回落写题号）；题名原样输出，不再套括号（名字里自带的 [Web3] 之类保留）
  const cname = challengeName(gameId, challengeId);
  const what = cname ?? `第 ${challengeId} 题`;
  // 主人指定的五段式排版（每段一行）：
  //   喵～ / 赛道 / 出「N血」啦！ / 队伍 拿下 题名，/ 现在 X 分～
  const lines = [
    "喵～",
    trackName,
    `出「${head}」啦！`,
    `${who}${nick} 拿下 ${what}，`,
    `现在 ${score ?? "?"} 分～`,
  ];
  return lines.join("\n");
}

// ── 事件处理 ──
function handleFrame(game, raw) {
  let j = null;
  try { j = JSON.parse(raw); } catch { return; }
  const s = j?.submission;
  if (!s) return;
  const sub = s.submission ?? {};
  if (sub.solved !== true) return;
  const blood = s.blood_state ?? null;
  const id = String(sub.id ?? `${sub.team_id}-${sub.challenge_id}-${sub.created_at}`);
  if (seen.has(id)) return;
  markSeen(id);

  const wantBlood = Array.isArray(cfg.notifyBlood) ? cfg.notifyBlood : [1, 2, 3];
  const isBlood = blood !== null && wantBlood.includes(blood);
  if (!isBlood && !cfg.notifyAllSolves) return;

  const text = formatBlood({
    trackName: game.name,
    gameId: game.gameId,
    bloodState: blood,
    team: s.team,
    operator: s.operator,
    challengeId: sub.challenge_id,
    score: s.team?.score,
  });
  log(`通报 ${game.name} ${blood ? BLOOD_WORD[blood] : "解题"}: ${s.team?.name} #${sub.challenge_id}`);
  sendGroup(text);
}

// ── 各赛道事件流（断线重连）──
function watchGame(game) {
  const url = `${EVENT_BASE}?game_id=${game.gameId}&token=${encodeURIComponent(game.token)}`;
  const ws = new WebSocket(url, { rejectUnauthorized: false });
  ws.on("open", () => log(`已连接事件流: ${game.name}（game ${game.gameId}）`));
  ws.on("message", (buf) => { try { handleFrame(game, buf.toString()); } catch (e) { log(`帧处理异常: ${e?.message}`); } });
  ws.on("close", () => { log(`事件流断开(${game.name})，5s 后重连`); setTimeout(() => watchGame(game), 5000).unref?.(); });
  ws.on("error", (e) => log(`事件流错误(${game.name}): ${e?.message ?? e}`));
  return ws;
}

// ══════════ 入口 ══════════
const cfg = readCfg();
if (!cfg.groupId) { log("配置缺 groupId"); process.exit(2); }

if (sayIdx >= 0) {
  const toGroup = argv.includes("--group");
  const msg = argv.filter((a, i) => i > sayIdx + 1 && a !== "--group").join(" ") || "测试";
  log(toGroup ? "调试发送到通报群（显式 --group）" : "调试发送到私聊（默认，不打扰群）");
  ensureSendWs();
  setTimeout(() => { sendText(msg, { group: toGroup }); setTimeout(() => process.exit(0), 1500); }, 1200);
} else {
  const games = cfg.games ?? [];
  log(`启动抢血通报：${games.length} 个赛道 → 群 ${cfg.groupId}（只报 ${(cfg.notifyBlood ?? [1, 2, 3]).join("/")} 血${cfg.notifyAllSolves ? " + 普通解题" : ""}）`);
  const withNames = await Promise.all(games.map(async (g) => ({ ...g, name: await gameName(g) })));
  for (const g of withNames) log(`  赛道 game ${g.gameId}: ${g.name}`);
  // 题名（配了账号就拉，否则用缓存）
  const cached = Object.keys(challengeNames).length ? "缓存" : "无";
  const ok = await refreshChallengeNames(withNames);
  log(`  题名映射: ${ok ? "已刷新" : `用${cached}`}`);
  if (MODE_TEST) { log("自检完成（--test）"); process.exit(0); }
  // 定期刷新（赛事中会新增题目）
  setInterval(() => { refreshChallengeNames(withNames).catch(() => {}); }, 10 * 60 * 1000).unref?.();
  for (const g of withNames) watchGame(g);
  ensureSendWs();
  // 常驻：进程不退出
  setInterval(() => {}, 3600_000);
}
