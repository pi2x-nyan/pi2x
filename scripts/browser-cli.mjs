#!/usr/bin/env node
/**
 * 浏览器自动化 CLI —— 供 PI2X 的浏览器 skill 通过 bash 调用（CDP 驱动 headless Chrome）
 *
 * 端口约定（用户隔离，cookie/凭据隔离）：
 *   9222 = 管理员实例（browser-profile，保留 admin 登录态）
 *   9223 = 普通用户/operator 实例（browser-profile-op，全新无 admin 凭据）【禁止输入 admin 凭据】
 *
 * 防"卡住"保护：
 *   --timeout <ms>：整个命令的硬看门狗（默认 120s），到期进程强制以码 2 退出；
 *   navigate 由 browser-lib 改为轮询（不等 load 事件），不会再因页面不触发 load 而挂死。
 *
 * 用法：
 *   node browser-cli.mjs [--port 9222] [--timeout 120000] status
 *   node browser-cli.mjs [--port 9222] navigate <url>
 *   node browser-cli.mjs [--port 9222] click <css-selector>
 *   node browser-cli.mjs [--port 9222] type <css-selector> <text>
 *   node browser-cli.mjs [--port 9222] js <expression>
 *   node browser-cli.mjs [--port 9222] read
 *   node browser-cli.mjs [--port 9222] screenshot [outPath]
 *   node browser-cli.mjs [--port 9222] close
 */
import { CdpBrowser, getBrowser } from "./browser-lib.mjs";

let port = 9222;
let watchdog = 120000;
const restArgs = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--port" && process.argv[i + 1]) { port = Number(process.argv[i + 1]) || 9222; i++; }
  else if (a === "--timeout" && process.argv[i + 1]) { watchdog = Number(process.argv[i + 1]) || 120000; i++; }
  else restArgs.push(a);
}
const [action, ...rest] = restArgs;

// 硬看门狗：命令行级兜底，到期即退出（码 2）
const watchdogTimer = setTimeout(() => {
  console.log(`[browser-cli] 超时保护触发(${watchdog}ms)，强制退出`);
  process.exit(2);
}, watchdog);
watchdogTimer.unref?.();

/** 在指定端口自起 headless Chrome（按端口选隔离 profile） */
async function ensureChrome(port) {
  if (await CdpBrowser.isRunning(port)) return true;
  const fs = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const findBin = () => {
    const base = "/root/.cache/ms-playwright";
    if (!fs.existsSync(base)) return null;
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { return null; }
    for (const d of dirs) {
      const p = `${base}/${d}/chrome-linux-arm64/chrome`;
      const p2 = `${base}/${d}/headless_shell`;
      if (fs.existsSync(p)) return p;
      if (fs.existsSync(p2)) return p2;
    }
    return null;
  };
  const bin = findBin();
  if (!bin) {
    console.log(
      process.env.PI2X_SANDBOX_DIR
        ? `（未找到 chrome 二进制。沙盒环境下浏览器实例由主进程托管，请确认 :${port} 已在运行；` +
            `不要尝试在沙盒内自行启动）`
        : "（未找到 chrome 二进制）"
    );
    return false;
  }
  const profile = port === 9222 ? "/opt/pi2x/browser-profile" : "/opt/pi2x/browser-profile-op";
  try { fs.mkdirSync(profile, { recursive: true }); } catch {}
  try {
    spawn(bin, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--remote-debugging-port=${port}`, "--user-data-dir=" + profile,
      "--window-size=1280,900", "--hide-scrollbars", "about:blank",
    ], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await CdpBrowser.isRunning(port)) return true;
    }
    return false;
  } catch (e) { console.log("（chrome 启动失败: " + (e?.message ?? e) + "）"); return false; }
}

async function main() {
  const up = await ensureChrome(port);
  if (action === "status") {
    console.log(up ? `browser(running) port=${port}` : `browser(not running) port=${port}`);
    process.exit(0);
  }
  if (!up) { console.log("（浏览器未运行）"); process.exit(1); }

  const b = getBrowser(port);
  let out;
  switch (action) {
    case "navigate": {
      const url = rest[0];
      if (!url) { console.log("需要 url"); process.exit(1); }
      const nav = await b.navigate(url, { timeoutMs: 30000 });
      const r = await b.readText();
      out = JSON.stringify({ nav, url: r.url, title: r.title, text: (r.text || "").slice(0, 1200) }, null, 1);
      break;
    }
    case "click": {
      if (!rest[0]) { console.log("需要 selector"); process.exit(1); }
      out = await b.click(rest[0]);
      break;
    }
    case "type": {
      if (!rest[0] || rest[1] === undefined) { console.log("需要 selector 和 text"); process.exit(1); }
      out = await b.type(rest[0], rest.slice(1).join(" "));
      break;
    }
    case "js": {
      if (!rest[0]) { console.log("需要 JS 表达式"); process.exit(1); }
      const v = await b.eval(rest.join(" "));
      out = typeof v === "string" ? v : JSON.stringify(v, null, 1);
      break;
    }
    case "read": {
      const r = await b.readText();
      out = JSON.stringify(r, null, 1);
      break;
    }
    case "screenshot": {
      out = "截图: " + (await b.screenshot(rest[0] || null));
      break;
    }
    case "close": {
      out = await b.closePage();
      break;
    }
    default:
      out = `未知操作 ${action}`;
      process.exit(1);
  }
  console.log(String(out ?? "").slice(0, 8000));
  b.close();
  process.exit(0);
}

main().catch((e) => { console.log("错误: " + (e?.message ?? e)); process.exit(1); });