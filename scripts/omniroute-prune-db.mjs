#!/usr/bin/env node
/**
 * OmniRoute 数据库裁剪器 —— 必须在 **OmniRoute 已停止** 时运行。
 *
 * 【为什么必须停机】OmniRoute 用 sql.js（WASM）驱动：启动时把整个 storage.sqlite
 * 读进内存，之后每次写入都把**整库**序列化回磁盘。所以运行期间从外部改库，
 * 改动会在它下一次写回时被内存副本整体覆盖 —— 必须在它停止时裁剪。
 *
 * 【为什么要裁】实测（2026-09-23）：
 *   conversation_turn_nodes 表 322,494 行 + 4 个索引 = 219MB，占全库 269MB 的 81%，
 *   而 sql.js 把整库读进 WASM（**不受 --max-old-space-size 约束**），
 *   加上 V8 堆上限被设为总内存的 35%（2617MB），OmniRoute 匿名内存达 ~4GB，
 *   在 7.5GB 手机上被整体换出到 swap → 每次请求磁盘颠簸 → 模型调用从几十秒
 *   劣化到 143~512 秒并偶发 ETIMEDOUT。
 *
 * 用法：
 *   node scripts/omniroute-prune-db.mjs [--db <path>] [--dry] [--node-days N] [--node-max-rows N]
 * 退出码：0 = 正常（含「无需裁剪」），1 = 出错（含「OmniRoute 未停止」）
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DB = getArg("--db", "/root/.omniroute/storage.sqlite");
const DRY = args.includes("--dry");
const DAY = 86400000;
const isoCut = (d) => new Date(Date.now() - d * DAY).toISOString();
const sqlCut = (d) => new Date(Date.now() - d * DAY).toISOString().slice(0, 19).replace("T", " ");
const mb = (b) => (b / 1048576).toFixed(1);

/**
 * 保留策略。`maxRows` 用于「按时间裁完还很大」的表：再按行数砍到上限。
 * 这些是网关自身的记账数据（PI2X 的记忆是自建的，不依赖它），可放心裁。
 */
const PLAN = [
  { table: "conversation_turn_nodes", col: "last_seen_at", days: Number(getArg("--node-days", 7)), fmt: "iso", maxRows: Number(getArg("--node-max-rows", 30000)) },
  { table: "proxy_logs", col: "timestamp", days: 7, fmt: "iso" },
  { table: "job_runs", col: "started_at", days: 7, fmt: "iso" },
  { table: "call_logs", col: "timestamp", days: 14, fmt: "iso" },
  { table: "session_model_history", col: "used_at", days: 14, fmt: "sql" },
  { table: "usage_history", col: "timestamp", days: 90, fmt: "iso" },
];

const NODE_INDEXES = ["idx_turn_nodes_content_hash", "sqlite_autoindex_conversation_turn_nodes_1", "idx_turn_nodes_parent", "idx_turn_nodes_conversation"];

/** 各表/索引占用（dbstat 不可用时返回空表） */
function spaceMap(db) {
  try {
    return new Map(db.prepare("SELECT name, SUM(pgsize) b FROM dbstat GROUP BY name").all().map((r) => [r.name, r.b]));
  } catch {
    return new Map();
  }
}

function assertStopped() {
  try {
    const out = execFileSync("pgrep", ["-f", "[o]mniroute serve"], { encoding: "utf8" }).trim();
    if (out) return out.split("\n").join(",");
  } catch {
    return ""; // pgrep 无匹配时退出码非 0
  }
  return "";
}

function main() {
  if (!fs.existsSync(DB)) {
    console.error(`[prune] 数据库不存在：${DB}`);
    return 1;
  }
  if (!DRY) {
    const running = assertStopped();
    if (running) {
      console.error(`[prune] 拒绝裁剪：OmniRoute 仍在运行（pid ${running}）。`);
      console.error("[prune] 运行中改库会被 sql.js 的内存副本整体覆盖，并可能损坏数据库。请先 `omniroute stop`。");
      return 1;
    }
  }

  const sizeBefore = fs.statSync(DB).size;
  const db = new DatabaseSync(DB, DRY ? { readOnly: true } : {});
  const before = spaceMap(db);
  let deletedTotal = 0;
  const lines = [];

  for (const p of PLAN) {
    try {
      const cut = p.fmt === "iso" ? isoCut(p.days) : sqlCut(p.days);
      const rowsBefore = db.prepare(`SELECT COUNT(*) n FROM "${p.table}"`).get().n;
      if (!DRY) db.prepare(`DELETE FROM "${p.table}" WHERE "${p.col}" < ?`).run(cut);

      let rowsNow = DRY ? db.prepare(`SELECT COUNT(*) n FROM "${p.table}" WHERE "${p.col}" >= ?`).get(cut).n : db.prepare(`SELECT COUNT(*) n FROM "${p.table}"`).get().n;
      let capped = "";
      if (p.maxRows && rowsNow > p.maxRows) {
        const excess = rowsNow - p.maxRows;
        if (!DRY) {
          db.prepare(`DELETE FROM "${p.table}" WHERE rowid IN (SELECT rowid FROM "${p.table}" ORDER BY "${p.col}" ASC LIMIT ?)`).run(excess);
          rowsNow = db.prepare(`SELECT COUNT(*) n FROM "${p.table}"`).get().n;
        } else {
          rowsNow = p.maxRows;
        }
        capped = ` + 行数上限 ${p.maxRows}`;
      }
      const gone = rowsBefore - rowsNow;
      deletedTotal += gone;
      lines.push(`  ${p.table.padEnd(26)} ${String(rowsBefore).padStart(7)} → ${String(rowsNow).padStart(7)} 行（-${String(gone).padStart(6)}）  保留${p.days}天${capped}`);
    } catch (e) {
      lines.push(`  ${p.table.padEnd(26)} 跳过：${e.message}`);
    }
  }

  let sizeAfter = sizeBefore;
  if (!DRY) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  }
  const after = DRY ? before : spaceMap(db);
  const tn = after.get("conversation_turn_nodes") ?? 0;
  const idxBytes = NODE_INDEXES.reduce((s, k) => s + (after.get(k) ?? 0), 0);
  db.close();

  if (!DRY) sizeAfter = fs.statSync(DB).size;

  console.log(`[prune] ${DRY ? "（干跑，未改动）" : ""}${DB}`);
  for (const l of lines) console.log(l);
  console.log(`[prune] 共删除 ${deletedTotal} 行 · ${mb(sizeBefore)}MB → ${mb(sizeAfter)}MB（省 ${mb(sizeBefore - sizeAfter)}MB）`);
  console.log(`[prune] 对话节点表+4 索引：${mb(tn + idxBytes)}MB（占全库 ${((tn + idxBytes) / (sizeAfter || 1) * 100).toFixed(0)}%）`);
  return 0;
}

process.exit(main());
