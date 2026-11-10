#!/usr/bin/env node
/**
 * mooc-runner.mjs —— 超星《2026秋-创新创业基础》视频任务点常驻推进器
 *
 * 只做一件事：按章节顺序找第一个「未完成」的视频任务点，正常 1x 播到 video 真正 ended，
 * 且容器出现 ans-job-finished（平台确认上报），回章节页确认该节点真变成已完成，才移动 cursor。
 *
 * 完成判据（2026-11-04 修）：不再用「≥95% 时长」，必须 ended + ans-job-finished 双条件；
 * ended 后 30s 容器仍无 ans-job-finished = 上报失败 → 重载该节点重播剩余部分，最多 3 次，
 * 3 次仍失败记 skipped（源异常/上报失败）后继续，不死等。
 * 测验节点（节点页无 videoContainer、只有 quiz/vote 等挂件）一律跳过并记日志，绝不点开答题。
 *
 * 硬约束（代码里也钉死）：
 *   · 只播 1 倍速，不改 playbackRate
 *   · 不拖时间轴（全程不写 currentTime），不静音（不碰 muted/volume）
 *   · 只碰这一门课，其他课程一概不导航
 *   · 检测到滑块/人脸/验证码/「异常」提示 → 立刻停，日志记原因，退出码 3
 *   · 进度停滞保护（2026-11-04 修）：连续 --stall-min（默认 3）分钟 currentTime 不增长
 *     → 先按三步自愈（reload+继续 / 重开章节页重进 / 清 Chrome 重建再进），每次自愈后重置停滞计时；
 *     三步都救不回来才判定「源异常」：日志记 `SKIP <标题> 源异常` 并跳到下一个节点，
 *     同一轮里第二个节点也这样才退出码 4，STOPPED 里写最后一次的 currentTime/readyState/video.error/paused
 *
 * 浏览器隔离：默认走 :9333 的独立实例（profile 在 <PI2X_ROOT>/tmp/mooc/profile），
 * 不再占用管理员的 9222 实例。启动方式见 <PI2X_ROOT>/tmp/mooc/start-chrome.sh。
 *
 * 用法：node <PI2X_ROOT>/scripts/mooc-runner.mjs [--minutes 45] [--port 9333]
 * 日志：<PI2X_ROOT>/tmp/mooc/runner.log（每行带时间戳）
 * 状态：<PI2X_ROOT>/tmp/mooc/state.json
 * 退出码：0=时间预算到 / 2=browser-cli 看门狗超时 / 3=验证码异常 / 4=卡住（自愈全失败）/
 *         5=需要人工介入（连续 3 次 video 恢复失败 / 任务点不涨）/ 6=掉线（跳到登录页）/ 1=其它错误
 *
 * video 元素消失自愈：先截图 + dump url/title/可见文字，再确保 :9333 上是挂课专用 Chrome
 * （browser-cli 会在端口空掉时用 browser-profile-op 偷偷补一只别的 Chrome，必须清掉重起），
 * 然后重新打开同一章节继续播；连续 3 次恢复不了才退出码 5，并把最后一屏写进 STOPPED。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLI = "<PI2X_ROOT>/scripts/browser-cli.mjs";
const CHROME_PROFILE = "<PI2X_ROOT>/tmp/mooc/profile";
const OUT_DIR = "<PI2X_ROOT>/tmp/mooc";
const LOG_PATH = path.join(OUT_DIR, "runner.log");
const STATE_PATH = path.join(OUT_DIR, "state.json");
const SKIP_PATH = path.join(OUT_DIR, "skipped.json"); // 判定源异常、跳过不再重试的节点
const COURSE_NAME = "2026秋-创新创业基础";

// 已知课程标识（发现流程失败时兜底用）
const FALLBACK = { courseId: "267796608", clazzId: "156514940", cpi: "537306069" };

const argv = process.argv.slice(2);
function argNum(name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const minutes = argNum("--minutes", 60);
const PORT = argNum("--port", 9333); // 默认独立实例；切勿再用 9222（管理员实例）
const STALL_MIN = argNum("--stall-min", 3); // 连续 N 分钟 currentTime 不增长 → 触发自愈
const STALL_LIMIT_MS = STALL_MIN * 60_000;
const HEAL_MAX = 3; // 停滞自愈最多 3 招（reload / 重开章节页 / 重建 Chrome）
const REPORT_WAIT_MS = 30_000; // video ended 后等 ans-job-finished 的窗口
const REPORT_MAX = 3;          // 上报失败最多重载重播次数
const VERIFY_MAX = 3;          // 播完后回章节页确认（含重播重试）上限
const deadline = Date.now() + minutes * 60_000;

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------------------------------- 日志与状态 ---------------------------------- */

const pad = (n) => String(n).padStart(2, "0");
function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch {}
  console.log(line);
}

// autoRestartCount 由 mooc-loop.sh 维护（自动重试次数），runner 重启后要沿用
const prevState = (() => { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; } })();

const state = {
  pid: process.pid,
  startedAt: ts(),
  port: PORT,
  chromeProfile: CHROME_PROFILE,
  minutesBudget: minutes,
  stallLimitMin: STALL_MIN,
  currentVideo: null,
  lastStallAt: null,        // 最近一次停滞被判定的时刻
  healCount: 0,             // 本次 run 累计自愈次数
  autoRestartCount: Number(prevState.autoRestartCount ?? 0), // loop 自动重试次数
  progress: "",
  progressPercent: 0,
  completedPoints: null,
  totalPoints: null,
  progressText: "",
  playedVideos: 0,
  phase: "starting",
  updatedAt: ts(),
};
function saveState(patch = {}) {
  Object.assign(state, patch);
  state.updatedAt = ts();
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1)); } catch (e) { log("写 state.json 失败: " + e.message); }
}
saveState();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsedMin = () => ((Date.now() - (deadline - minutes * 60_000)) / 60_000).toFixed(1);
const outOfTime = () => Date.now() >= deadline;

/* ------------------------- 浏览器健康检查与自愈 ------------------------- */

const RECOVER_MAX = 3; // 连续 3 次恢复失败才退出（退出码 5）

/** 找出 :PORT 上的 Chrome 主进程（排除 --type= 子进程），带 user-data-dir */
function chromeMainPids() {
  let out = "";
  try {
    out = spawnSync("bash", ["-lc", `pgrep -f 'remote-debugging-port=${PORT}' || true`], { encoding: "utf8" }).stdout || "";
  } catch {}
  return out
    .split("\n").map((s) => s.trim()).filter(Boolean).map(Number).filter((p) => p > 0 && p !== process.pid)
    .map((p) => {
      let cmd = "";
      try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch {}
      const m = cmd.match(/--user-data-dir=(\S+)/);
      return { pid: p, cmd, profile: m ? m[1] : "", main: !cmd.includes("--type=") };
    })
    .filter((x) => x.main && x.cmd.includes("chrome"));
}

