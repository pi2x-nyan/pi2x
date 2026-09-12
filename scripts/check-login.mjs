#!/usr/bin/env node
/**
 * 登录态探测 — PI2X watchdog 用
 * 用法: node check-login.mjs
 * 通过 OneBot11 WS 调用 get_login_info：
 *   - 连接失败 / API 失败 / 返回非 ok → 判定"掉线"，exit 1
 *   - 正常返回 user_id → exit 0
 */
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 从本地 config.json 读取 OneBot 连接参数；环境变量可覆盖。
 *  token 绝不写默认值 —— 那等于把密钥焊进代码里（本文件曾犯过这个错）。 */
function loadOnebot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    return cfg?.napcat?.onebot ?? {};
  } catch {
    return {};
  }
}
const nb = loadOnebot();
const HOST = process.env.PI2X_WS_HOST || nb.wsHost || "127.0.0.1";
const PORT = Number(process.env.PI2X_WS_PORT || nb.wsPort || 3001);
const TOKEN = process.env.PI2X_WS_TOKEN || nb.token || "";
if (!TOKEN) {
  console.error("未取到 OneBot token：请在 config.json 的 napcat.onebot.token 配置，或设置 PI2X_WS_TOKEN");
  process.exit(2);
}

const ws = new WebSocket(`ws://${HOST}:${PORT}/?access_token=${encodeURIComponent(TOKEN)}`);
const timer = setTimeout(() => { console.error("TIMEOUT"); process.exit(1); }, 8000);

ws.on("open", () => {
  ws.send(JSON.stringify({ action: "get_login_info", params: {}, echo: "watchdog" }));
});
ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.echo === "watchdog") {
      clearTimeout(timer);
      if (msg.status === "ok" && msg.data?.user_id) {
        console.log(`OK user=${msg.data.user_id}`);
        ws.close();
        process.exit(0);
      }
      console.error(`LOGIN_FAIL ${JSON.stringify(msg).slice(0, 120)}`);
      ws.close();
      process.exit(1);
    }
  } catch { /* 忽略事件消息 */ }
});
ws.on("error", (e) => { clearTimeout(timer); console.error("WS_ERR", e.message); process.exit(1); });
ws.on("close", () => { clearTimeout(timer); console.error("WS_CLOSED"); process.exit(1); });