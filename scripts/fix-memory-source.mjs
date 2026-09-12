#!/usr/bin/env node
/**
 * 修复历史错误来源键的记忆（一次性维护脚本）
 *
 * 【背景】
 * harvest 写入来源键时用的是 `${chatType}:${userId}`，群聊时把**用户QQ当群号**，
 * 与读取端的 `group:<群号>` 对不上 → 这批记忆在任何真实群里都检索不到（死数据）。
 * 代码已在 lib/memory-source.mjs 统一修好；本脚本处理**已经写错的历史数据**。
 *
 * 【为什么默认只预览】
 * 「这批记忆原本该归到哪个来源」涉及隐私语义：
 *   · 归到 group:<群号> → **群内所有人可见**（群记忆是共享的）
 *   · 归到 private:<QQ> → 只有本人可见
 * 本脚本默认 --dry-run，只报告不改动；执行前请先确认归属策略。
 *
 * 归属判定：用 harvest_log 的时间戳做关联（harvest 是先写事实、后记日志，
 * 因此日志时间略晚于事实时间，且同一批的间隔在数秒内）。判不准的一律不猜。
 *
 * 用法：
 *   node scripts/fix-memory-source.mjs                    # 预览（只读，安全）
 *   node scripts/fix-memory-source.mjs --apply            # 执行（自动备份）
 *   node scripts/fix-memory-source.mjs --apply --to private   # 强制全部归到私聊
 *   node scripts/fix-memory-source.mjs --apply --to group     # 按时间关联归到群
 *   node scripts/fix-memory-source.mjs --apply --to delete    # 删除（不可恢复）
 *   node scripts/fix-memory-source.mjs --apply --to group --delete-unknown
 *        # 归群；时间关联判不准的**一并删除**（默认是跳过、不动它们）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { config } from "../lib/config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const toIdx = argv.indexOf("--to");
const TO = toIdx >= 0 ? argv[toIdx + 1] : null;
/** 判不准归属的条目是否删除（默认 false = 跳过不动） */
const DELETE_UNKNOWN = argv.includes("--delete-unknown");

