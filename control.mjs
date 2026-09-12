/**
 * PI2X 进程管理 — start / stop / restart / status
 * 用法：node control.mjs <start|stop|restart|status>
 *
 * 关键：按 CommandLine 匹配 "bridge.mjs" 精确找到所有实例，防止多开。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, "logs", "bridge.log");

/** 列出所有 bridge.mjs 进程的 PID */
function listBridges() {
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

function stop() {
  const pids = listBridges();
  if (!pids.length) {
    console.log("[ctl] 没有正在运行的 bridge");
    return;
  }
  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      console.log(`[ctl] 已终止 bridge (PID ${pid}，含子进程树)`);
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
    detached: true, // 项目根目录下独立进程，父（含 bash 会话）退出不影响
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