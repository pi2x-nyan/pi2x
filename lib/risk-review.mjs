/**
 * PI2X 请求风险评估 —— 工作流级评审器（非模型工具）
 *
 * 定位：把「对非 admin 用户请求做风险评估」从主 agent 的提示词软约束，
 * 升格为工作流强制环节。主 agent 不再自行判定风险，而是由本模块在
 * 消息/动作进入主 agent 之前先评审，输出 allow / confirm / deny。
 *
 * 两层：
 *   1) 本地规则快筛（秒级、可预测、不耗 LLM）—— 明显危险直接 deny，
 *      明显安全直接 allow，拿不准才交 LLM 精判。
 *   2) 评审 LLM 单发请求（不建会话、不落盘、不多轮）—— 输入请求原文，输出结构化分级 JSON。
 *
 * 评审不可执行任何操作（纯文本单发，无工具）。
 */
import { pSystemReviewer, pReviewerInput } from "./prompts.mjs";

// ─────────────────────────── 本地规则快筛 ───────────────────────────

// ─────────────────────── 评审 LLM 提示词 ───────────────────────

// 评审系统提示词（从 prompt/reviewer/system.md 读取）
const REVIEW_SYSTEM_PROMPT = pSystemReviewer();

/** 评审 subagent 输入前缀：把请求与上下文拼成一次评审任务 */
function buildReviewInput({ userId, chatType, targetId, userName, preset, userText }) {
  return pReviewerInput({
    CHAT_TYPE: chatType === "group" ? "群聊" : "私聊",
    USER_ID: userId,
    USER_NAME: userName || "未知",
    PRESET: preset,
    USER_TEXT: userText,
  });
}

/**
 * 主入口：对一次「非 admin 请求」做风险评估。
 * @param {{userId:string, chatType:string, targetId:string, userName?:string, preset:string, userText:string, reviewSession?:any}} ctx
 * @returns {Promise<{level:string, action:string, reason:string, source:string}>}
 */
export async function assessRequest(ctx) {
  // 评审 LLM 单发请求（不建会话、不落盘、不多轮，限 maxTokens）
  try {
    const input = buildReviewInput(ctx);
    const res = await ctx.modelRuntime.complete(ctx.model, {
      messages: [
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
    }, { timeoutMs: 30000, maxTokens: 300 });
    const reply = _textOf(res) || "{}";
    const parsed = _extractJson(reply) || {};
    return {
      level: ["low", "medium", "high", "critical"].includes(parsed.level) ? parsed.level : "medium",
      action: ["allow", "confirm", "deny"].includes(parsed.action) ? parsed.action : "confirm",
      reason: parsed.reason || "需人工确认",
      source: "review",
    };
  } catch (e) {
    // 评审失败按保守处理：需要确认，而不是放行
    return { level: "medium", action: "confirm", reason: `评审失败，保守处理: ${e?.message}`, source: "review-error" };
  }
}

/** 从评审输出中提取 JSON 对象（容错：剥 markdown 围栏、逐个尝试可能的 {…} 块） */
function _extractJson(text) {
  const t = String(text || "").replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{") continue;
    for (let j = t.length - 1; j >= i; j--) {
      if (t[j] !== "}") continue;
      try { return JSON.parse(t.slice(i, j + 1)); } catch { /* try next */ }
    }
  }
  return null;
}

/** 取 assistant 消息文本 */
function _textOf(res) {
  if (!res) return "";
  const c = res.content;
  if (Array.isArray(c)) return c.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join("");
  return typeof c === "string" ? c : "";
}

// 供 test 单测引用
export const _internal = { buildReviewInput, REVIEW_SYSTEM_PROMPT };
