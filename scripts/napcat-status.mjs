#!/usr/bin/env node
/**
 * NapCat 在线状态查询 —— 经 OneBot11 WebSocket 调 get_status
 * 输出: {"online":true|false,"good":true|false}  或 {"error":"..."}
 * 供 napcat-watchdog.sh 使用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let ob = {};
try { ob = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).napcat?.onebot ?? {}; } catch {}
const host = ob.wsHost ?? "127.0.0.1";
const port = ob.wsPort ?? 3001;
const token = ob.token ?? "";

const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const ws = new WebSocket(`ws://${host}:${port}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
const to = setTimeout(() => out({ error: "ws 超时" }), 12000);

ws.on("open", () => {
  try { ws.send(JSON.stringify({ action: "get_status", params: {}, echo: "wd" })); } catch { out({ error: "send 失败" }); }
});
ws.on("message", (buf) => {
  let o;
  try { o = JSON.parse(buf.toString()); } catch { return; }
  if (!o || o.echo !== "wd") return;   // 事件推送与 config_dirs 等忽略
  clearTimeout(to);
  const st = o.data ?? {};
  out({ online: st.online === true, good: st.good === true, stat: st.stat ?? {} });
});
ws.on("error", (e) => { clearTimeout(to); out({ error: String(e?.message ?? e).slice(0, 120) }); });
ws.on("close", () => { clearTimeout(to); out({ error: "ws 已关闭" }); });