/**
 * 确保 :PORT 上跑的是「挂课专用 profile」的 Chrome。
 * 关键：browser-cli 在端口无人监听时会用 browser-profile-op 自动补一只 Chrome，
 * 那只没有挂课登录态，页面直接是 about:blank —— 必须清掉，否则挂课永远恢复不了。
 */
function ensureMoocChrome(tag = "") {
  const want = CHROME_PROFILE.replace(/\/+$/, "");
  const mains = chromeMainPids();
  const mine = mains.find((m) => m.profile.replace(/\/+$/, "") === want);
  if (mine) return { ok: true, pid: mine.pid, restarted: false };

  for (const m of mains) {
    if (m.profile.replace(/\/+$/, "") === want) continue;
    log(`${tag} :${PORT} 上跑的不是挂课用的 Chrome（pid=${m.pid} profile=${m.profile || "默认"}），清掉`);
    try { spawnSync("kill", ["-TERM", String(m.pid)]); } catch {}
    for (let i = 0; i < 16; i++) {
      if (!fs.existsSync(`/proc/${m.pid}`)) break;
      spawnSync("sleep", ["0.5"]);
    }
    try { if (fs.existsSync(`/proc/${m.pid}`)) spawnSync("kill", ["-9", String(m.pid)]); } catch {}
    const gone = (() => { try { return !fs.existsSync(`/proc/${m.pid}`); } catch { return true; } })();
    log(`${tag} 清掉 pid=${m.pid}：${gone ? "已退出" : "仍在（可能僵死）"}`);
  }

  log(`${tag} 启动挂课专用 Chrome（profile=${CHROME_PROFILE}）`);
  const r = spawnSync("bash", [path.join(OUT_DIR, "start-chrome.sh")], { encoding: "utf8", timeout: 60000 });
  const ok = r.status === 0;
  if (!ok) log(`${tag} start-chrome.sh 失败（code=${r.status}）：${((r.stderr || "") + (r.stdout || "")).trim().slice(0, 240)}`);
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(OUT_DIR, "chrome.pid"), "utf8").trim()) || 0; } catch {}
  return { ok, pid, restarted: true };
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 把 :PORT 上的挂课 Chrome 全部杀掉（自愈第 3 招用），再交给 ensureMoocChrome 重建 */
function killMoocChrome(tag = "") {
  let killed = 0;
  for (const m of chromeMainPids()) {
    log(`${tag} 杀 Chrome pid=${m.pid}（profile=${m.profile || "默认"}）`);
    try { spawnSync("kill", ["-TERM", String(m.pid)]); } catch {}
    killed++;
    for (let i = 0; i < 12; i++) {
      if (!fs.existsSync(`/proc/${m.pid}`)) break;
      spawnSync("sleep", ["0.5"]);
    }
    try { if (fs.existsSync(`/proc/${m.pid}`)) spawnSync("kill", ["-9", String(m.pid)]); } catch {}
  }
  // 端口还残留会话就一并抹掉，避免 browser-cli 连到旧实例
  try { spawnSync("bash", ["-lc", `pkill -f 'remote-debugging-port=${PORT}' || true`]); } catch {}
  spawnSync("sleep", ["1.5"]);
  log(`${tag} 已清理 Chrome ${killed} 个`);
  return killed;
}

/* ----------------------------- 停滞快照与自愈（自愈三步） ----------------------------- */

/** 把一次 video 现场拍成一行，日志和 STOPPED 都用它 */
function snapLine(s = {}) {
  const err = s.err ? `video.error=${s.err.code}${s.err.msg ? "/" + s.err.msg : ""}` : "video.error=null";
  return `currentTime=${Math.round(s.ct ?? 0)}s readyState=${s.ready ?? 0} ${err} paused=${s.paused} net=${s.net ?? "?"} buf=${s.buf ?? "?"}`;
}

/** 停滞自愈：①②③ 依次试，返回 true=认为页面又有可能接着播了 */
async function healStall(c, node, n, snap) {
  log(`【自愈#${n}】开始（${node.title}，${snapLine(snap)}）`);
  saveState({ phase: "healing", healAttempts: n, healSnap: snap });
  try {
    if (n === 1) {
      // ① 当前页 reload 后重新点继续
      log(`【自愈#1】reload 当前页`);
      try {
        jsRaw(`(()=>{setTimeout(()=>location.reload(),80);return 'reloading'})()`, 20);
      } catch (e) { log(`【自愈#1】reload 调用失败（继续用导航兵刀）：${e.message}`); }
      await sleep(7000);
    } else if (n === 2) {
      // ② 重开章节页，找到该节点重进
      log(`【自愈#2】重开章节页重进节点`);
      await nav(cardsUrl(c, node.kid));
      await sleep(3500);
      for (let i = 0; i < 8; i++) {
        if (Number(jsRaw("document.querySelectorAll('.ans-attach-ct').length")) > 0) break;
        await sleep(1500);
      }
    } else {
      // ③ 清掉 Chrome 实例重建再进
      log(`【自愈#3】清掉 :${PORT} 的 Chrome 并重建`);
      killMoocChrome("【自愈#3】");
      const br = ensureMoocChrome("【自愈#3】");
      if (!br.ok) { log(`【自愈#3】重建 Chrome 失败`); return false; }
      await sleep(3000);
      await nav(cardsUrl(c, node.kid));
      await sleep(3500);
      for (let i = 0; i < 8; i++) {
        if (Number(jsRaw("document.querySelectorAll('.ans-attach-ct').length")) > 0) break;
        await sleep(1500);
      }
    }

    const probe = jsJson(PROBE_EXPR);
    if (probe.captcha) throw new Stop(3, `自愈#${n} 时出现验证/异常提示 → ${probe.captcha}`);
    const v = probe.videos.find((x) => !x.fin) || probe.videos[0];
    if (!v) { log(`【自愈#${n}】页面里没有 video 元素`); return false; }
    if (v.fin) { log(`【自愈#${n}】容器已标记完成`); return true; }

    const p = await cdp.eval(PLAY_EXPR, { gesture: true });
    if (!p || p.err) { log(`【自愈#${n}】重试播放失败：${p ? p.err : "无返回"}`); return false; }
    log(`【自愈#${n}】已重新点播：ct=${Math.round(p.ct)}s dur=${Math.round(p.dur || 0)}s paused=${p.paused} msg=${p.msg}`);
    return true;
  } catch (e) {
    if (e instanceof Stop) throw e;
    log(`【自愈#${n}】异常：${e && e.message ? e.message : e}`);
    return false;
  }
}

/* ---------------------------- 源异常节点：记下来别再撞 ---------------------------- */

function loadSkipped() {
  const d = readJsonSafe(SKIP_PATH);
  return d && typeof d === "object" && d.nodes ? d.nodes : {};
}
function markSkipped(node, snap, why) {
  const nodes = loadSkipped();
  nodes[node.kid] = { title: node.title, at: ts(), reason: why, snap: snapLine(snap) };
  try { fs.writeFileSync(SKIP_PATH, JSON.stringify({ nodes }, null, 1)); } catch (e) { log("写 skipped.json 失败：" + e.message); }
}
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

