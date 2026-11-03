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
  // 【必须沿 leaf 回溯链找分支点，不能取「文件里最后一条 compaction」】
  //
  // 真实事故（2026-09-13）：某会话文件里有 7 条 compaction，其中最后一条（e5afd0fc）
  // 是一次**中途放弃的压缩**——它自己不在 leaf 回溯链上，也没有任何条目以它为 parent，
  // 是条悬空分支。而 pi 的 buildContextEntries() 是沿 leaf 的 parentId 一路回溯的，
  // 它眼里真正的分支点是链上最后一条 compaction（7a20db32），两者相差 438 条。
  //
  // 于是按文件顺序取「最后一条」就取错了分支点：起点晚了 438 条，
  // 瘦身把 pi 本来看得见的 632 条上下文砍成 276 条 —— 悄悄丢掉了真实历史。
  // 表现为 e2e 测试「上下文 id 序列逐项一致」失败，且**只在多分支/有过放弃压缩的
  // 会话上复现**，普通会话看不出来。
  //
  // 现在先算 leaf 链（沿 parentId 回溯），只认链上的 compaction。
  const byId = new Map();
  let leafIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const o = entries[i].obj;
    if (!o || typeof o.id !== "string") continue;
    byId.set(o.id, i);
    leafIdx = i; // 文件最后一条有效条目就是 leaf（与 pi 的 _buildIndex 一致）
  }
  const chain = new Set();
  const path = []; // leaf → root 的父链（按 chain 顺序，root 在前）
  {
    const startObj = leafIdx >= 0 ? entries[leafIdx].obj : null;
    let curId = startObj?.id;
    let guard = 0;
    while (curId && byId.has(curId) && guard++ < entries.length + 10) {
      if (chain.has(curId)) break; // 防环
      chain.add(curId);
      const idx = byId.get(curId);
      path.push({ ...entries[idx].obj, __raw: entries[idx].raw, __idx: idx });
      curId = entries[idx].obj?.parentId ?? null;
    }
    path.reverse();
  }

  // 有效压缩 = **链上**最后一条 compaction；链上没有就退回全文件扫描（老格式兼容）
  let ci = -1;
  for (let i = 0; i < entries.length; i++) {
    const o = entries[i].obj;
    if (o?.type === "compaction" && chain.has(o.id)) ci = i;
  }
  if (ci < 0) {
    // 【2026-10-25 事故：这里的兜底差点又埋一次】
    //
    // 原逻辑：链上找不到压缩 → 退回去按文件顺序取「最后一条 compaction」。
    // 当时以为是「老格式兼容」，但它在一个很常见的情形下是**灾难性**的：
    //
    //   本会话有 14 条 compaction，其中 13 条的 parentId 指向早已被删掉的节点
    //   （历次瘦身留下的）。pi 的 buildContextEntries 沿 leaf 回溯，**一条都走不到**，
    //   于是它压根没应用压缩 —— 模型看到的是完整历史 373 条。
    //   而兜底挑中的是文件里最后那条（行 90），于是把行 91 起的 87 条历史当成
    //   「已被摘要取代」一并删掉：瘦身文件里 pi 只剩 284 条。
    //   表现就是 e2e 那句「271 vs 184」—— 用户以为文件变小了，实际是历史被偷了。
    //
    // 现在：只要文件有 parentId 结构（说明不是老平面格式），就**相信回溯结果**。
    // 链上没有压缩 = 没有可安全丢弃的历史，直接不瘦身。宁可不省空间，也不能丢历史。
    // 真·无分支的老文件（全都没 parentId）才走兜底，那条路是安全的：
    // 那种文件里「文件最后一条 compaction」本来就在唯一的线性历史里。
    const hasTree = entries.some((e) => e.obj && e.obj.parentId);
    const anyCompaction = entries.some((e) => e.obj?.type === "compaction");

    // 【老平面格式例外】整份文件一个 parentId 都没有 = 没有分支，文件行序就是历史顺序。
    // 这种文件用父链算法无从下手（path 只有 leaf 一条），按行号从最后一条压缩起裁剪
    // 才是正确且等价的。仅限这一种情形 —— 有 parentId 却掉链子的文件绝不能这样裁（见下）。
    if (!hasTree && anyCompaction) {
      let fci = -1;
      for (let i = 0; i < entries.length; i++) if (entries[i].obj?.type === "compaction") fci = i;
      const flat = [];
      if (headerIdx >= 0) flat.push(entries[headerIdx].raw);
      for (let i = fci; i < entries.length; i++) {
        if (i === headerIdx) continue;
        flat.push(entries[i].raw);
      }
      return {
        keepLines: flat,
        before,
        after: Buffer.byteLength(flat.join("\n") + "\n", "utf8"),
        savedEntries: entries.length - flat.length,
        compactionIdx: fci,
        firstKeptIdx: null,
        reason: null,
      };
    }

    if (hasTree) {
      return {
        keepLines: entries.map((e) => e.raw),
        before,
        after: before,
        savedEntries: 0,
        compactionIdx: null,
        firstKeptIdx: null,
        reason: anyCompaction
          ? "当前分支上没有压缩条目（历史里的压缩都挂在已断开的父链上），瘦身会丢掉模型仍看得见的历史"
          : "无压缩条目（未压缩过，无可丢弃历史）",
      };
    }
    for (let i = 0; i < entries.length; i++) if (entries[i].obj?.type === "compaction") ci = i;
  }

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
  if (!fkid) {
    return {
      keepLines: entries.map((e) => e.raw),
      before,
      after: before,
      savedEntries: 0,
      compactionIdx: null,
      firstKeptIdx: null,
      reason: "压缩条目没有 firstKeptEntryId，无法判断边界，放弃瘦身",
    };
  }

  // 【按父链裁，不按文件行号裁】
  //
  // 旧实现算的是「文件行号 >= start 的全保留」，这里有个致命假设：
  // **文件行序 == 父链顺序**。真实文件里两者并不一致 —— 分支、重排、历次裁剪
  // 都会让「父节点」在文件里排在子节点前面很远的地方。于是按行号一刀切，
  // 会把父链上的关键祖先拦腰截断：实测 151 条上下文直接塌成 1 条
  // （只剩压缩条目本身，firstKeptEntryId 压根不在路径上了）。
  //
  // pi 的 buildContextEntries 只看父链（path），**完全不看文件行序**，
  // 所以正确做法是：保留「从分支点到 leaf 的整条父链」，其余（死分支、旧历史）全丢。
  // 这样构造出来的路径与原来逐条一致，语义等价由构造保证，不靠运气。
  // 分支点在「父链」里的位置：压缩条目与它的 firstKeptEntryId 二者取较早的那个。
  // 取 min 是为了两种情况都对：
  //   · firstKept 在压缩之前（常规）：从 firstKept 起保留，压缩条目自然在其后；
  //   · firstKept 在压缩之后（少见）：从压缩起保留，firstKept 及其后仍在 path 上。
  const ciPath = path.findIndex((e) => e.id === entries[ci].obj?.id);
  const fiIdx = path.findIndex((e) => e.id === fkid);
  // firstKeptEntryId 缺失 / 不在父链上：pi 的 buildContextEntries 扫不到它就等于没匹配，
  // context 退化为「压缩条目 + 其后的路径条目」。此时从压缩条目起保留**正好等价**，
  // 所以不用拒绝，把 fiPath 退回 ciPath 即可。
  const fiPath = fiIdx >= 0 ? fiIdx : ciPath;
  const startPathIdx = ciPath >= 0 ? Math.min(ciPath, fiPath) : fiPath;

  const pathIdx = path.slice(startPathIdx);           // 裁剪后要保留的路径条目（按链序）
  const keepIds = new Set(pathIdx.map((e) => e.id).filter(Boolean));

  const lines = [];
  if (headerIdx >= 0) lines.push(entries[headerIdx].raw);

  let first = true;
  for (const e of pathIdx) {
    let raw = e.__raw;
    if (first) {
      // 分支点成为新的根：断掉指向已丢弃历史的 parentId。
      // 注意 path 元素是「条目本体 + __raw/__idx 两个内部字段」的扁平对象，
      // 不是 { obj, raw } 包装 —— 写回前必须把内部字段摘掉，否则会把它们塞进会话文件。
      if (e.parentId != null) {
        const { __raw, __idx, ...plain } = e;
        raw = JSON.stringify({ ...plain, parentId: null });
      }
      first = false;
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
    firstKeptIdx: path[fiPath]?.__idx ?? null,
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
