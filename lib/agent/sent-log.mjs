/**
 * 本轮「已由工具发送」记录 —— 用于避免最终文本与工具已发内容重复
 *
 * 场景：模型先调用 qq_send_message 把一段话发给用户，回合结束时又把这同一段话
 * 作为最终文本返回。若不检测，用户会收到两遍。
 *
 * 这是一个**进程级共享小状态**（工具写、组装器读），所以抽成独立模块，
 * 不再散落在 piagent.mjs 的模块顶层变量里。
 */

/** 滚动窗口上限：只保留最近 N 条，防止长跑进程内存缓慢增长 */
export const MAX_ENTRIES = 100;

const entries = []; // [{ ts, message }]

/** 记录一次成功的工具发送 */
export function markSent(message) {
  entries.push({ ts: Date.now(), message: String(message ?? "") });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** 取某个时间点之后的所有已发内容 */
export function sentSince(ts) {
  return entries.filter((s) => s.ts >= ts).map((s) => s.message);
}

/** 全部已发内容（调试用） */
export function allSent() {
  return entries.slice();
}

/** 清空（测试用） */
export function resetSent() {
  entries.length = 0;
}
