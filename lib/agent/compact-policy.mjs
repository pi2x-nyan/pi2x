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
