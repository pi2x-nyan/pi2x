#!/usr/bin/env node
/**
 * 会话文件维护 CLI
 *
 * 用法：
 *   node scripts/sessions-maint.mjs                  # 体检报告（只读，安全）
 *   node scripts/sessions-maint.mjs --slim --dry-run # 预览瘦身效果（只读）
 *   node scripts/sessions-maint.mjs --slim           # 执行瘦身（自动备份）
 *   node scripts/sessions-maint.mjs --archive        # 归档陈旧测试会话
 *   node scripts/sessions-maint.mjs --all            # 归档 + 瘦身
 *
 * 选项：
 *   --min-idle <分钟>  只处理空闲超过该时长的文件（默认 5，避免动到正在会话中的）
 *   --json             输出 JSON
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { survey, slimFile, archiveStale, sweepOrphans } from "../lib/sessions-maint.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SESSIONS = path.join(ROOT, "sessions");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const dryRun = has("--dry-run");
const doSlim = has("--slim") || has("--all");
const doArchive = has("--archive") || has("--all");
const doSweep = has("--sweep") || has("--all");
const asJson = has("--json");
const minIdleMs = Number(val("--min-idle", "5")) * 60_000;

const mb = (b) => `${(b / 1024 / 1024).toFixed(2)}MB`;
const kb = (b) => `${(b / 1024).toFixed(1)}KB`;
const fmt = (b) => (b >= 1024 * 1024 ? mb(b) : kb(b));

const s = survey(SESSIONS);
const report = { total: s.totalBytes, files: s.files.length, archived: [], orphans: [], slimmed: [], skipped: [] };

// 0) 清理子代理孤儿（正常结束时会被 unlink，进程被 kill 时会残留）
if (doSweep) {
  const r = sweepOrphans(SESSIONS, { dryRun });
  report.orphans = r.removed;
  if (!asJson) {
    if (r.removed.length) {
      console.log(`【孤儿】${dryRun ? "预览" : "已删"} ${r.removed.length} 个子代理残留会话，释放 ${fmt(r.freed)}`);
      for (const f of r.removed) console.log(`  ${fmt(f.bytes).padStart(9)}  ${f.name}`);
    } else {
      console.log("【孤儿】无子代理残留会话");
    }
  }
}

// 1) 归档陈旧测试残留
if (doArchive && s.stale.length) {
  const moved = archiveStale(SESSIONS, s.stale, { dryRun });
  report.archived = s.stale.map((r) => ({ name: r.name, bytes: r.bytes }));
  if (!asJson) {
    console.log(`【归档】${dryRun ? "预览" : "已移动"} ${moved.length} 个陈旧测试会话 → sessions/.archive/`);
    for (const r of s.stale) console.log(`  ${fmt(r.bytes).padStart(9)}  ${r.name}`);
  }
} else if (!asJson && s.stale.length) {
  console.log(`【提示】发现 ${s.stale.length} 个陈旧测试会话（共 ${fmt(s.staleBytes)}），用 --archive 归档`);
}

// 2) 瘦身
if (doSlim) {
  // 归档后重新体检（被移走的文件不必再瘦身）
  const cur = survey(SESSIONS);
  for (const f of cur.files) {
    if (f.stale) continue;
    if (f.bytes < 200 * 1024) continue; // 小文件不值得动
    const r = slimFile(f.path, { dryRun, minIdleMs });
    if (r.skipped) report.skipped.push({ name: f.name, reason: r.reason });
    else report.slimmed.push({ name: f.name, before: r.before, after: r.after, saved: r.before - r.after, entries: r.savedEntries });
  }
  if (!asJson) {
    const saved = report.slimmed.reduce((a, b) => a + b.saved, 0);
    console.log(`\n【瘦身】${dryRun ? "预览" : "已处理"} ${report.slimmed.length} 个文件，${dryRun ? "预计" : "实际"}节省 ${fmt(saved)}`);
    for (const r of report.slimmed) {
      console.log(`  ${r.name}\n    ${fmt(r.before)} → ${fmt(r.after)}（-${fmt(r.saved)}，丢弃 ${r.entries} 条已压缩历史）`);
    }
    for (const r of report.skipped) console.log(`  [跳过] ${r.name}：${r.reason}`);
  }
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const after = survey(SESSIONS);
  console.log(`\n【体检】${after.files.length} 个会话文件，共 ${fmt(after.totalBytes)}`);
  console.log("体积前 5：");
  for (const f of after.files.slice(0, 5)) console.log(`  ${fmt(f.bytes).padStart(9)}  ${f.name}`);
}
