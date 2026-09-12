/**
 * 会话文件维护 —— 瘦身 / 归档 / 体检
 *
 * 【背景：会话文件为什么会长成 5MB】
 * pi 的会话文件是**纯追加日志**：每一条 message / toolResult / compaction / custom 都写进去，
 * 从不删除。压缩（compact）只影响「模型看到什么」，不影响「文件里存着什么」——
 * 被压缩掉的旧历史仍以原始形态躺在文件里。于是：
 *   · 你我的私聊文件涨到 5.4MB，光打开解析就要 1.86 秒（每次重启都付这个钱）
 *   · subagent 会话文件创建后无人清理，是慢性泄漏
 *
 * 【瘦身原理（已用真实文件验证语义等价）】
 * 会话文件里有一条「有效压缩」条目（分支上最后一条 compaction），它带两个关键字段：
 *   · id              —— 压缩条目自身的 id
 *   · firstKeptEntryId —— 压缩后**仍以原始形态保留**的第一条历史的 id
 * 模型可见上下文 = [压缩条目] + 从 firstKeptEntryId 起的全部条目。
 *
 * 因此可以安全丢弃：firstKeptEntryId **之前**的所有条目（它们已被摘要覆盖）。
 * 做法：保留「session 头 + firstKeptEntryId 起（含压缩条目本身）的全部条目」，
 * 并把新文件第一条的 parentId 置空（它原本指向被丢弃的上一条，否则是悬空引用）。
 *
 * ⚠️ 注意 firstKeptEntryId 可能位于压缩条目**之前**（压缩点回退了若干条），
 * 所以起点要取 min(压缩条目位置, firstKeptEntryId 位置)。
 *
 * 【安全约束】
 *   · 只处理「最近 N 分钟未被修改」的文件（避免动到正在会话中、进程内存里有缓存的文件）
 *   · 原地改写前先备份到 sessions/.backup/
 *   · 改写是原子的（写临时文件 → rename）
 *   · --dry-run 只报告不动手
 */
import fs from "node:fs";
import path from "node:path";

/** 被视为「测试/调试残留」的文件名特征 —— 这些可以整体归档 */
export const STALE_PATTERNS = [
  /^repro_/,
  /^test-/, // test-chat.jsonl
  /^ltest/,
  /^cacheTest/,
  /^dbg/,
  /^sim\d*\.jsonl$/,
  /^\d{4}-\d{2}-\d{2}T.*\.jsonl$/, // 导出式命名（非 chatKey 命名，不会被运行时读取）
];

/**
 * 一次性会话文件（子代理）—— 正常结束时会被 unlink，但两种情况下会变成孤儿：
 *   1. 进程被 kill（重启 / OOM）时子代理正好在跑 → finally 永不执行
 *   2. 会话创建抛异常走了 catch 分支（曾漏 unlink）
 * 启动瞬间不可能有子代理在跑，所以 boot 时看到的全是孤儿，可直接清理。
 * 命名来源：lib/piagent.mjs 的 `subagent-<ts>-<rand>` 与 `subtask-<taskId>-<rand>`。
 */
export const EPHEMERAL_PATTERNS = [/^subagent-\d+-[a-z0-9]+\.jsonl$/, /^subtask-.*\.jsonl$/];

/** 是否为子代理的一次性会话文件 */
export function isEphemeralName(name) {
  return EPHEMERAL_PATTERNS.some((re) => re.test(name));
}

/**
 * 清理子代理孤儿会话文件（boot 时调用最安全）
 * @param {string} dir 会话目录
 * @param {{dryRun?:boolean, minAgeMs?:number, now?:number}} [opts]
 *        minAgeMs：只清理「修改时间早于 N 毫秒前」的文件，给正在启动中的子代理留余地
 * @returns {{removed:Array<{name:string,bytes:number}>, freed:number}}
 */
export function sweepOrphans(dir, { dryRun = false, minAgeMs = 0, now = Date.now() } = {}) {
  const removed = [];
  let freed = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed, freed };
  }
  for (const name of names) {
    if (!isEphemeralName(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (minAgeMs > 0 && now - st.mtimeMs < minAgeMs) continue;
    if (!dryRun) {
      try {
        fs.unlinkSync(full);
      } catch {
        continue;
      }
    }
    removed.push({ name, bytes: st.size });
    freed += st.size;
  }
  return { removed, freed };
}

/** 判断是否为陈旧测试残留 */
export function isStaleName(name) {
  return STALE_PATTERNS.some((re) => re.test(name));
}

/** 解析 JSONL 文本 → 条目数组（坏行返回 null 占位，保留行序） */
export function parseLines(text) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    if (!raw.trim()) continue;
    try {
      out.push({ raw, obj: JSON.parse(raw) });
    } catch {
      out.push({ raw, obj: null });
    }
  }
  return out;
}

/**
 * 计算瘦身方案（纯函数，不碰文件系统）
 * @param {string} text 会话文件全文
 * @returns {{keepLines:string[], before:number, after:number, savedEntries:number, compactionIdx:number|null, firstKeptIdx:number|null, reason:string|null}}
 */