/** 已确认完成的节点缓存：验证通过后记下来，后续扫描不再重复开节点页 */
const DONE_PATH = SKIP_PATH.replace(/skipped\.json$/, "done_nodes.json");
function loadDone() {
  const d = readJsonSafe(DONE_PATH);
  return d && typeof d === "object" && d.nodes ? d.nodes : {};
}
function markDone(node) {
  const nodes = loadDone();
  nodes[node.kid] = { title: node.title, at: ts() };
  try { fs.writeFileSync(DONE_PATH, JSON.stringify({ nodes }, null, 1)); } catch (e) { log("写 done_nodes.json 失败：" + e.message); }
}

/** 非视频节点（测验/问卷/阅读）缓存：记下来就别反复打开 */
const NONVIDEO_PATH = SKIP_PATH.replace(/skipped\.json$/, "nonvideo.json");
function loadNonVideo() {
  const d = readJsonSafe(NONVIDEO_PATH);
  return d && typeof d === "object" && d.nodes ? d.nodes : {};
}
function markNonVideo(node, why) {
  const nodes = loadNonVideo();
  if (nodes[node.kid] === why) return;
  nodes[node.kid] = why;
  try { fs.writeFileSync(NONVIDEO_PATH, JSON.stringify({ nodes }, null, 1)); } catch (e) { log("写 nonvideo.json 失败：" + e.message); }
}

/** 抓现场：截图 + url/title/可见文字前 200 字，落日志与 state.json */
function captureScreen(reason) {
  const png = path.join(OUT_DIR, `crash-${stamp()}.png`);
  let shot = null;
  try { cli(["screenshot", png], 60); shot = png; } catch (e) { log(`截图失败：${e.message}`); }
  let url = "", title = "", text = "";
  try {
    const d = jsJson(`(() => {
      const t = document.body ? (document.body.innerText || "") : "";
      let f = "";
      try { for (const x of document.querySelectorAll("iframe")) { const b = x.contentDocument && x.contentDocument.body; if (b) f += " [iframe]" + (b.innerText || ""); } } catch (e) {}
      return { url: location.href, title: document.title, text: (t + f).replace(/\\s+/g, " ").trim().slice(0, 200) };
    })()`);
    url = d.url || ""; title = d.title || ""; text = d.text || "";
  } catch (e) { log(`读取屏幕内容失败：${e.message}`); }
  log(`【现场】${reason} → 截图 ${shot || "(失败)"}`);
  log(`【现场】url=${url || "(空)"}`);
  log(`【现场】title=${title || "(空)"}`);
  log(`【现场】可见文字=${text || "(空)"}`);
  saveState({ lastScreen: { at: ts(), reason, screenshot: shot, url, title, text } });
  return { png: shot, url, title, text };
}

/** about:blank / chrome-error → 浏览器没了；passport → 掉线；其它 → 页面被换了 */
function classifyGone(ev) {
  const u = (ev && ev.url) || "";
  if (!u || u === "about:blank" || /^(chrome|edge)-error:/.test(u)) return "browser-lost";
  if (/passport|\/login|sso\.|i\.chaoxing\.com\/login/i.test(u)) return "session-lost";
  try { const h = new URL(u).host; if (h && !/(^|\.)chaoxing\.com$/.test(h)) return "browser-lost"; } catch { return "browser-lost"; }
  return "page-changed";
}

/* ------------------------------ browser-cli 封装 ------------------------------ */

function cli(args, timeoutSec = 90) {
  const r = spawnSync(
    "node",
    [CLI, "--port", String(PORT), "--timeout", String(timeoutSec * 1000), ...args],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: (timeoutSec + 30) * 1000 }
  );
  const out = (r.stdout || "").trim();
  if (r.status !== 0) {
    const err = (out || r.stderr || "").slice(0, 400);
    // 码 2 = browser-cli 命令行级看门狗超时（页面没响应），交给外层 loop 重试
    if (r.status === 2) throw new Stop(2, `browser-cli ${args[0]} 看门狗超时: ${err}`);
    throw new Error(`browser-cli ${args[0]} 失败(code=${r.status}): ${err}`);
  }
  return out;
}
function jsRaw(expr, timeoutSec = 60) {
  return cli(["js", expr], timeoutSec);
}
function jsJson(expr, timeoutSec = 60) {
  const out = jsRaw(expr, timeoutSec);
  try { return JSON.parse(out); } catch { throw new Error("JS 返回非 JSON: " + out.slice(0, 300)); }
}
async function nav(url) {
  const out = cli(["navigate", url], 120);
  let info = null;
  try { info = JSON.parse(out); } catch {}
  await sleep(1200);
  return info;
}

/* ----------------------- 最小 CDP 通道：只为「可信手势」触发播放 -----------------------
 * 无头 Chrome 默认拦截无用户手势的 play()（NotAllowedError）。
 * 平台播放器本身也走 video.play()，所以我们用 CDP Runtime.evaluate 的
 * userGesture=true 给它一次真实用户激活，等价于用户点了播放键；
 * 不改倍速、不跳时间轴、不动音量。
 */
class Cdp {
  constructor(port) { this.base = `http://127.0.0.1:${port}`; this.ws = null; this.seq = 0; this.pending = new Map(); }
  async connect() {
    if (this.ws && this.ws.readyState === 1) return;
    const list = await fetch(this.base + "/json/list", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const page = (list || []).find((t) => t.type === "page");
    if (!page) throw new Error("没有可用标签页");
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("CDP 连接超时")), 8000);
      this.ws.onopen = () => { clearTimeout(t); res(); };
      this.ws.onerror = () => { clearTimeout(t); rej(new Error("CDP 连接失败")); };
    });
    this.ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.rej(new Error(`CDP ${m.error.code}: ${m.error.message}`)) : p.res(m.result);
    };
    this.ws.onclose = () => { this.ws = null; };
  }
  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((res, rej) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error("CDP 超时: " + method)); }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, { gesture = false, timeoutMs = 25000 } = {}) {
    await this.connect();
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: gesture }, timeoutMs);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || "JS 异常").slice(0, 300));
    return r.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}
const cdp = new Cdp(PORT);

/* --------------------------------- 页面探测脚本 --------------------------------- */

