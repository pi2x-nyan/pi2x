/**
 * reply-guard —— 拦住「控制词当正文」的回复
 *
 * 背景（2026-10-31）：
 *   主动轮协议里 `SKIP` 表示「本轮不说话」，只该由系统识别。但模型会把这条协议
 *   当成一个可用的**答案**，于是普通对话里冒出「跳过」这种孤零零的词，用户收到
 *   一条没有信息量的回复。加提示词不够，这里做代码兜底：命中的整段不发。
 *
 * 判据刻意收得很窄 —— 只认「整段回复就是一个控制词」：
 *   · 「跳过」→ 拦
 *   · 「跳过这一步，直接看第二页」→ 放行（是有内容的话）
 */

/** 允许出现在控制词两侧的装饰：空空白、反引号、引号、中英文标点、波浪号 */
const DECOR = /^[\s`'"“”‘’《》()（）[\]【】.。!！?？~～…、,，:：;；-]*|[\s`'"“”‘’《》()（）[\]【】.。!！?？~～…、,，:：;；-]*$/g;

const CONTROL_WORDS = new Set([
  "SKIP",
  "跳过",
  "略过",
  "算了",
  "省略",
  "无",
  "无内容",
  "略",
]);

/**
 * 判断这段文本是不是「只有控制词」。
 * @param {unknown} text
 * @returns {boolean}
 */
export function isControlWordOnly(text) {
  const raw = String(text ?? "");
  if (!raw) return false;
  if (raw.length > 24) return false; // 长句不可能是控制词
  const core = raw.replace(DECOR, "").trim();
  if (!core) return false;
  return CONTROL_WORDS.has(core.toUpperCase());
}

/**
 * 本轮该不该算「空回复」（→ 触发上层的空回复重试）。
 *
 * 关键区别在主动轮：主动轮里 `SKIP` 是**合法协议**（本轮不说话），
 * 不该被当成"模型什么都没说"去重试 —— 否则重试再空，用户就收到一句
 * 「（这次模型返回了空内容）」（2026-11-01 实际发生）。
 *
 * @param {{bufText?: string, ctrlOnly?: boolean, controlWordSilent?: boolean,
 *          toolSent?: boolean, streamedOk?: boolean}} a
 */
export function shouldTreatAsEmpty({ bufText, ctrlOnly, controlWordSilent, toolSent, streamedOk }) {
  const ctrlSilent = !!ctrlOnly && !!controlWordSilent;
  return !String(bufText ?? "") && !ctrlSilent && !toolSent && !streamedOk;
}

/**
 * 说话方式的机械兜底：句号换行。
 *
 * 提示词里早写了「不打句号」，但只要模型一段写长，就会漏。
 * 与其每轮提醒自己去检查，不如在出口把「。」换成换行 —— 这本来就是那条规则
 * 想要的效果（句子之间用换行断开）。代码里做，永远不会忘。
 *
 * 只动全角句号；半角 . 保留（小数、域名、代码里到处是）。
 */
export function normalizeStyle(text) {
  const s = String(text ?? "");
  if (!s.includes("。")) return s;
  return s
    .replace(/。+/g, "\n")      // 连写的句号合成一个换行
    .replace(/[ \t]+\n/g, "\n")  // 行尾空格去掉
    .replace(/\n{3,}/g, "\n\n")  // 空行最多留一行
    .trimEnd();
}
