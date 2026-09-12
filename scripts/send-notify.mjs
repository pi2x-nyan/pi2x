#!/usr/bin/env node
/**
 * PI2X 重启上线提醒 —— 经 OneBot11 WebSocket 发送通知（供 restart-pi2x.sh 调用）
 *
 * 用法：node scripts/send-notify.mjs <user_id|group_id> <message> [--group]
 *   --group 则发到群（group_id），否则发私聊（user_id）
 * 从 config.json 读 wsHost/wsPort/token。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const ob = cfg.napcat?.onebot ?? {};
const host = ob.wsHost ?? "127.0.0.1";
const port = ob.wsPort ?? 3001;
const token = ob.token ?? "";

const args = process.argv.slice(2);
const isGroup = args.includes("--group");
const numbers = args.filter((a) => /^\d+$/.test(a));
const msgIdx = args.findIndex((a, i) => i > 0 && !/^\d+$/.test(a) && a !== "--group");
const target = numbers[0];
const message = msgIdx >= 0 ? args.slice(msgIdx).join(" ").split(" --group")[0] : "PI2X 已重启完成，服务已上线。";

if (!target) {
  console.error("[send-notify] 缺 target");
  process.exit(1);
}

const action = isGroup ? "send_group_msg" : "send_private_msg";
const params = isGroup ? { group_id: Number(target), message } : { user_id: Number(target), message };

const wsUrl = `ws://${host}:${port}/?access_token=${encodeURIComponent(token)}`;
const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => { console.error("[send-notify] 超时"); process.exit(2); }, 8000);

ws.on("open", () => {
  ws.send(JSON.stringify({ action, params, echo: "notify" }));
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(String(data));
    if (msg.echo === "notify") {
      clearTimeout(timer);
      console.log(`[send-notify] ${action} 成功: ${JSON.stringify(msg).slice(0, 120)}`);
      ws.close();
      process.exit(0);
    }
  } catch {}
});

ws.on("error", (e) => {
  clearTimeout(timer);
  console.error("[send-notify] WS 出错:", e?.message);
  process.exit(3);
});