/** 找出 iframe 里的 video 元素 + 判断容器是否 ans-job-finished + 扫描验证/异常提示 */
const PROBE_EXPR = `(() => {
  const capKw = ["检测到异常","访问异常","异常行为","请完成验证","安全验证","请输入验证码","滑动验证","拖动滑块","人脸识别","人脸验证","身份验证","扫码验证"];
  const capSel = [".yzm",".captcha","#captcha",".face-verify",".nc-container",".verifycode",".slider-verify","iframe[src*=captcha]","iframe[src*=verify]"];
  let captcha = null;
  const scan = (doc, where) => {
    if (!doc || captcha) return;
    let txt = "";
    try { txt = doc.body ? (doc.body.innerText || "") : ""; } catch (e) {}
    for (const k of capKw) { if (txt.indexOf(k) >= 0) { captcha = where + ":" + k; return; } }
    for (const s of capSel) { try { if (doc.querySelector(s)) { captcha = where + ":选择器 " + s; return; } } catch (e) {} }
  };
  scan(document, "top");
  const ifs = [...document.querySelectorAll("iframe")].filter(f => (f.src || "").indexOf("ananas/modules/video") >= 0);
  const videos = ifs.map((f, i) => {
    let fin = false, p = f.parentElement;
    for (let k = 0; k < 5 && p; k++) {
      const c = (p.className || "") + "";
      if (c.indexOf("videoContainer") >= 0) { fin = c.indexOf("ans-job-finished") >= 0; break; }
      p = p.parentElement;
    }
    let doc = null, v = null;
    try { doc = f.contentDocument; v = doc ? doc.querySelector("video") : null; } catch (e) {}
    scan(doc, "video-iframe");
    return {
      i, fin, hasVideo: !!v,
      ct: v ? Math.round((v.currentTime || 0) * 10) / 10 : 0,
      dur: v && isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0,
      paused: v ? v.paused : null,
      ended: v ? v.ended : null,
      rate: v ? v.playbackRate : null,
      muted: v ? v.muted : null,
      ready: v ? v.readyState : 0,
      net: v ? v.networkState : null,
      err: v && v.error ? { code: v.error.code, msg: String(v.error.message || "").slice(0, 160) } : null,
      src: v ? String(v.currentSrc || v.src || "").slice(0, 200) : "",
      buf: v && v.buffered && v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1) * 10) / 10 : 0,
    };
  });
  return { videos, captcha, url: location.href };
})()`;

/** 触发播放（可信手势）。只播放，不跳转、不变速、不静音 */
const PLAY_EXPR = `(async () => {
  const ifs = [...document.querySelectorAll("iframe")].filter(f => (f.src || "").indexOf("ananas/modules/video") >= 0);
  let target = null;
  for (const f of ifs) {
    let p = f.parentElement, fin = false;
    for (let k = 0; k < 5 && p; k++) {
      const c = (p.className || "") + "";
      if (c.indexOf("videoContainer") >= 0) { fin = c.indexOf("ans-job-finished") >= 0; break; }
      p = p.parentElement;
    }
    if (!fin) { target = f; break; }
  }
  if (!target) return { err: "no-unfinished-video" };
  const v = target.contentDocument && target.contentDocument.querySelector("video");
  if (!v) return { err: "no-video-element" };
  let msg = "ok";
  try { if (v.paused) await v.play(); } catch (e) { msg = e.name + ":" + e.message; }
  await new Promise(r => setTimeout(r, 2000));
  return { msg, ct: v.currentTime, dur: v.duration, paused: v.paused, rate: v.playbackRate, muted: v.muted };
})()`;

/** 节点页分类：视频任务点 vs 非视频任务点（测验/问卷/阅读），不看章节列表的待完成数 */
const CLASSIFY_EXPR = `(() => {
  const cs = [...document.querySelectorAll('.ans-attach-ct')];
  const vids = [], others = [];
  for (const e of cs) {
    const cls = (e.className || '') + '';
    const icons = [...e.querySelectorAll('[class*=ans-job]')].map(x => (x.className || '') + '');
    const ifs = [...e.querySelectorAll('iframe')].map(f => f.src || '');
    const isVideo = cls.indexOf('videoContainer') >= 0 || icons.some(i => i.indexOf('ans-job-video') >= 0) || ifs.some(s => s.indexOf('ananas/modules/video') >= 0);
    const fin = cls.indexOf('ans-job-finished') >= 0;
    const mod = (ifs.find(s => s.indexOf('ananas/modules/') >= 0) || '').replace(/.*ananas\\/modules\\//, '').split('/').slice(0, 2).join('/');
    if (isVideo) vids.push({ fin, cls });
    else others.push({ mod, txt: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) });
  }
  return { n: cs.length, hasVideo: vids.length > 0, videoFinished: vids.length > 0 && vids.every(v => v.fin), vids, others, url: location.href };
})()`;

/* ---------------------------------- 主流程 ---------------------------------- */

class Stop extends Error {
  constructor(code, reason) { super(reason); this.code = code; this.reason = reason; }
}
/** video 元素消失（不是主动停机），带现场证据，由 playOne 负责自愈 */
class VideoGone extends Error {
  constructor(evidence) { super("video 元素消失"); this.evidence = evidence; this.playedSec = 0; }
}
/** currentTime 长时间不涨（先自愈，自愈全失败才判定源异常），带现场快照 */
class Stalled extends Error {
  constructor(snap) { super(`currentTime 停在 ${Math.round(snap.ct)}s`); this.snap = snap; }
}
/** 自愈三步全部无效 → 节点源异常，交给 main 决定跳过还是停机 */
class Unfixable extends Error {
  constructor(msg, snap) { super(msg); this.snap = snap; }
}
/** 上报反复失败（ended 但平台不记完成）→ 记 skipped 后继续，不死等 */
class ReportDead extends Error {
  constructor(msg, snap) { super(msg); this.snap = snap; }
}

async function fetchNodes() {
  const data = jsJson(`(() => {
    const items = [...document.querySelectorAll(".chapter_item[id]")];
    const nodes = items.map(it => {
      const kid = it.id.replace(/^cur/, "");
      const titleEl = it.querySelector(".catalog_name");
      const title = (titleEl ? titleEl.innerText : "").replace(/\\s+/g, " ").trim();
      const jobEl = it.querySelector(".knowledgeJobCount");
      // 真区分「视频节点 vs 测验/阅读/问卷节点」：节点标题下/图标区有无视频标记
      const videoIcon = !!it.querySelector('[class*=ans-job-video],[class*=videoContainer],[class*=catalog_video]');
      const quizHint = /测验|测试|阅读|问卷|讨论|作业/.test(title);
      return { kid, title, job: jobEl ? Number(jobEl.value || 0) : 0, videoIcon, quizHint };
    });
    const t = document.body ? (document.body.innerText || "") : "";
    const m = t.match(/已完成任务点[:：]?\\s*(\\d+)\\s*\\/\\s*(\\d+)/);
    return { nodes, done: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, title: document.title };
  })()`);
  return data;
}

async function readProgress(label, { expectAbove = null } = {}) {
  let d = await fetchNodes();
  // 平台计数偶尔延迟几秒；没涨就再等一拍
  if (expectAbove !== null && d.done !== null && d.done <= expectAbove) {
    await sleep(10000);
    d = await fetchNodes();
  }
  const text = d.done !== null ? `已完成任务点: ${d.done}/${d.total}` : "未读到任务点计数";
  log(`${label} ${text}`);
  saveState({ completedPoints: d.done, totalPoints: d.total, progressText: `已完成任务点 ${d.done}/${d.total}` });
  return d;
}

