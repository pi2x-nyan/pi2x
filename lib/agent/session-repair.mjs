/**
 * 会话历史完整性修复 —— 孤儿 toolResult 的检测与剔除。
 *
 * 【为什么需要：2026-10-25 那次「bot 死了 3 天」】
 *
 * 现场证据（取自 private/sessions/private_3573297011.jsonl 的 trim 前备份）：
 *
 *     行87  type=custom_message role=custom_message
 *     行88  type=message role=toolResult  toolCallId=call_14c2a48e...  tool=set_reminder
 *     行89  type=message role=assistant   parts=['toolCall']  toolCallId=call_379c8341...
 *
 * 第 88 行那条 toolResult 的 toolCallId 是 call_14c2a48e...，而它前面那条 assistant
 * 带的是 call_379c8341... —— 也就是说**调用记录丢了、结果还在**。
 *
 * OpenAI 兼容接口（本项目走 omniroute 网关）对此的反应是**整条请求** 400：
 *
 *     Messages with role 'tool' must be a response to a preceding message with
 *     'tool_calls' (request_id: 806cd069-...)
 *
 * 于是该会话此后每一次请求都必然失败 → 模型一个 delta 都不吐 → 上层判定「返回空内容」
 * → 用户看到的就是「（这次模型返回了空内容）」。
 *
 * 时间线（真实日志）：
 *   10-22 09:56  submit 超时（Request timed out）
 *   10-22 09:58  400 开始，此后每一轮都是 400
 *   10-23 10:45  仍然 400（用户发「1」那次，等了 20 分钟）
 *   10-25 14:03  手工 trim 掉那条孤儿记录 → 立刻恢复
 *
 * 整整 3 天，只因为历史里多了一条对不上的工具结果。而且**外界完全看不出**：
 * 日志里只有「回复 33 字」（那 33 字是兜底文案），没有一条 400 —— 400 藏在
 * assistant 消息的 errorMessage 字段里，不在 bridge.log 里。
 *
 * 这个模块负责把这类「结构上非法」的历史条目剔掉。剔的时候必须**重新接线**：
 * 会话是以 parentId 串起来的树，直接删节点会让它的子树全部断链。
 */

/** assistant 消息里所有 toolCall 的 id */
export function toolCallIdsOf(message) {
  const c = message?.content;
  if (!Array.isArray(c)) return [];
  return c.filter((p) => p && p.type === "toolCall" && p.id).map((p) => p.id);
}

/**
 * 找出孤儿 toolResult（找不到对应 toolCall 的那些）。
 *
 * 判定口径：按文件顺序走，assistant 消息给出「待回应的 toolCall 集合」，toolResult 消费其中一个。
 * toolResult 的 toolCallId 不在当前集合里 → 孤儿。
 *
 * 注意：这里**只**认「前面出现过、且尚未被消费」的 toolCall。
 * 之所以要求顺序在前，是因为 OpenAI 协议本身就这么要求 —— 结果消息必须跟在它的调用后面。
 *
 * @param {Array<{type?:string, message?:any}>} entries 会话条目（按文件顺序）
 * @returns {number[]} 孤儿条目在数组中的下标
 */
export function findOrphanToolResults(entries) {
  const out = [];
  let pending = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== "message") continue;
    const m = e.message ?? {};
    if (m.role === "assistant") {
      pending = new Set(toolCallIdsOf(m));
      continue;
    }
    if (m.role === "toolResult") {
      const id = m.toolCallId;
      if (id && pending.has(id)) pending.delete(id);
      else out.push(i);
    }
  }
  return out;
}

/**
 * 剔除孤儿 toolResult，并把被删节点的子节点重新接到其父节点上。
 *
 * 【为什么要重新接线】条目是 parentId 树：
 *    A ← B(孤儿) ← C
 * 直接删 B，C 的 parentId 还指向 B，整棵子树就从主链上断了（pi 读会话时会丢掉 C 之后的内容）。
 * 所以要把 C.parentId 改成 A.id。
 *
 * 被删节点若有多个子节点，全部接到同一个父节点上（等同于把它们都挂在 A 下）。
 *
 * @param {Array<any>} entries 原始条目
 * @returns {{entries: Array<any>, removed: Array<{index:number, toolCallId?:string, toolName?:string}>}}
 */
