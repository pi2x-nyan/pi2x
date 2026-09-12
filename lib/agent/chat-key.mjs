/**
 * 会话键（chatKey）构造 —— 纯函数，可独立单测
 *
 * 【为什么抽出来】
 * 「会话键怎么拼」这件事散落在两处：
 *   · bridge.mjs 收消息时拼 `private:<uid>` / `group:<gid>`
 *   · lib/piagent.mjs 里再给群会话追加 `:<uid>` 做按人隔离
 * 内置命令（如 /status）不走收消息流程，需要**自己按同样的规则**反推出会话键，
 * 一旦两处规则漂移，就会「查不到会话」这类难查的 bug。
 * 抽成纯函数后，规则只有一处定义，且能被测试锁住。
 */

/**
 * 由「对话上下文」推出会话键。
 *
 * @param {{chatType?:string, userId?:string|number, targetId?:string|number}} ctx
 * @returns {string|null} 例如 private:1000000001 / group:1077971815:1000000001；信息不足返回 null
 */
export function chatKeyOf(ctx) {
  const ct = ctx?.chatType;
  if (!ct) return null;
  if (ct === "group") {
    if (!ctx?.targetId || !ctx?.userId) return null;
    // 群消息按用户隔离：group:<群号>:<用户号>（权限与上下文各自独立，避免跨用户串权限）
    return `group:${ctx.targetId}:${ctx.userId}`;
  }
  if (!ctx?.userId) return null;
  return `private:${ctx.userId}`;
}

/**
 * 由收消息时的基础键 + 用户号推出最终会话键（供 _getSession 用）。
 * 与 chatKeyOf 保持同一套规则：群会话按人隔离，私聊不追加。
 *
 * @param {string} baseKey 形如 private:<uid> 或 group:<gid>
 * @param {string|number} userId
 * @returns {string}
 */
export function sessionKeyOf(baseKey, userId) {
  return String(baseKey).startsWith("group:") ? `${baseKey}:${userId}` : String(baseKey);
}

/**
 * 从活跃会话表里挑出「应该拿它的上下文占用来展示」的那一个。
 *
 * 优先级：
 *   1) 指定的会话键（/status 知道是谁在问）
 *   2) 正在流式输出的那个（通常就是正在处理这条命令的会话）
 *   3) 最后一个（Map 保留插入序，最后创建的通常最相关）
 *
 * @param {Map<string, any>} sessions
 * @param {string|null} [key]
 * @returns {any|null}
 */
export function pickSessionEntry(sessions, key = null) {
  if (!sessions || typeof sessions.values !== "function") return null;
  if (key && sessions.has?.(key)) return sessions.get(key);
  const all = [...sessions.values()];
  if (!all.length) return null;
  return all.find((e) => e?.session?.isStreaming) ?? all[all.length - 1] ?? null;
}

export default { chatKeyOf, sessionKeyOf, pickSessionEntry };