async function discover() {
  saveState({ phase: "discovering" });
  log("发现课程入口：打开 i.chaoxing.com");

  let entry = null;
  try {
    await nav("https://i.chaoxing.com");
    await sleep(2000);
    const info = jsJson(`(() => {
      const links = [], frames = [];
      document.querySelectorAll("iframe").forEach(f => frames.push(f.src || ""));
      for (const f of document.querySelectorAll("iframe")) {
        try {
          const d = f.contentDocument; if (!d) continue;
          d.querySelectorAll("a").forEach(a => {
            const t = (a.innerText || "").replace(/\\s+/g, " ").trim();
            if (t && a.href) links.push({ t: t.slice(0, 50), h: a.href });
          });
        } catch (e) {}
      }
      return { links, frames };
    })()`);
    entry = (info.links.find((l) => l.t.indexOf(COURSE_NAME) >= 0) || {}).h || null;
    if (!entry) {
      const src = (info.frames || []).find((s) => s.indexOf("courselist") >= 0);
      if (src) {
        log("课程卡片不在可读 iframe 里，直接打开课程列表页");
        await nav(src);
        await sleep(2000);
        const info2 = jsJson(`(() => {
          const links = [];
          document.querySelectorAll("a").forEach(a => {
            const t = (a.innerText || "").replace(/\\s+/g, " ").trim();
            if (t && a.href) links.push({ t: t.slice(0, 50), h: a.href });
          });
          return { links };
        })()`);
        entry = (info2.links.find((l) => l.t.indexOf(COURSE_NAME) >= 0) || {}).h || null;
      }
    }
  } catch (e) {
    log("课程列表读取失败：" + e.message);
  }
  if (!entry) throw new Stop(1, "在课程列表里没找到《" + COURSE_NAME + "》");

  log("进入课程：" + entry.slice(0, 120));
  await nav(entry.startsWith("http") ? entry : "https://v24.chaoxing.com" + entry);
  await sleep(2000);

  const cur = jsJson(`(() => {
    const stu = [...document.querySelectorAll("iframe")].map(f => f.src || "").find(s => s.indexOf("studentcourse") >= 0) || null;
    return { url: location.href, title: document.title, stuSrc: stu };
  })()`);
  log(`课程页：${cur.title || "(无标题)"}`);
  if (cur.title && cur.title.indexOf(COURSE_NAME) < 0) throw new Stop(1, "进的不是《" + COURSE_NAME + "》，停止：" + cur.title);

  let courseId = FALLBACK.courseId, clazzId = FALLBACK.clazzId, cpi = FALLBACK.cpi;
  try {
    const u = new URL(cur.url);
    courseId = u.searchParams.get("courseid") || courseId;
    clazzId = u.searchParams.get("clazzid") || clazzId;
    cpi = u.searchParams.get("cpi") || cpi;
  } catch {}

  let stuUrl = cur.stuSrc;
  if (!stuUrl) {
    const enc = (() => { try { return new URL(cur.url).searchParams.get("enc") || ""; } catch { return ""; } })();
    stuUrl = `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${courseId}&clazzid=${clazzId}&cpi=${cpi}&ut=s&stuenc=${enc}`;
  }
  await nav(stuUrl);
  await sleep(1500);

  return { courseId, clazzId, cpi, stuUrl };
}

function cardsUrl(c, kid) {
  return `https://mooc1-1.chaoxing.com/knowledge/cards?clazzid=${c.clazzId}&courseid=${c.courseId}&knowledgeid=${kid}&num=0&ut=s&cpi=${c.cpi}&v=20160407-1&mooc2=1`;
}

async function openNode(c, node) {
  log(`打开节点：${node.title}`);
  saveState({ phase: "opening", currentVideo: node.title, progress: "", progressPercent: 0 });
  await nav(cardsUrl(c, node.kid));
  await sleep(1500);

  // 等挂件渲染完：有 .ans-attach-ct 才算页面加载好，避免把「还没渲染」误判成「没有视频」
  let ready = false;
  for (let i = 0; i < 10; i++) {
    const n = jsRaw("document.querySelectorAll('.ans-attach-ct').length");
    if (Number(n) > 0) { ready = true; break; }
    await sleep(1500);
  }
  if (!ready) log("页面挂件未渲染出来（继续探测）：" + node.title);

  let probe = jsJson(PROBE_EXPR);
  if (probe.captcha) throw new Stop(3, "打开视频节点时出现验证/异常提示 → " + probe.captcha);

  // 用节点页结构判断这是视频任务点还是测验/问卷这类非视频任务点
  let cls = null;
  try { cls = jsJson(CLASSIFY_EXPR); } catch (e) { log("节点页分类失败（按视频兜底）：" + e.message); }
  if (cls && !cls.hasVideo) {
    const mod = (cls.others || []).map((o) => o.mod || o.txt).filter(Boolean).join(",") || "未知";
    if ((cls.others || []).length) {
      log(`跳过测验节点：${node.title}（节点页无 videoContainer，只有 ${mod} 任务点，不点开不答题）`);
      return { skipped: true, nonvideo: true, module: mod };
    }
    log("该节点没有视频（跳过）：" + node.title);
    return { skipped: true, nonvideo: true, module: "none" };
  }
  if (cls && cls.videoFinished) {
    log("视频任务点已完成（跳过）：" + node.title);
    return { skipped: true, finished: true };
  }
  if (!probe.videos.length) {
    log("该节点没有视频（跳过）：" + node.title);
    return { skipped: true, nonvideo: true, module: "no-video" };
  }
  if (probe.videos.every((v) => v.fin)) {
    log("视频任务点已完成（跳过）：" + node.title);
    return { skipped: true, finished: true };
  }

  const p = await cdp.eval(PLAY_EXPR, { gesture: true });
  if (!p || p.err) throw new Stop(1, "播放触发失败：" + (p ? p.err : "无返回"));
  log(`开始播放：${node.title}（时长 ${p.dur ? Math.round(p.dur) + "s" : "待加载"}，倍速 ${p.rate}，静音 ${p.muted}）`);
  saveState({ phase: "playing", currentVideo: node.title });
  return { playing: true };
}

/** 上报失败：video 已 ended，但容器迟迟没有 ans-job-finished（平台没记完成） */
class ReportFailed extends Error {
  constructor(snap) {
    super(`video 已 ended 但 ${Math.round(REPORT_WAIT_MS / 1000)}s 内容器无 ans-job-finished`);
    this.snap = snap;
  }
}

