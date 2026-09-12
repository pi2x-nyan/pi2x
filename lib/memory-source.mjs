/**
 * 记忆来源键（source）构造 —— 纯函数，可独立单测
 *
 * 【这个文件存在的理由：一个真实的 bug】
 * 「来源键怎么拼」原本散落在四处，各写各的：
 *
 *   lib/memory.mjs  harvest 写入   `${chatType}:${userId}`        ← 群聊时把用户QQ当群号
 *   lib/memory.mjs  injectText 读  `group:${targetId}`           ← 正确
 *   lib/piagent.mjs                `group:${ctx.targetId}`       ← 正确
 *   lib/tools/memory.mjs           `group:${ctx.targetId}`       ← 正确
 *
 * 写入端与读取端不一致，后果是：**群聊里收割的记忆全部检索不到**。
 * 实测库里有 9 条 `group:1000000001`（拿用户QQ当群号），在任何真实群里都是死数据。
 * 危害不只是丢数据 —— harvest 会把用户的偏好、路径、习惯写进「错误来源」的桶，
 * 既查不到，又在 group: 前缀下留下语义模糊的归属。
 *
 * 修法：规则收归一处（本文件），写入与读取调用同一个函数，并用测试锁死。
 */

/**
 * 由对话上下文构造记忆来源键。
 *
 * 语义约定：
 *   · 私聊 → `private:<用户QQ>`        —— 只对该用户可见
 *   · 群聊 → `group:<群号>`            —— **群内共享**（群里所有人可见，非按人隔离）
 *   · 信息不足 → 返回 null（调用方自行决定降级策略，绝不拼出半截键）
 *
 * ⚠ 注意群聊是「按群」而不是「按人」——这是刻意的设计（同群共享上下文）。
 *   因此群聊来源的记忆**不得**包含只对某人敏感的内容；那条线由 harvest 的
 *   sensitive 标注 + 检索时的群聊过滤共同保证（见 lib/memory.mjs 的 search）。
 *
 * @param {{chatType?:string, userId?:string|number, targetId?:string|number}} ctx
 * @returns {string|null}
 */
export function memorySourceOf(ctx) {
  const ct = ctx?.chatType;
  if (!ct) return null;
  if (ct === "group") {
    // 群聊必须用群号（targetId），绝不是用户号 —— 这正是曾经写错的地方
    if (!ctx?.targetId) return null;
    return `group:${ctx.targetId}`;
  }
  if (!ctx?.userId) return null;
  return `private:${ctx.userId}`;
}

/**
 * 判断某个来源键是否属于某会话（与 lib/memory.mjs 的 _sourceMatch 同语义）。
 * 抽出来是为了让「写入用哪个键、读取用哪个键」能在测试里对着验。
 *
 * @param {string} rSource 记忆里存的来源
 * @param {string} filter  查询时给的过滤键
 */
export function sourceMatches(rSource, filter) {
  const s = String(rSource ?? "");
  const f = String(filter ?? "");
  if (!f) return true;
  if (f.endsWith(":")) return s.startsWith(f);
  if (f === "seed") return s === "seed";
  return s === f || s.startsWith(`${f}:`);
}

export default { memorySourceOf, sourceMatches };
