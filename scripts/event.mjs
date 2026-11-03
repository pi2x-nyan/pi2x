#!/usr/bin/env node
/**
 * 事件推送 CLI —— 让任何脚本/服务都能把「事情」丢给 PI2X
 *
 *   node scripts/event.mjs push <type> <text> [--key K] [--ttl 分钟]
 *   node scripts/event.mjs list
 *   node scripts/event.mjs watch add-file <路径>
 *   node scripts/event.mjs watch add-url <地址>
 *   node scripts/event.mjs watch list
 *   node scripts/event.mjs watch clear
 *
 * 例：磁盘快满时由监控脚本调用
 *   node scripts/event.mjs push disk "根分区使用率 92%" --key disk:root --ttl 180
 */
import { pushEvent, loadEvents, loadWatch, saveWatch } from "../lib/events.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => {
  const i = rest.indexOf(n);
  return i >= 0 ? rest[i + 1] : undefined;
};

function usage() {
  console.log(`用法：
  event.mjs push <type> <text> [--key K] [--ttl 分钟]
  event.mjs list
  event.mjs watch add-file <路径> | add-url <地址> | list | clear`);
}

try {
  if (cmd === "push") {
    const [type, ...textParts] = rest.filter((x) => !x.startsWith("--") && x !== flag("--key") && x !== flag("--ttl"));
    const text = textParts.join(" ");
    if (!type || !text) { usage(); process.exit(2); }
    const key = flag("--key");
    const ttlMin = Number(flag("--ttl") ?? 0);
    const k = pushEvent({ type, key, text, ttlMs: ttlMin > 0 ? ttlMin * 60000 : undefined });
    console.log(`已入队 ${k}：${text}`);
  } else if (cmd === "list") {
    const list = loadEvents();
    if (!list.length) { console.log("（无待消费事件）"); process.exit(0); }
    for (const e of list) {
      console.log(`[${e.type}] ${new Date(e.at).toLocaleString()} ${e.key}\n    ${e.text}`);
    }
  } else if (cmd === "watch") {
    const sub = rest[0];
    const w = loadWatch();
    if (sub === "add-file") {
      const p = rest[1];
      if (!p) { usage(); process.exit(2); }
      w.files = Array.from(new Set([...(w.files ?? []), p]));
      saveWatch(w);
      console.log(`已监视文件：${p}`);
    } else if (sub === "add-url") {
      const u = rest[1];
      if (!u) { usage(); process.exit(2); }
      w.urls = Array.from(new Set([...(w.urls ?? []), u]));
      saveWatch(w);
      console.log(`已监视网页：${u}`);
    } else if (sub === "list") {
      console.log(`文件：${(w.files ?? []).join("\n      ") || "（无）"}`);
      console.log(`网页：${(w.urls ?? []).join("\n      ") || "（无）"}`);
    } else if (sub === "clear") {
      saveWatch({ files: [], urls: [] });
      console.log("监视列表已清空");
    } else {
      usage(); process.exit(2);
    }
  } else {
    usage();
    process.exit(2);
  }
} catch (e) {
  console.error(`出错：${e?.message}`);
  process.exit(1);
}
