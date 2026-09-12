/**
 * 文本工具 —— 纯函数，无副作用，可独立单测
 */

/**
 * 字符 n-gram TF 余弦相似度（中文短文本重复检测）
 *
 * 用途：判定「模型已经用 qq_send_message 发过一段话，最终文本又冒出一段几乎一样的」
 * 从而避免重复发送。中文没有空格分词，用 bigram 覆盖足够稳。
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [g=2] gram 长度
 * @returns {number} 0~1
 */
export function cosineSim(a, b, g = 2) {
  if (!a || !b || typeof a !== "string" || typeof b !== "string") return 0;
  const vec = (s) => {
    const m = new Map();
    for (let i = 0; i <= s.length - g; i++) {
      const k = s.slice(i, i + g);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const va = vec(a);
  const vb = vec(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of va) {
    dot += v * (vb.get(k) || 0);
    na += v * v;
  }
  for (const v of vb.values()) nb += v * v;
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 工具调用 XML 文本泄漏检测（宽松匹配，容忍全角｜/DSML/乱码污染标签名）
 * 命中 "<…invoke … name=…"、"<…parameter … name=…" 或 "<…tool_calls…>" 即判泄漏。
 *
 * 背景：模型偶尔把工具调用协议以纯文本吐出来，用户会看到一堆 XML。
 * 这里宁可误判（停止流式，交上层用整段文本兜底），也不要把它发给用户。
 */
export function detectToolLeak(t) {
  if (!t) return false;
  const invoke = /<[^>]{0,60}?invoke[^>]{0,60}?\s+name\s*=/i.test(t);
  const parameter = /<[^>]{0,60}?parameter[^>]{0,60}?\s+name\s*=/i.test(t);
  const calls = /<[^>]{0,60}?tool_calls[^>]{0,10}?>/i.test(t) || /tool_calls/i.test(t);
  return (invoke && parameter) || (calls && invoke) || invoke;
}

/** 截断到 n 个字符，超出加省略号（日志/提示用） */
export function clip(s, n = 80) {
  const t = String(s ?? "");
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/** 人类可读的毫秒时长 */
export function fmtMs(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v)) return "?";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return `${m}m${s}s`;
}