const DB = path.resolve(ROOT, config.memory?.dbPath ?? "./workspace/memories/memory.db");
if (!fs.existsSync(DB)) {
  console.error(`记忆库不存在: ${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB);

/** 找出「群来源但群号疑似写成了用户号」的条目 —— 特征：group:<某个已知用户QQ> */
function findSuspects() {
  const wlFile = path.join(ROOT, "whitelist.json");
  let userIds = [];
  try {
    userIds = Object.keys(JSON.parse(fs.readFileSync(wlFile, "utf8")).users ?? {});
  } catch {
    /* 读不到白名单就退化为「所有 group: 来源」 */
  }
  const rows = db.prepare("SELECT id, type, content, ts, source, pinned, sensitive FROM facts WHERE source LIKE 'group:%'").all();
  if (!userIds.length) return rows;
  const set = new Set(userIds);
  return rows.filter((r) => set.has(String(r.source).slice("group:".length)));
}

/**
 * 用时间戳把每条事实关联到当时的 harvest 会话。
 *
 * 方向很关键：harvest 先捕获 `now` 再逐条写事实（写事实时会取新的 Date.now()），
 * 最后用捕获的那个 `now` 记日志 —— 所以**日志时间 <= 事实时间**。
 * 正确的取法是「往前找最近的一条」，而不是往后找（一开始写反了，全是「无匹配」）。
 */
function correlate(factTs) {
  const row = db
    .prepare("SELECT session, ts FROM harvest_log WHERE ts <= ? AND ts >= ? ORDER BY ts DESC LIMIT 1")
    .get(factTs, factTs - 300_000); // 5 分钟窗口，避免关联到很久以前的无关 harvest
  return row?.session ?? null;
}

const suspects = findSuspects();
const bySource = {};
for (const r of suspects) bySource[r.source] = (bySource[r.source] ?? 0) + 1;

console.log(`库: ${DB}`);
console.log(`发现疑似错误来源的记忆 ${suspects.length} 条，来源分布：${JSON.stringify(bySource)}\n`);

const plans = [];
for (const r of suspects) {
  const session = correlate(r.ts);
  const guess = session && session.startsWith("group:") ? session : null;
  plans.push({ ...r, correlatedSession: session, groupGuess: guess });
}

console.log("── 逐条分析 ──");
for (const p of plans) {
  const when = new Date(p.ts).toISOString().slice(0, 19).replace("T", " ");
  console.log(`  ${p.id.slice(0, 8)}  ${when}  [${p.type}]`);
  console.log(`     内容: ${String(p.content).slice(0, 60)}`);
  console.log(`     当前来源: ${p.source}   ← 群号位置是用户QQ`);
  console.log(`     时间关联: ${p.correlatedSession ?? "（无匹配）"}${p.groupGuess ? `  → 推测属于 ${p.groupGuess}` : "  → 判不准"}`);
  console.log();
}

// ── 归属策略 ──
function decideTarget(p) {
  if (TO === "private") return `private:${String(p.source).slice("group:".length)}`;
  if (TO === "delete") return null;
  if (TO === "group") return p.groupGuess; // 判不准则跳过
  return null; // 未指定
}

if (!TO) {
  console.log("── 未指定归属策略，仅预览 ──");
  console.log("可选：");
  console.log("  --to group    按时间关联归到推测的群（判不准的跳过）");
  console.log("  --to private  全部归到原用户QQ的私聊来源（最保守，只有本人可见）");
  console.log("  --to delete   删除这批（不可恢复）");
  console.log("\n可加：--delete-unknown  把「时间关联判不准」的条目也一并删除（默认跳过不动）");
  console.log("\n执行方式：在预览确认后加 --apply");
  db.close();
  process.exit(0);
}

// ── 执行 ──
const ok = [], skipped = [], toDelete = [];
for (const p of plans) {
  const target = decideTarget(p);
  if (target === undefined || (target === null && TO !== "delete")) {
    // 判不准归属：默认跳过不动；显式给了 --delete-unknown 才删
    if (DELETE_UNKNOWN) toDelete.push(p);
    else skipped.push({ p, why: "时间关联判不准，未猜（可用 --delete-unknown 删除）" });
    continue;
  }
  ok.push({ p, target });
}

console.log(`── 执行计划（--to ${TO}${DELETE_UNKNOWN ? " --delete-unknown" : ""}）──`);
console.log(`  将处理 ${ok.length} 条，跳过 ${skipped.length} 条，删除 ${toDelete.length} 条`);
for (const s of skipped) console.log(`    [跳过] ${s.p.id.slice(0, 8)}：${s.why}`);
for (const d of toDelete) console.log(`    [待删] ${d.id.slice(0, 8)}：${String(d.content).slice(0, 40)}`);

if (!APPLY) {
  console.log("\n（预览模式；确认无误后加 --apply 执行）");
  db.close();
  process.exit(0);
}

// 备份
const backupDir = path.join(ROOT, "tmp", "memory-backup");
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(backupDir, `memory.db.${stamp}.bak`);
fs.copyFileSync(DB, backupFile);
console.log(`\n已备份数据库 → ${path.relative(ROOT, backupFile)}`);

let changed = 0;
db.exec("BEGIN");
try {
  for (const { p, target } of ok) {
    if (TO === "delete") {
      db.prepare("DELETE FROM facts WHERE id = ?").run(p.id);
      console.log(`  [删除] ${p.id.slice(0, 8)}`);
    } else {
      db.prepare("UPDATE facts SET source = ? WHERE id = ?").run(target, p.id);
      console.log(`  [改源] ${p.id.slice(0, 8)}  ${p.source} → ${target}`);
    }
    changed++;
  }
  for (const d of toDelete) {
    db.prepare("DELETE FROM facts WHERE id = ?").run(d.id);
    console.log(`  [删除·判不准] ${d.id.slice(0, 8)}  ${String(d.content).slice(0, 40)}`);
    changed++;
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error(`\n执行失败，已回滚：${e?.message}`);
  db.close();
  process.exit(1);
}

console.log(`\n✅ 完成，处理 ${changed} 条`);
const after = db.prepare("SELECT source, COUNT(*) c FROM facts GROUP BY source ORDER BY c DESC").all();
console.log("当前来源分布：");
for (const r of after) console.log(`  ${String(r.c).padStart(4)}  ${r.source}`);
db.close();
