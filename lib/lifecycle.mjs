/**
 * 生命周期管理 —— 进程探活、拉起、降级
 *
 * 【进程如何区分】
 *  正常模式：`node bridge.mjs`（cwd = 项目根）
 *  安全模式：`node bridge-safe.mjs`
 * 用 cmdline 匹配，与 control.mjs 的做法一致。匹配时用字符类 `[.]` 规避 pkill 自匹配。
 *
 * 【为什么不用 systemd】
 * 这套跑在容器/chroot 里，没有 systemd 可用；而且系统级服务会引入「谁能改它」的权限问题。
 * 用 cron + 普通脚本更轻，且完全在项目内可控。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, LOGS_DIR } from "./config.mjs";
import { readMode, writeMode, heartbeatAge, touchHeartbeat, DEFAULTS } from "./mode.mjs";
import { createLogger } from "./log.mjs";

const logLife = createLogger("lifecycle");

/** 正常模式与安全模式的进程特征 */
export const PROC = Object.freeze({
  normal: /bridge[.]mjs/,
  safe: /bridge-safe[.]mjs/,
});

/** 列出匹配某模式的进程 PID */
export function pidsOf(kind, exec = execFileSync) {
  const re = PROC[kind];
  if (!re) return [];
  try {
    // ps 输出的 cmd 列可能被截断，改用 -ww 拿完整命令行
    const out = exec("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const sp = l.indexOf(" ");
        return { pid: Number(l.slice(0, sp)), cmd: l.slice(sp + 1) };
      })
      .filter((r) => Number.isFinite(r.pid) && re.test(r.cmd))
      .map((r) => r.pid);
  } catch (e) {
    logLife.warn(`进程枚举失败: ${e?.message}`);
    return [];
  }
}

/** 该模式是否有进程在跑 */
export function isAlive(kind, exec) {
  return pidsOf(kind, exec).length > 0;
}

/** 启动一个模式（后台 detach，日志追加到 logs/） */
export function spawnMode(kind, { stateDir, logger = logLife } = {}) {
  // 演练/测试安全阀：PI2X_NO_SPAWN=1 时只记录不真拉起。
  // 否则 scripts/drill.mjs 一跑就会真的把 bridge-safe 拉起来，跟线上实例抢 NapCat 连接
  // （这个坑真踩过：演练意外启动了两个安全模式进程，还改写了真实状态文件）。
  if (process.env.PI2X_NO_SPAWN === "1") {
    logger.info(`[PI2X_NO_SPAWN] 本应拉起 ${kind} 模式（演练模式：不实际启动）`);
    return null;
  }
  const entry = kind === "safe" ? "bridge-safe.mjs" : "bridge.mjs";
  const entryPath = path.join(ROOT, entry);
  if (!fs.existsSync(entryPath)) throw new Error(`入口不存在: ${entry}`);
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOGS_DIR, kind === "safe" ? "safe.log" : "bridge.log"), "a");
  const child = spawn(process.execPath, [entryPath], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      PI2X_MODE_KIND: kind, // 供入口自己识别（记录日志/心跳用）
    },
  });
  child.unref();
  logger.info(`已拉起 ${kind} 模式 (PID ${child.pid})`);
  return child.pid;
}

/** 结束某模式的所有进程（先 TERM，超时再 KILL） */
export function killMode(kind, { timeoutMs = 8000 } = {}) {
  const pids = pidsOf(kind);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 可能刚好退出了 */
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsOf(kind).length === 0) return pids.length;
    execFileSync("sleep", ["0.3"]);
  }
  for (const pid of pidsOf(kind)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  return pids.length;
}

/** 读日志判断某模式是否「真的就绪过」——用于验证拉起是否成功 */
export function waitReady(kind, { timeoutMs = 30000, sinceLine = 0 } = {}) {
  const file = path.join(LOGS_DIR, kind === "safe" ? "safe.log" : "bridge.log");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      const tail = lines.slice(Math.max(0, sinceLine)).join("\n");
      if (/pi agent 就绪|安全模式就绪/.test(tail)) return true;
    } catch {
      /* 文件可能还没建 */
    }
    execFileSync("sleep", ["0.5"]);
  }
  return false;
}

/** 当前日志行数（用于 waitReady 只看新增部分）—— 注意命名不要以 log 开头，
 *  否则会被 test/logging-consistency.test.mjs 当成 logger 变量。 */
export function countLogLines(kind) {
  const file = path.join(LOGS_DIR, kind === "safe" ? "safe.log" : "bridge.log");
  try {
    return fs.readFileSync(file, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * 快照当前运行状态（供 watchdog 决策）
 */
export function inspect(stateDir, { now = Date.now() } = {}) {
  const st = readMode(stateDir);
  const normalPids = pidsOf("normal");
  const safePids = pidsOf("safe");
  // 把存活 pid 传给 heartbeatAge 做归属校验：心跳若属于已消失的进程，
  // 会被视为「没有心跳」而不是「心跳很旧」—— 后者会导致刚重启的进程被误判为卡死。
  const alivePids = [...normalPids, ...safePids];
  return {
    ...st,
    normalAlive: normalPids.length > 0,
    safeAlive: safePids.length > 0,
    normalPids,
    safePids,
    heartbeatAgeMs: heartbeatAge(stateDir, now, { alivePids }),
    heartbeatStaleMs: DEFAULTS.heartbeatStaleMs,
  };
}

export default { PROC, pidsOf, isAlive, spawnMode, killMode, waitReady, countLogLines, inspect };
