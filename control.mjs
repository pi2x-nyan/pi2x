/**
 * PI2X 进程管理 — start / stop / restart / status
 * 用法：node control.mjs <start|stop|restart|status>
 *
 * 关键：按命令行匹配 "bridge.mjs" 精确找到所有实例，防止多开。
 *
 * 【跨平台】原先只实现了 Windows 分支（powershell + taskkill）。bridge 实际跑在
 * Linux 上，于是 `status` 恒定输出「bridge 未运行」、`stop` 恒定输出「没有正在运行
 * 的 bridge」—— 明明有两个进程在跑却报空，属于会误导排查的假信息。
 * 现在按 process.platform 分派：Windows 走 WMI + taskkill，其余走 /proc + SIGTERM。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, "logs", "bridge.log");
const IS_WIN = process.platform === "win32";

/** 列出所有 bridge.mjs 进程的 PID（当前平台实现） */
function listBridges() {
  if (IS_WIN) return listBridgesWindows();
  return listBridgesLinux();
}

function listBridgesWindows() {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -match 'bridge\\.mjs' } | " +
        "ForEach-Object { Write-Output ($_.ProcessId) }",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return out.trim().split(/\r?\n/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/**
 * Linux：遍历 /proc 读各自 cmdline。
 *
 * 为什么不用 `pgrep -f bridge.mjs`：
 *  · 该模式会匹配到**调用者自己**（命令行里含这串字符），也可能匹配到 shell 包装；
 *  · 这里按 /proc/<pid>/cmdline 逐条比对，能确认是 node 且在跑 bridge.mjs，
 *    并且天然排除自身（自身 cmdline 是 control.mjs）。
 */
function listBridgesLinux() {
  const pids = [];
  let entries = [];
  try { entries = fs.readdirSync("/proc"); } catch { return pids; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (pid === process.pid) continue;
    let argv = "";
    try { argv = fs.readFileSync(`/proc/${e}/cmdline`, "utf8"); } catch { continue; }
    const parts = argv.split("\0").filter(Boolean);
    if (!parts.length) continue;
    // 必须是 node 进程，且参数里有以 bridge.mjs 结尾的项
    const isNode = /(^|\/)node$/.test(parts[0]);
    if (!isNode) continue;
    if (!parts.some((p) => p.endsWith("bridge.mjs"))) continue;
    pids.push(pid);
  }
  return pids;
}

/** 终止一个进程（含子进程） */
function killOne(pid) {
  if (IS_WIN) {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // Linux：先 TERM 让它优雅收尾（bridge 有 SIGTERM 处理：关 NapCat、落盘），
  // 短暂等待后仍活着才 KILL —— 直接 -9 会丢心跳与在途回复。
  try { process.kill(pid, "SIGTERM"); } catch { /* 已不在 */ }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; } // 已退出
    try { execFileSync("sleep", ["0.2"]); } catch { /* 忽略 */ }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* 已不在 */ }
}

function stop() {
  const pids = listBridges();
  if (!pids.length) {
    console.log("[ctl] 没有正在运行的 bridge");
    return;
  }
  for (const pid of pids) {
    try {
      killOne(pid);
      console.log(`[ctl] 已终止 bridge (PID ${pid}${IS_WIN ? "，含子进程树" : ""})`);
    } catch {
      console.log(`[ctl] PID ${pid} 已不在`);
    }
  }
}

function start() {
  const existing = listBridges();
  if (existing.length) {
    console.log(`[ctl] bridge 已在运行: ${existing.join(", ")}，跳过（如需重启用 restart）`);
    return;
  }
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "bridge.mjs")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.on("error", (e) => console.log(`[ctl] 启动失败: ${e.message}`));
  child.unref();
  console.log(`[ctl] bridge 已启动 (PID ${child.pid})，日志: logs/bridge.log`);
}

function status() {
  const pids = listBridges();
  console.log(pids.length ? `[ctl] bridge 运行中: ${pids.join(", ")}` : "[ctl] bridge 未运行");
  return pids.length ? 0 : 1;
}

const cmd = process.argv[2] ?? "status";
switch (cmd) {
  case "start": start(); break;
  case "stop": stop(); break;
  case "restart": stop(); setTimeout(start, 1500); break;
  default: process.exit(status());
}
