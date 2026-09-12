/**
 * NapCat 生命周期管理 — 集成进 PI2X
 *
 * 职责：
 *  1. 配置同步：确保 napcat/config/onebot11_{account}.json 的
 *     WebSocket 服务器与 PI2X config.json 一致（端口/token/host）
 *  2. 启动/停止：spawn NapCat（node.exe ./index.js），退出时清理子进程树
 *  3. 健康检查：轮询 WS 端口直至就绪
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createLogger } from "./log.mjs";

const logNapcat = createLogger("napcat");

const IS_WIN = process.platform === "win32";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const HIDE_QQ_SCRIPT = path.join(ROOT, "scripts", "hide-qq.ps1");
const napcatDir = path.resolve(ROOT, config.napcat.dir);
const acct = config.napcat.qqAccount;

function napcatConfigDir() {
  return path.join(napcatDir, "napcat", "config");
}

/** 让 NapCat 的 OneBot11 配置与 PI2X 配置保持一致（Windows：内嵌 NapCat；Linux：外部托管，跳过） */
export function ensureOnebotConfig() {
  if (!IS_WIN) return { skipped: true };
  const dir = napcatConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `onebot11_${acct}.json`);
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { cfg = {}; }
  }
  cfg.network ??= {};
  cfg.network.websocketServers ??= [];
  // 移除旧的同名 server，写入当前配置
  cfg.network.websocketServers = cfg.network.websocketServers.filter(
    (s) => !(s.name === "PI2X" || (s.port === config.napcat.onebot.wsPort && s.host === config.napcat.onebot.wsHost)),
  );
  cfg.network.websocketServers.push({
    enable: true,
    name: "PI2X",
    host: config.napcat.onebot.wsHost,
    port: config.napcat.onebot.wsPort,
    reportSelfMessage: false,
    enableForcePushEvent: true,
    messagePostFormat: "array",
    token: config.napcat.onebot.token,
    debug: false,
    heartInterval: 30000,
  });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { file, port: config.napcat.onebot.wsPort, token: config.napcat.onebot.token };
}

/** 检查 WS 端口是否可连接 */
export function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

let child = null;
let hideTimer = null;

/** 隐藏所有 QQ 主窗口（Windows 专用；Linux 无头环境无操作） */
export function hideQQWindows() {
  if (!IS_WIN) return;
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HIDE_QQ_SCRIPT],
      { stdio: "ignore", windowsHide: true },
    );
  } catch { /* 无 QQ 进程等 */ }
}

/** 后台防泄漏：每隔一段时间隐藏一次 QQ 窗口 */
function startHideLoop() {
  hideQQWindows();
  hideTimer = setInterval(hideQQWindows, 20000);
  hideTimer.unref?.();
}

/** 密码回退登录凭据（环境变量优先，其次 .secret.json） */
function passwordEnv() {
  const env = { ...process.env };
  if (process.env.NAPCAT_QUICK_PASSWORD) env.NAPCAT_QUICK_PASSWORD = process.env.NAPCAT_QUICK_PASSWORD;
  if (process.env.NAPCAT_QUICK_PASSWORD_MD5) env.NAPCAT_QUICK_PASSWORD_MD5 = process.env.NAPCAT_QUICK_PASSWORD_MD5;
  const secretPath = path.join(ROOT, ".secret.json");
  if (fs.existsSync(secretPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(secretPath, "utf8"));
      if (s.quickPassword && !env.NAPCAT_QUICK_PASSWORD) env.NAPCAT_QUICK_PASSWORD = s.quickPassword;
      if (s.quickPasswordMd5 && !env.NAPCAT_QUICK_PASSWORD_MD5) env.NAPCAT_QUICK_PASSWORD_MD5 = s.quickPasswordMd5;
      if (s.qqAccount) env.ACCOUNT = s.qqAccount;
    } catch { /* 忽略损坏的 secret 文件 */ }
  }
  return env;
}

/** 启动 NapCat（若未运行）
 * autoLogin=true 时带 -q <QQ号> 走快速登录（需登录态已存在）；
 * 配置了密码（环境变量或 .secret.json）时 NapCat 将按 NAPCAT_QUICK_PASSWORD 自动登录；
 * 均不可用时回退到二维码登录。
 * Linux：NapCat 由外部（screen/systemd，见 /root/start-napcat.sh）托管，这里只检查端口。 */
export async function start() {
  if (child) return child;
  if (await isRunning()) return { alreadyRunning: true };
  if (!IS_WIN) {
    logNapcat.info("Linux 环境：NapCat 由外部托管，等待 OneBot WS 就绪...");
    const ok = await waitForReady(120000);
    if (!ok) logNapcat.warn("等待 NapCat 就绪超时");
    return { alreadyRunning: ok };
  }

  const bat = process.platform === "win32" ? "node.exe" : "node";
  const args = config.napcat.autoLogin
    ? ["./index.js", "-q", config.napcat.qqAccount]
    : ["./index.js"];
  logNapcat.info(`${bat} ${args.join(" ")}`);
  child = spawn(bat, args, {
    cwd: napcatDir,
    env: passwordEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true, // 静默启动：不显示控制台窗口
  });
  child.stdout?.on("data", (d) => logNapcat.info(String(d).trimEnd()));
  child.stderr?.on("data", (d) => logNapcat.error(String(d).trimEnd()));
  child.on("exit", (code) => {
    logNapcat.warn(`exited (code=${code})`);
    child = null;
    if (hideTimer) { clearInterval(hideTimer); hideTimer = null; }
  });
  startHideLoop();
  return child;
}

/** 停止 NapCat（含子进程树） */
export function stop() {
  if (!IS_WIN) {
    // Linux：NapCat 由外部 screen 托管（/root/start-napcat.sh），bridge 退出不动它
    return;
  }
  if (!child) return;
  const pid = child.pid;
  child = null;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch { /* 已退出 */ }
}

/** 等待 OneBot WS 就绪 */
export async function waitForReady(timeoutMs = 60000) {
  const { wsHost, wsPort } = config.napcat.onebot;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(wsHost, wsPort)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function isRunning() {
  return probePort(config.napcat.onebot.wsHost, config.napcat.onebot.wsPort);
}

export const napcatConfig = config.napcat;