export function planSlim(text) {
  const entries = parseLines(text);
  const before = Buffer.byteLength(text, "utf8");

  const headerIdx = entries.findIndex((e) => e.obj?.type === "session");
  // 有效压缩 = 文件里最后一条 compaction（_buildIndex 会把 leaf 设为最后一条，分支即整条链）
  let ci = -1;
  for (let i = 0; i < entries.length; i++) if (entries[i].obj?.type === "compaction") ci = i;

  if (ci < 0) {
    return {
      keepLines: entries.map((e) => e.raw),
      before,
      after: before,
      savedEntries: 0,
      compactionIdx: null,
      firstKeptIdx: null,
      reason: "无压缩条目（未压缩过，无可丢弃历史）",
    };
  }

  const fkid = entries[ci].obj?.firstKeptEntryId;
  let fi = fkid ? entries.findIndex((e) => e.obj?.id === fkid) : -1;
  if (fi < 0) {
    // 找不到 firstKeptEntryId（老版本或无该字段）→ 保守：只从压缩条目本身开始保留
    fi = ci;
  }
  const start = Math.min(ci, fi);

  const keep = [];
  for (let i = 0; i < entries.length; i++) {
    if (i === headerIdx) continue; // 表头稍后单独放在最前
    if (i >= start) keep.push(i);
  }

  const lines = [];
  if (headerIdx >= 0) lines.push(entries[headerIdx].raw);
  for (const i of keep) {
    let raw = entries[i].raw;
    if (i === start) {
      // 断开悬空 parentId（指向已被丢弃的上一条）
      if (entries[i].obj && entries[i].obj.parentId != null) {
        const fixed = { ...entries[i].obj, parentId: null };
        raw = JSON.stringify(fixed);
      }
    }
    lines.push(raw);
  }

  const after = Buffer.byteLength(lines.join("\n") + "\n", "utf8");
  return {
    keepLines: lines,
    before,
    after,
    savedEntries: entries.length - lines.length,
    compactionIdx: ci,
    firstKeptIdx: fi,
    reason: null,
  };
}

/** 列出会话目录体检结果 */
export function survey(dir, { staleBeforeMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  const out = { files: [], totalBytes: 0, staleBytes: 0, stale: [] };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const row = { name, path: full, bytes: st.size, mtime: st.mtimeMs, stale: isStaleName(name) };
    out.totalBytes += st.size;
    out.files.push(row);
    if (row.stale && now - st.mtimeMs > staleBeforeMs) {
      out.stale.push(row);
      out.staleBytes += st.size;
    }
  }
  out.files.sort((a, b) => b.bytes - a.bytes);
  out.stale.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/**
 * 对单个文件执行瘦身
 * @param {string} file
 * @param {{dryRun?:boolean, minIdleMs?:number, now?:number}} opts
 */
export function slimFile(file, { dryRun = false, minIdleMs = 300_000, now = Date.now() } = {}) {
  const st = fs.statSync(file);
  // ⚠ 空闲时长必须 clamp 到 >= 0。
  // 文件系统 mtime 是浮点数（实测 `...972.005`），而 Date.now() 是整数毫秒；
  // 当写入与取时间落在同一毫秒时 `now - mtimeMs` 会是负数，
  // 于是「刚写完的文件」被误判为「时间戳在未来」，在 minIdleMs=0 时也照样跳过瘦身。
  // 负值物理上等价于「就是现在写的」，按 0 处理即可。
  const idleMs = Math.max(0, now - st.mtimeMs);
  if (idleMs < minIdleMs) {
    return { file, skipped: true, reason: `最近 ${Math.round(minIdleMs / 60000)} 分钟内被修改（可能正在会话中）` };
  }
  const text = fs.readFileSync(file, "utf8");
  const plan = planSlim(text);
  if (plan.reason || plan.after >= plan.before) {
    return { file, skipped: true, reason: plan.reason ?? "无可压缩空间", before: plan.before, after: plan.after };
  }
  if (dryRun) {
    return { file, dryRun: true, before: plan.before, after: plan.after, savedEntries: plan.savedEntries };
  }
  // 备份 → 原子改写
  const backupDir = path.join(path.dirname(file), ".backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(file, path.join(backupDir, `${path.basename(file)}.${stamp}.bak`));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, plan.keepLines.join("\n") + "\n", "utf8");
  fs.renameSync(tmp, file);
  return { file, before: plan.before, after: plan.after, savedEntries: plan.savedEntries };
}

/** 归档陈旧测试会话（移动到 sessions/.archive/） */
export function archiveStale(dir, rows, { dryRun = false } = {}) {
  const arch = path.join(dir, ".archive");
  if (!dryRun) fs.mkdirSync(arch, { recursive: true });
  const moved = [];
  for (const r of rows) {
    const dest = path.join(arch, r.name);
    if (!dryRun) {
      try {
        fs.renameSync(r.path, dest);
      } catch {
        continue;
      }
    }
    moved.push(dest);
  }
  return moved;
}

export default { planSlim, survey, slimFile, archiveStale, sweepOrphans, isStaleName, isEphemeralName, parseLines };
