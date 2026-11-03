#!/usr/bin/env node
/**
 * 会话瘦身：把历史消息里的**内联图片 base64** 换成占位符。
 *
 * 【为什么需要】
 * 2026-09-24 事故：私聊会话 private_3573297011.jsonl 涨到 6.61MB，其中 4.04MB 是
 * 两条 `{"type":"image","data":"iVBORw0KGgo..."}`（2560x1440 的 PNG，base64 后
 * 单条 2.6M 字符）。此后**每一轮请求都要把这 4MB 图片重传**，请求体达 5.6MB →
 * 超过上游 ~1M tokens（≈3~4.5MB 文本）的处理上限 → 上游在 HTTP 200 的流里回
 * `{"type":"error","error":{"message":"Bad Request","statusCode":400,"isRetryable":false}}`
 * → 代理转成空流 → bot 看到 0 个 delta → 回「模型返回了空内容」。
 * 表现是「bot 突然不回话」，而真凶是两张早就翻过页的图。
 *
 * 【为什么不直接删掉整条消息】
 * 删掉会让对话链断裂（parentId 悬空）。只把 image 部分换成文字占位符，
 * 保留消息本身与 toolCall/toolResult 的配对，历史仍然自洽。
 *
 * 【为什么必须停机做】
 * 会话在 bridge 内存里也有一份，运行期改盘上文件会被内存副本覆盖（同 sql.js 的坑）。
 *
 * 用法：
 *   node scripts/session-strip-images.mjs <会话文件> [--dry] [--min-kb N] [--no-backup]
 * 退出码：0 正常（含未命中），1 出错
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const DRY = args.includes("--dry");
const NO_BACKUP = args.includes("--no-backup");
const minKbArg = args.indexOf("--min-kb");
const MIN_KB = minKbArg >= 0 ? Number(args[minKbArg + 1]) : 0;
const mb = (b) => (b / 1048576).toFixed(2);

if (!file) {
  console.error("用法：node scripts/session-strip-images.mjs <会话文件> [--dry] [--min-kb N]");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`[strip] 文件不存在：${file}`);
  process.exit(1);
}

/** 把一条消息里的 image 部分换成占位文本；返回是否改动过 */
function stripLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { changed: false, out: line };
  }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return { changed: false, out: line };
  let changed = false;
  let freed = 0;
  const next = content.map((part) => {
    if (part?.type !== "image") return part;
    const n = typeof part.data === "string" ? part.data.length : 0;
    if (n / 1024 < MIN_KB) return part; // 小图不动
    changed = true;
    freed += n;
    return { type: "text", text: `[历史图片已裁剪：${part.mimeType ?? "image"}，原始 base64 ${(n / 1048576).toFixed(2)}MB。如需重新查看请让我再读一次文件。]` };
  });
  if (!changed) return { changed: false, out: line };
  entry.message.content = next;
  return { changed: true, out: JSON.stringify(entry), freed };
}

const sizeBefore = fs.statSync(file).size;
const lines = fs.readFileSync(file, "utf8").split("\n");
let hitLines = 0;
let freedChars = 0;
const outLines = lines.map((l) => {
  if (!l) return l;
  const { changed, out, freed } = stripLine(l);
  if (changed) { hitLines++; freedChars += freed ?? 0; }
  return out;
});

console.log(`[strip] ${path.basename(file)} · ${mb(sizeBefore)}MB · ${lines.length} 行`);
if (!hitLines) {
  console.log("[strip] 没有需要裁剪的内联图片");
  process.exit(0);
}
const text = outLines.join("\n");
const sizeAfter = Buffer.byteLength(text, "utf8");
console.log(`[strip] 命中 ${hitLines} 行 · 释放 base64 ${mb(freedChars * 4 / 3)}MB（估计）`);
console.log(`[strip] ${mb(sizeBefore)}MB → ${mb(sizeAfter)}MB（省 ${mb(sizeBefore - sizeAfter)}MB）`);
if (DRY) {
  console.log("[strip] （干跑，未写入）");
  process.exit(0);
}
if (!NO_BACKUP) {
  const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, bak);
  console.log(`[strip] 已备份 → ${bak}`);
}
fs.writeFileSync(file, text);
console.log("[strip] 写入完成");
