/**
 * 「修不好，请回退」信号 —— 安全模式下由 agent 自己发起的降级
 *
 * 【为什么由 agent 判断，而不是外部计数】
 * 「安全模式连续 N 次拉不起来 → 回退」这种机械规则，只能识别「进程根本没起来」。
 * 但真正难判的是「起来了、能说话，但修不动」——比如代码坏得很深、依赖装不回来、
 * 或者我反复改都改不对。这种情况只有**在局内的 agent** 才知道。
 * 让会思考的那个角色说「我不行了」，比让一个笨看门狗数次数要准得多。
 *
 * 【两条通道（都实现，互为兜底）】
 *  1. **工具通道（首选）**：注册 declare_unfixable 工具。模型调用它 → 明确、可带原因、
 *     不会和普通文本混淆。
 *  2. **文本令牌通道（兜底）**：万一工具调用失败（比如模型上下文混乱、工具协议出问题），
 *     回复里出现约定令牌也会被识别。实现一个宽容的匹配器——
 *     接受 [[PI2X:GIVEUP]] / {"status":"XXXFAILED"} / <pi2x>GIVEUP</pi2x> 等多种写法。
 *
 * 【为什么要有兜底】工具通道依赖模型正确调用工具；而安全模式的场景恰恰是「环境不太正常」，
 * 多一条不依赖工具协议的路径，成本很低、收益很高。
 */
import { ROOT } from "../config.mjs";

/** 主令牌：明确、不可能在日常对话里偶然出现 */
export const GIVEUP_TOKEN = "[[PI2X:GIVEUP]]";

/**
 * 宽容匹配「放弃」信号。
 * 接受形式（大小写不敏感）：
 *   [[PI2X:GIVEUP]]            ← 推荐
 *   {"status":"XXXFAILED"}     ← 用户提到的 JSON 风格
 *   <pi2x>GIVEUP</pi2x>        ← XML 风格
 *   PI2X_GIVEUP / GIVEUP 单独成行
 *
 * @param {string} text
 * @returns {{hit:boolean, reason:string, matched:string|null}}
 */
export function detectGiveup(text) {
  const s = String(text ?? "");
  if (!s) return { hit: false, reason: "", matched: null };

  const patterns = [
    { re: /\[\[\s*PI2X\s*:\s*GIVEUP\s*\]\]/i, name: "token" },
    { re: /<\s*pi2x\s*>\s*GIVEUP\s*<\s*\/\s*pi2x\s*>/i, name: "xml" },
    { re: /"status"\s*:\s*"[A-Z0-9_]*FAILED[A-Z0-9_]*"/i, name: "json" },
    { re: /^\s*PI2X[_-]GIVEUP\s*$/im, name: "plain" },
  ];
  for (const p of patterns) {
    const m = p.re.exec(s);
    if (m) return { hit: true, reason: extractReason(s), matched: m[0] };
  }
  return { hit: false, reason: "", matched: null };
}

/** 抓取「原因」：令牌同一行或紧随其后的文字，没有就返回空串 */
function extractReason(s) {
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/GIVEUP|FAILED/i.test(lines[i])) {
      const same = lines[i].replace(/\[\[.*?\]\]|<[^>]+>|"/g, " ").trim();
      const next = (lines[i + 1] ?? "").trim();
      return [same, next].filter(Boolean).join(" ").slice(0, 200);
    }
  }
  return "";
}

/** 给 agent 的工具描述（写死在代码里，安全模式不读 prompt/ 目录） */
export const GIVEUP_TOOL_SPEC = {
  name: "declare_unfixable",
  description:
    "当你在安全模式下**确实无法修复**正常模式时调用此工具，请求系统回退到上一个已验证可用的版本。\n" +
    "调用前请务必：1) 确认已经做过诊断；2) 至少尝试过一种修复方案并失败；3) 在 reason 里写清你试过什么、卡在哪。\n" +
    "注意：这会放弃当前的代码改动（回退到上一个可用版本），**不要轻易调用**。\n" +
    "若你还有可行的修复思路，请先动手试，不要调用本工具。",
  parameters: {
    reason: "为什么无法修复：已经尝试过什么、失败在哪里（必填，写详细）",
    suggestion: "给人看的建议：可能需要人工做什么（可选）",
  },
};

/**
 * 回退动作 —— 调用纯回退脚本（scripts/rollback.mjs）。
 * 抽成函数便于测试时注入假实现。
 *
 * @param {{reason?:string, runner?:Function}} [opts]
 */
export function triggerRollback({ reason = "", runner } = {}) {
  if (typeof runner === "function") return runner({ reason });
  // 动态 import：避免安全模式在正常路径就把它拖进依赖图
  return import("node:child_process").then(({ spawnSync }) =>
    spawnSync(process.execPath, [new URL("../../scripts/rollback.mjs", import.meta.url).pathname, "--reason", reason], {
      cwd: ROOT,
      encoding: "utf8",
    })
  );
}

export default { GIVEUP_TOKEN, detectGiveup, GIVEUP_TOOL_SPEC, triggerRollback };