export function repairEntries(entries) {
  const orphanIdx = findOrphanToolResults(entries);
  if (!orphanIdx.length) return { entries, removed: [] };

  const dropSet = new Set(orphanIdx);
  const removed = orphanIdx.map((i) => {
    const m = entries[i]?.message ?? {};
    return { index: i, toolCallId: m.toolCallId, toolName: m.toolName };
  });

  // 父链映射：删除节点的 parentId 就是它子节点该接的位置。
  // 链式删除（连续多个孤儿）时要一路往上找，直到找到一个没被删的祖先。
  const parentOf = (idx) => {
    let p = entries[idx]?.parentId ?? null;
    let guard = 0;
    while (p && guard++ < 1000) {
      const pIdx = entries.findIndex((e) => e?.id === p);
      if (pIdx < 0) break;            // 父节点不在文件里（被更早的压缩切掉了）→ 保持原值
      if (!dropSet.has(pIdx)) break;  // 找到还活着的祖先
      p = entries[pIdx]?.parentId ?? null;
    }
    return p;
  };

  const out = [];
  for (let i = 0; i < entries.length; i++) {
    if (dropSet.has(i)) continue;
    const e = entries[i];
    // 该节点的 parentId 若指向被删节点，改接到被删节点的父节点
    if (e && typeof e === "object" && e.parentId) {
      const pIdx = entries.findIndex((x) => x?.id === e.parentId);
      if (pIdx >= 0 && dropSet.has(pIdx)) {
        out.push({ ...e, parentId: parentOf(pIdx) });
        continue;
      }
    }
    out.push(e);
  }
  return { entries: out, removed };
}

/**
 * 对会话文件做修复（有孤儿才写盘）。
 *
 * 写盘前会留一份 .bak-repair-<时间戳>，出错可回滚。
 * 解析不了的行原样保留 —— 宁可留着垃圾，也不能因为一行坏数据把整段历史清掉。
 *
 * @param {string} file 会话 jsonl 路径
 * @param {{fs?:any, now?:()=>number}} [deps] 便于测试注入
 * @returns {{ok:boolean, removed:Array, backup?:string, error?:string}}
 */
export function repairSessionFile(file, deps = {}) {
  const fs = deps.fs ?? null;
  const now = deps.now ?? (() => Date.now());
  if (!fs || !fs.existsSync(file)) return { ok: true, removed: [] };

  const text = fs.readFileSync(file, "utf8");
  const rawLines = text.split("\n");
  const entries = [];
  const indexOfLine = [];      // entries 下标 → 原始行号
  const parsedFlags = [];      // entries 下标 → 是否成功解析

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
      indexOfLine.push(i);
      parsedFlags.push(true);
    } catch {
      entries.push({ __raw: line });
      indexOfLine.push(i);
      parsedFlags.push(false);
    }
  }

  const { entries: kept, removed } = repairEntries(entries.filter((e) => !e.__raw).length === entries.length ? entries : entries);
  if (!removed.length) return { ok: true, removed: [] };

  // 按 id 对齐回原始行：没解析成功的行、以及未被删的行，保持原顺序原内容
  const droppedIds = new Set(removed.map((r) => entries[r.index]?.id).filter(Boolean));
  const patchedById = new Map();
  for (const e of kept) if (e && e.id) patchedById.set(e.id, e);

  const outLines = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!parsedFlags[i]) { outLines.push(rawLines[indexOfLine[i]]); continue; }
    if (e && e.id && droppedIds.has(e.id)) continue;              // 删掉孤儿
    const patched = e && e.id ? patchedById.get(e.id) : e;
    outLines.push(JSON.stringify(patched ?? e));
  }

  const backup = `${file}.bak-repair-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.writeFileSync(backup, text);
    fs.writeFileSync(file, outLines.join("\n") + (text.endsWith("\n") ? "\n" : ""));
  } catch (err) {
    return { ok: false, removed, error: err?.message ?? String(err) };
  }
  return { ok: true, removed, backup };
}

/** 模型返回的 400 里，指向「工具结果没有对应调用」的那种（多种措辞都收） */
const TOOL_ORPHAN_400_RE =
  /tool['"]?\s*must be a response to a preceding message with\s*['"]?tool_calls|tool_call_id.*not found|messages with role 'tool'/i;

/**
 * 判断一条模型错误信息是不是「历史里有孤儿工具结果」导致的 400。
 *
 * 命中就说明：重试多少次都没用，必须先修历史。这是「止暴」的关键判据 ——
 * 原先没做这一步，于是同一个 400 被重试了 3 天。
 *
 * @param {unknown} errMsg
 * @returns {boolean}
 */
export function isOrphanToolResultError(errMsg) {
  if (!errMsg) return false;
  return TOOL_ORPHAN_400_RE.test(String(errMsg));
}