/** 播放监视：只有 video 真消失才抛 VideoGone（带现场），其它照旧抛 Stop */
async function watchNode(c, node) {
  let lastCt = -1, resumes = 0;
  let lastMoveAt = Date.now(); // 最后一次 currentTime 真实增长的时刻（进度停滞保护用）
  let endedAt = null;          // 首次观察到「播到末尾」的时刻（等上报用）
  const t0 = Date.now();
  for (;;) {
    await sleep(endedAt !== null ? 3000 : (lastCt > 0 ? 8000 : 20000));
    const probe = jsJson(PROBE_EXPR);
    if (probe.captcha) throw new Stop(3, "播放过程中出现验证/异常提示 → " + probe.captcha);

    const v = probe.videos.find((x) => !x.fin) || probe.videos[0];
    if (!v) {
      // 先抓现场（截图 + url/title/可见文字），再交给外层自愈
      const ev = captureScreen(`播放中 video 元素消失（${node.title}）`);
      const err = new VideoGone(ev);
      err.playedSec = Math.round((Date.now() - t0) / 1000);
      throw err;
    }

    const pct = v.dur > 0 ? v.ct / v.dur : 0;
    saveState({
      currentVideo: node.title,
      progress: `${Math.round(v.ct)}/${Math.round(v.dur)}s`,
      progressPercent: Math.round(pct * 1000) / 10,
      phase: "playing",
    });
    log(`播放中 ${node.title} → ${Math.round(v.ct)}/${Math.round(v.dur)}s (${(pct * 100).toFixed(1)}%) paused=${v.paused}${v.fin ? " 已标记完成" : ""}`);

    if (v.rate !== null && v.rate !== 1) throw new Stop(1, "播放器倍速被改成 " + v.rate + "，停止");

    // ===== 完成判据：video 真 ended + 容器 ans-job-finished，两个都满足才算完成 =====
    const atEnd = !!v.ended || (v.dur > 0 && v.ct >= v.dur - 1.5);
    if (atEnd && v.fin) {
      log(`播完并已上报：${node.title}（ended=${v.ended} ct=${Math.round(v.ct)}/${Math.round(v.dur)}s 容器=ans-job-finished）`);
      return { finished: true, marked: true, ct: v.ct, dur: v.dur };
    }
    if (atEnd) {
      if (endedAt === null) {
        endedAt = Date.now();
        log(`video 已播到末尾（ct=${Math.round(v.ct)}/${Math.round(v.dur)}s ended=${v.ended}），等容器出现 ans-job-finished，窗口 ${REPORT_WAIT_MS / 1000}s`);
        saveState({ phase: "awaiting-report", currentVideo: node.title });
      }
      const waited = Date.now() - endedAt;
      if (waited >= REPORT_WAIT_MS) {
        log(`上报失败：等了 ${Math.round(waited / 1000)}s 容器仍无 ans-job-finished（${node.title}，容器状态=videoContainer 未完成）`);
        throw new ReportFailed({ ct: v.ct, dur: v.dur, paused: v.paused, ended: v.ended, err: v.err, buf: v.buf, src: v.src, waited: Math.round(waited / 1000) });
      }
      // 注意：video 已 ended 时调 play() 会从头重播，这里绝不点播，只等上报
      if (v.paused && !v.ended && resumes < 3) { resumes++; await cdp.eval(PLAY_EXPR, { gesture: true }); }
      continue;
    }
    if (endedAt !== null) endedAt = null; // 又回到播放中（播放器回退），重新计时

    if (outOfTime()) { log("到点（--minutes）退出，当前视频暂停在第 " + Math.round(v.ct) + "s"); await cdp.eval(`(()=>{const f=[...document.querySelectorAll('iframe')].find(x=>(x.src||'').indexOf('ananas/modules/video')>=0);const v=f&&f.contentDocument&&f.contentDocument.querySelector('video');if(v)v.pause();return 'ok';})()`, {}); throw new Stop(0, "time budget"); }

    // ---- 进度停滞保护：连续 STALL_MIN 分钟 currentTime 不增长 → 交给 playOne 先自愈 ----
    if (Math.abs(v.ct - lastCt) >= 0.5) {
      lastCt = v.ct;
      lastMoveAt = Date.now();
    } else {
      const stallMs = Date.now() - lastMoveAt;
      log(`进度停滞 ${Math.round(stallMs / 1000)}s（currentTime 停在 ${Math.round(v.ct)}s，paused=${v.paused} ready=${v.ready}）`);
      saveState({ phase: "stalled", stalledSeconds: Math.round(stallMs / 1000), lastStallAt: state.lastStallAt || ts() });
      if (stallMs >= STALL_LIMIT_MS) {
        throw new Stalled({ ct: v.ct, dur: v.dur, paused: v.paused, ready: v.ready, net: v.net, err: v.err, buf: v.buf, src: v.src, stallSec: Math.round(stallMs / 1000) });
      }
    }

    if (v.paused) {
      resumes++;
      if (resumes > 3) throw new Stop(4, "播放被暂停且恢复 4 次仍停住（" + pct.toFixed(1) + "%）");
      log("检测到暂停，尝试恢复播放（第 " + resumes + " 次）");
      await cdp.eval(PLAY_EXPR, { gesture: true });
      continue;
    }

    if (Date.now() - t0 > 3 * 3600_000) throw new Stop(4, "单个视频播放超过 3 小时仍未结束，停止");
  }

  await sleep(2000);
  const after = jsJson(PROBE_EXPR);
  if (after.captcha) throw new Stop(3, "视频结束时出现验证/异常提示 → " + after.captcha);
  const done = after.videos.some((x) => x.fin);
  log(`视频结束：${node.title}（容器 ${done ? "ans-job-finished" : "尚未标记完成"}）`);
  return { finished: true, marked: done };
}

/**
 * 自愈 3 次仍无进展后的「5 分钟确认窗口」：还在涨就放行，仍然不动才判死。
 * 返回 true=恢复/已结束，false=确认死透。
 */
async function confirmDead(c, node, snap) {
  log(`【确认】自愈 ${HEAL_MAX} 次无效，再观察 5 分钟确认（${node.title}）`);
  saveState({ phase: "confirming", lastStallSnap: snap });
  const startCt = snap.ct || 0;
  for (let i = 0; i < 15; i++) {
    await sleep(20000);
    let probe;
    try { probe = jsJson(PROBE_EXPR); } catch (e) { log(`【确认】探测失败：${e.message}`); continue; }
    if (probe.captcha) throw new Stop(3, `确认窗口里出现验证/异常提示 → ${probe.captcha}`);
    const v = probe.videos.find((x) => !x.fin) || probe.videos[0];
    if (!v) { log("【确认】video 元素不见了，交给外层处理"); return false; }
    log(`【确认】第 ${i + 1}/15 次：${snapLine(v)}`);
    if (v.ended || v.fin) { log("【确认】视频已结束"); return true; }
    if (Math.abs(v.ct - startCt) >= 1) return true;
    if (v.paused) { try { await cdp.eval(PLAY_EXPR, { gesture: true }); } catch {} }
  }
  log(`【确认】5 分钟仍是 ${Math.round(startCt)}s，确认卡死`);
  return false;
}

/**
 * 完整播一个节点；中途 video 元素消失就自愈（重开章节页继续播），
 * 连续 RECOVER_MAX 次恢复不了抛退出码 5，发现落在登录页抛退出码 6。
 */
