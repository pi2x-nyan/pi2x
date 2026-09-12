/**
 * 自动压缩策略 —— 纯判定逻辑，与 pi SDK 解耦，便于单测
 *
 * 【为什么单独抽出来】
 * 这里曾经出过一个静默 bug：pi 的 `getContextUsage().percent` 量纲是 **0~100**（百分数），
 * 而阈值写成了 `0.70`（以为量纲是 0~1），等价于「上下文超过 0.7% 就压缩」，
 * 导致几乎每一轮对话都白做一次额外压缩调用（约 40 秒），并且日志把 percent 又乘了 100，
 * 打出 "1103%" 这种数字，反而掩盖了真实原因。
 *
 * 抽成纯函数 + 显式量纲命名 + 单测，就是为了让这类错误在下一次改动的第一时间被抓住。
 */

/** 触发判定：percent 与 threshold 必须是同一量纲（建议都用 0~100 的百分数） */
export function shouldCompact(percent, threshold = 70) {
  const p = Number(percent);
  const t = Number(threshold);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return false;
  return p >= t;
}

/** 防抖判定：正在压缩中 / 冷却期内 都不应再次触发 */
export function canTrigger({ compacting = false, lastCompactAt = 0, now = Date.now(), cooldownMs = 60000 } = {}) {
  if (compacting) return false;
  if (lastCompactAt && now - lastCompactAt < cooldownMs) return false;
  return true;
}

/** 安全读取阈值：非法值回落到默认，防止配置写错导致行为诡异 */
export function resolveThreshold(raw, fallback = 70) {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 供日志：把 percent 格式化成人类可读（不做任何乘除换算，避免二次缩放） */
export function fmtPercent(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return "?%";
  return `${p.toFixed(2)}%`;
}

/**
 * token 数的简短写法（移动端友好）：999 / 1.2K / 112K / 1.0M
 * 注意是 1000 进制而非 1024 —— 展示用，与模型的 contextWindow 口径一致。
 * @param {number} n
 */
export function fmtTokenCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "?";
  if (v < 1000) return String(Math.round(v));
  if (v < 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (v < 1000000) return `${Math.round(v / 1000)}K`;
  return `${(v / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * 组装「上下文占用」展示串（供 /status）。
 *
 * 量纲契约（重要）：pi 的 getContextUsage() 返回的 percent 已经是 **0~100**，
 * 这里**绝不再乘 100** —— 之前就因为二次缩放把 11% 打成过 1103%。
 *
 * 另外要注意 `Number(null) === 0`：pi 在「压缩后尚未产生新的助手回复」时
 * 会返回 `{tokens: null, percent: null}`，若直接 Number() 就会显示成「0.0%」，
 * 那是在撒谎（实际未知）。所以这里显式判 null/undefined。
 *
 * 长度控制在移动端一行内（≤25 半角，实测形如 `上下文 11.0% · 112K/1M`）。
 *
 * @param {{percent?:number|null, tokens?:number|null, contextWindow?:number|null}} u
 * @returns {string} 例如 `上下文 11.0% · 112K/1M`
 */
export function fmtContextUsage({ percent, tokens, contextWindow } = {}) {
  if (percent === null || percent === undefined) {
    return "上下文 待统计";
  }
  const p = Number(percent);
  if (!Number.isFinite(p)) return "上下文 待统计";

  const t = tokens === null || tokens === undefined ? NaN : Number(tokens);
  const w = contextWindow === null || contextWindow === undefined ? NaN : Number(contextWindow);
  if (Number.isFinite(t) && Number.isFinite(w) && w > 0) {
    return `上下文 ${p.toFixed(1)}% · ${fmtTokenCount(t)}/${fmtTokenCount(w)}`;
  }
  return `上下文 ${p.toFixed(1)}%`;
}

/**
 * 闲置压缩判定：会话长时间没有 LLM 调用、且上下文已经不小了 → 值得压一次。
 *
 * 【为什么需要「闲置」这条独立条件】
 * 原有的触发点只在**一轮对话结束时**检查百分比。于是有个尴尬情形：
 * 上下文停在 30% 不动（低于阈值 40%），但会话已经一小时没人说话 ——
 * 下次有人开口时，第一轮就要带着这 30% 的旧上下文去请求，
 * 而其中大半是早已无关的旧历史。闲置期正是压缩的最佳时机：
 * 此时没有任何人在等回复，压缩耗时（几十秒）完全不占用用户的等待时间。
 *
 * 【为什么默认是 23 小时这种"很久"】上游 prompt 缓存的生命周期实测在
 * 5~10 分钟到偶尔 24 小时之间浮动（Command Code 官方技术指南的口径）。
 * 短闲置时缓存可能还热着，此时压缩会把热缓存作废，反而让下一轮多花未命中成本；
 * 只有接近 24 小时才基本确定缓存已失效，压缩才是纯收益。
 *
 * 【为什么要「上下文大于某比例」这个附带条件】
 * 若上下文很小（例如刚压完只剩 5%），闲置时再压一次是纯浪费：
 * 摘要调用的成本与等待都白花，而且会把刚整理好的近期上下文又摘一遍。
 *
 * 参数取「**整轮结束**后过了多久」而非「距上次 LLM 调用多久」，也不是「距上次压缩多久」：
 *   · 「距上次 LLM 调用」会被轮内的工具调用刷新（一轮里工具可能跑很久），算出来偏短；
 *   · 「距上次压缩」只说明上次压过，不代表有没有人在用。
 *   「整轮结束」才准确表达「这一整轮活儿都干完了，之后这么久没人动过」。
 *
 * @param {object} p
 * @param {number} p.percent 当前上下文占模型窗口的比例（0~100，与 getContextUsage 同量纲）
 * @param {number} p.idleMs 距上次 LLM 调用经过的毫秒数
 * @param {number} [p.idleThresholdMs] 闲置多久算「久」（默认 23 小时）
 * @param {number} [p.percentFloor] 上下文至少要这么大才值得压（0~100，默认 20）
 * @returns {boolean}
 */
export function shouldCompactOnIdle(opts = {}) {
  // 注意用参数列表默认值挡不住 null：默认值只在 undefined 时生效，
  // `shouldCompactOnIdle(null)` 会直接抛 TypeError。所以这里显式兜底。
  const { percent, idleMs, idleThresholdMs = 23 * 60 * 60 * 1000, percentFloor = 20 } = opts ?? {};
  const p = Number(percent);
  const idle = Number(idleMs);
  const need = Number(idleThresholdMs);
  const floor = Number(percentFloor);
  if (!Number.isFinite(p) || !Number.isFinite(idle)) return false;
  if (!Number.isFinite(need) || need <= 0) return false;
  if (!Number.isFinite(floor) || floor < 0) return false;
  // 「上下文大于 20%」是严格大于：恰好等于 20% 不压（需求量就是这么定的）
  if (p <= floor) return false;
  return idle >= need;           // 整轮结束后闲置够久
}
