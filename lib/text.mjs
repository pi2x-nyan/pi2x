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

/* ─────────────────────────── 注入块边界 ─────────────────────────── */

/**
 * 每请求临时注入块的统一边界标记。
 *
 * 【为什么需要它】
 * 记忆 / 全局记忆 / 权限白名单 / 风险研判这些块，都是我们**自己**往报文尾部塞的，
 * 不是用户说的话。但它们原先只靠「【记忆】」这种标题与正文区分，挂上去之后
 * 和用户原话在同一段文本里、排版也一样 —— 于是模型（我）会把它们当成用户的发言，
 * 顺着不存在的「用户要求」往下推理。
 *
 * 2026-09-14 真实事故：把 bridge.log 里的历史行、把注入的记忆条目当成主人说过的话，
 * 连续几次凭空「引用」不存在的用户消息（「你说的不行」「这个问题问得关键」）。
 *
 * 加上显式的首尾机器标记后，边界在报文里是**结构性的、不可能看错**的：
 *   用户原话
 *
 *   <<<INJECTED:CONTEXT>>>        ← 以下全部是系统注入，不是用户说的话
 *   ...
 *   <<<END:INJECTED>>>
 *
 * 标记用尖括号包裹的纯 ASCII，不用中文方括号 —— 避免与正文里的【】混淆。
 */
export const INJECT_BEGIN = "<<<INJECTED:CONTEXT>>>";
export const INJECT_END = "<<<END:INJECTED>>>";

/** 包一层边界标记；空内容返回空串（调用方据此跳过注入） */
export function wrapInjected(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  return `${INJECT_BEGIN}\n${t}\n${INJECT_END}`;
}

/** 文本里是否含注入块（供剥离/校验用） */
export function hasInjectedBlock(text) {
  return String(text ?? "").includes(INJECT_BEGIN);
}

/**
 * 从文本里剥掉注入块（含边界标记本身）。
 * 与 MemoryStore.stripInjectedBlocks 的分工：那个按旧标记剥（【全局】/【记忆】，
 * 兼容历史残留）；这个按新边界剥，是当前注入形态的主力。
 */
export function stripWrappedInjected(text) {
  let t = String(text ?? "");
  for (;;) {
    const i = t.indexOf(INJECT_BEGIN);
    if (i < 0) break;
    const j = t.indexOf(INJECT_END, i);
    if (j < 0) {
      t = t.slice(0, i); // 没闭合：从起点整段丢
      break;
    }
    t = t.slice(0, i) + t.slice(j + INJECT_END.length);
  }
  return t.trim();
}