async function playOne(c, node) {
  let fails = 0;      // 连续 video 恢复失败次数
  let healCount = 0;  // 本节点已做过的停滞自愈次数（每次自愈后重置停滞计时）
  let reportFails = 0; // 上报失败（ended 但容器没 ans-job-finished）重载重播次数
  let needsOpen = true;
  for (;;) {
    if (needsOpen) {
      const opened = await openNode(c, node);
      if (opened.skipped) return opened;
      needsOpen = false;
    }
    try {
      return await watchNode(c, node);
    } catch (e) {
      if (e instanceof ReportFailed) {
        reportFails++;
        log(`【上报失败 #${reportFails}/${REPORT_MAX}】${node.title} video 已播到末尾但 ${e.snap.waited}s 内容器仍是 videoContainer 无 ans-job-finished（ct=${Math.round(e.snap.ct)}/${Math.round(e.snap.dur)}s paused=${e.snap.paused} err=${e.snap.err ? e.snap.err.code : "无"}）`);
        log(`【上报失败 #${reportFails}/${REPORT_MAX}】重载该节点、从平台记录的位置接着播剩余部分（不拖时间轴）`);
        saveState({ phase: "report-failed", reportFails, lastReportSnap: e.snap });
        if (reportFails >= REPORT_MAX) {
          throw new ReportDead(`video 已 ended 但 ${REPORT_MAX} 次重载重播仍收不到 ans-job-finished（${node.title}）`, e.snap);
        }
        needsOpen = true;
        await sleep(3000);
        continue;
      }
      if (e instanceof Stalled) {
        healCount++;
        state.healCount = (state.healCount || 0) + 1;
        log(`【自愈#${healCount}】触发：${node.title} 停滞 ${e.snap.stallSec}s（${snapLine(e.snap)}）`);
        log(`【自愈#${healCount}】视频源=${(e.snap.src || "空").slice(0, 160)}`);
        saveState({ phase: "stalled", healAttempts: healCount, lastStallSnap: e.snap, healCount: state.healCount, lastStallAt: state.lastStallAt || ts() });
        if (healCount > HEAL_MAX) {
          // 自愈全无效 → 不急着判死：再给 5 分钟确认窗口，偶发缓冲别掐掉整条链
          const v = await confirmDead(c, node, e.snap);
          if (v) { log(`【确认】${node.title} 在确认窗口里恢复增长，继续播放`); healCount = 0; continue; }
          throw new Unfixable(`停滞自愈 ${HEAL_MAX} 次 + 5 分钟确认窗口都未增长（${node.title}）`, v === false ? state.lastStallSnap : e.snap);
        }
        await healStall(c, node, healCount, e.snap);
        continue; // 自愈后重新计时观察
      }
      if (!(e instanceof VideoGone)) throw e;
      if ((e.playedSec || 0) >= 120) fails = 0; // 恢复后正常播过 2 分钟以上，算新事故
      fails++;
      const ev = e.evidence || {};
      log(`自愈：video 元素消失，第 ${fails}/${RECOVER_MAX} 次尝试（本段已播 ${e.playedSec || 0}s）`);
      saveState({ phase: "recovering", recoverAttempts: fails });

      const kind = classifyGone(ev);
      log(`自愈：现场判定 = ${kind}（url=${(ev.url || "空").slice(0, 120)}）`);
      if (kind === "session-lost") throw new Stop(6, `掉线：页面跳到了登录页（${(ev.url || "").slice(0, 160)}）`);
      if (fails > RECOVER_MAX) throw new Stop(5, `video 元素连续 ${RECOVER_MAX} 次恢复失败，放弃（${kind}）`);

      const br = ensureMoocChrome("自愈");
      if (!br.ok) { log("自愈：Chrome 起不来，本次恢复失败"); await sleep(8000); }
      else { await sleep(2500); log("自愈：Chrome 就绪，重新打开章节页继续播"); }
      needsOpen = true;
    }
  }
}

/** 小节/节点页确认：播完后容器真的变成 ans-job-finished 才算完成，没变就停在原节点重试 */
async function verifyNodeDone(c, node, beforeDone) {
  let cardOk = false;
  try {
    await nav(cardsUrl(c, node.kid));
    await sleep(1500);
    const cls = jsJson(CLASSIFY_EXPR);
    cardOk = !!(cls && cls.videoFinished);
    log(`确认：节点页容器 ${cardOk ? "已变为 ans-job-finished" : "仍无 ans-job-finished"}（${node.title}）`);
  } catch (e) {
    log(`确认：节点页探测失败（${e.message}），本轮按未确认处理`);
  }
  let done = null, countOk = null;
  try {
    await nav(c.stuUrl);
    await sleep(1500);
    const d = await readProgress("回章节页确认：");
    done = d.done;
    if (done !== null && beforeDone !== null) countOk = done > beforeDone;
    log(`确认：章节页任务点 ${beforeDone === null ? "?" : beforeDone} → ${done === null ? "?" : done}${countOk === null ? "" : countOk ? "（已增长）" : "（未增长）"}`);
  } catch (e) {
    log(`确认：章节页计数读取失败（${e.message}）`);
  }
  return { ok: cardOk, cardOk, countOk, done };
}

async function main() {
  log(`=== mooc-runner 启动 pid=${process.pid} 预算 ${minutes} 分钟 ===`);
  // 先确认 :PORT 上是挂课专用 Chrome（不是 browser-cli 补的默认 profile 实例）
  const br = ensureMoocChrome("启动");
  if (!br.ok) throw new Stop(1, `:${PORT} 的 Chrome 起不来（start-chrome.sh 失败）`);
  log(`Chrome 就绪：pid=${br.pid}${br.restarted ? "（刚重起）" : "（沿用）"}`);
  const course = await discover();
  saveState({ phase: "discovered", course: { ...course } });
  log(`课程参数 courseid=${course.courseId} clazzid=${course.clazzId} cpi=${course.cpi}`);

  let base = await fetchNodes();
  if (base.done !== null) {
    log(`基线任务点：${base.done}/${base.total}`);
    saveState({ completedPoints: base.done, totalPoints: base.total, progressText: `已完成任务点 ${base.done}/${base.total}` });
  }
  let played = 0, nochange = 0;
  let noWork = false;   // 软性空转：没节点可播但任务点没做完（退出码 7）
  let unfixable = 0; // 同一轮里判定「源异常」的节点个数
  const skipped = loadSkipped();
  const nonvideo = loadNonVideo();
  const doneNodes = loadDone();
  const nodeTries = {}; // kid -> 本节点「确认未过」次数
  for (const k of Object.keys(skipped)) log(`已知源异常节点（不再重试）：${skipped[k].title} kid=${k}`);
  for (const k of Object.keys(nonvideo)) log(`已知非视频节点（不重复打开）：${nonvideo[k]} kid=${k}`);

  for (let round = 0; round < 20; round++) {
    if (outOfTime()) { log("到点（--minutes）退出，不再开始新视频"); break; }
    const ms = await fetchNodes();
    // 「还有没有视频要播」：不再只看 job>0（每个节点都还挂着未完成的章节测验，job 永远 >0），
    // 要排除已知非视频节点，以及标题命中测验/阅读/问卷且无视频图标的节点
    const pending = ms.nodes.filter((n) => n.job > 0 && !skipped[n.kid] && !nonvideo[n.kid] && !(n.quizHint && !n.videoIcon));
    if (!pending.length) {
      noWork = true;
      let pt = "";
      try {
        const d = await fetchNodes();
        if (d.done !== null) {
          pt = `${d.done}/${d.total}`;
          saveState({ completedPoints: d.done, totalPoints: d.total, progressText: `已完成任务点 ${d.done}/${d.total}` });
        }
      } catch { /* 读不到就按 state 兜底 */ }
      log(`章节列表里已无待完成的视频节点（页面进度：${pt || "读不到"}）`);
      break;
    }
    let handled = false;
    let i = 0;
    while (i < ms.nodes.length) {
      if (outOfTime()) break;
      const n = ms.nodes[i];
      if (n.job <= 0) { i++; continue; }
      if (skipped[n.kid]) { log(`跳过已知源异常节点：${n.title}`); i++; continue; }
      if (nonvideo[n.kid]) { i++; continue; }
      if (doneNodes[n.kid]) { i++; continue; }
      if (n.quizHint && !n.videoIcon) {
        log(`跳过测验节点：${n.title}（标题命中测验/阅读/问卷且无视频图标，不点开不答题）`);
        markNonVideo(n, "title-hint");
        i++; continue;
      }
      const before = state.completedPoints;
      saveState({ currentVideo: n.title, phase: "opening" });
      let r;
      try {
        r = await playOne(course, n);
      } catch (e) {
        if (e instanceof ReportDead) {
          log(`SKIP ${n.title} 上报反复失败（video 已 ended 但容器无 ans-job-finished，重试 ${REPORT_MAX} 次）：${snapLine(e.snap)}`);
          markSkipped(n, e.snap, `上报失败 ${REPORT_MAX} 次`);
          i++; continue;
        }
        if (!(e instanceof Unfixable)) throw e;
        const num = (n.title.match(/^([\d.]+)\s/) || [])[1] || n.title;
        log(`SKIP ${num} 源异常（${n.title}，停滞自愈 ${HEAL_MAX} 次均失败：${snapLine(e.snap)}）`);
        log(`SKIP ${num} 源地址=${(e.snap && e.snap.src ? e.snap.src : "空").slice(0, 160)}`);
        markSkipped(n, e.snap, `停滞自愈 ${HEAL_MAX} 次均失败`);
        unfixable++;
        i++;
        if (unfixable >= 2) throw new Stop(4, `同一轮里已 ${unfixable} 个节点停滞自愈全失败，判规模性问题（最后现场：${snapLine(e.snap)}）`);
        continue;
      }
      if (r.skipped) {
        if (r.nonvideo) { markNonVideo(n, r.module || "nonvideo"); i++; continue; }
        if (r.finished) { log(`节点已是已完成状态，跳过：${n.title}`); i++; continue; }
        i++; continue;
      }

      // 播完一个节点 → 必须回节点页/章节页确认真的变成已完成，才允许往下走
      played++;
      saveState({ playedVideos: played });
      handled = true;
      const v = await verifyNodeDone(course, n, before);
      if (v.cardOk) {
        markDone(n);
        doneNodes[n.kid] = { title: n.title, at: ts() };
        nochange = 0;
        if (v.countOk === false) {
          log(`注意：节点容器已 ans-job-finished，但章节页任务点未增长（${before} → ${v.done}），可能是计数延迟`);
        }
        i++;
        break;
      }
      const t = (nodeTries[n.kid] = (nodeTries[n.kid] || 0) + 1);
      log(`【确认未过 ${t}/${VERIFY_MAX}】${n.title} 播完后容器仍无 ans-job-finished，停在本节点重播，不往后跳`);
      saveState({ phase: "verify-failed", verifyFails: t, currentVideo: n.title });
      if (t >= VERIFY_MAX) {
        throw new Stop(5, `节点 ${n.title} 播完后 ${VERIFY_MAX} 次确认仍未变成已完成（容器无 ans-job-finished，任务点 ${before} → ${v.done}）`);
      }
      await sleep(3000);
      // 不 i++：原地重开该节点继续确认
    }
    if (!handled) {
      if (outOfTime()) break;
      noWork = true;
      log(`本轮没有可播的视频节点，退出循环（当前 ${state.completedPoints}/${state.totalPoints}）`);
      break;
    }
    if (outOfTime()) break;
  }

  saveState({ phase: "done" });
  log(`=== 结束：本次播放 ${played} 个视频，任务点 ${state.completedPoints}/${state.totalPoints}，耗时 ${elapsedMin()} 分钟 ===`);
  if (noWork && Number(state.completedPoints) < Number(state.totalPoints)) {
    log(`【空转】没有可播节点但只完成 ${state.completedPoints}/${state.totalPoints}，退出码 7`);
    return 7;
  }
  return 0;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (e) {
  if (e instanceof Stop) {
    exitCode = e.code;
    if (e.code === 0) log("按预算时间正常退出");
    else log(`【停止】${e.reason}（退出码 ${e.code}）`);
    saveState({ phase: e.code === 0 ? "stopped" : "stopped", stopReason: e.reason, exitCode: e.code });
    // 4/5/6 = 需要人介入：把最后一屏（含播放器现场）写进 STOPPED
    if (e.code === 4 || e.code === 5 || e.code === 6) {
      const ev = state.lastScreen || {};
      const sn = state.lastStallSnap || {};
      const txt = [
        `${e.reason}（退出码 ${e.code}）`,
        sn && sn.ct !== undefined ? `最后一次播放器：${snapLine(sn)}` : "",
        sn && sn.src ? `视频源：${String(sn.src).slice(0, 200)}` : "",
        `最后一屏：title=${ev.title || "(空)"} url=${ev.url || "(空)"}`,
        `可见文字：${(ev.text || "(空)").slice(0, 200)}`,
        `截图：${ev.screenshot || "(无)"}`,
        ts(),
      ].filter(Boolean).join("\n");
      try { fs.writeFileSync(path.join(OUT_DIR, "STOPPED"), txt + "\n"); log("已写 STOPPED（含最后一屏/播放器现场）"); }
      catch (err) { log("写 STOPPED 失败：" + err.message); }
    }
  } else {
    exitCode = 1;
    log(`【错误】${e && e.message ? e.message : e}`);
    saveState({ phase: "error", stopReason: String(e && e.message ? e.message : e) });
  }
} finally {
  cdp.close();
  try { cli(["close"], 30); log("已关闭标签页"); } catch (e) { log("关闭标签页失败：" + e.message); }
  process.exit(exitCode);
}
