/**
 * PI2X 提示词中心 —— 统一从 prompt/ 目录读取与渲染
 *
 * 所有注入给 LLM 的提示词文本都放在项目根 prompt/ 的子文件夹（按类别）：
 *   prompt/agent/system.md     主 agent 系统提示词
 *   prompt/reviewer/system.md  评审 subagent 系统提示词
 *   prompt/reviewer/input.md   评审 subagent 输入前缀（动态占位）
 *   prompt/context/session.md  会话上下文块（动态占位）
 *   prompt/risk/note.md        风险研判注入（动态占位）
 *
 * 代码不再内联提示词字符串，统一经此读取/渲染，便于维护与分类。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, DEFAULTS } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { loadCard, assembleSystemPrompt } from "./persona-card.mjs";

const logPi = createLogger("pi");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROMPT_DIR = path.join(ROOT, "prompt");

const cache = new Map();

/** 读取一个提示词文件（带缓存） */
export function loadPrompt(sub, name) {
  const file = path.join(PROMPT_DIR, sub, name);
  if (cache.has(file)) return cache.get(file);
  const text = fs.readFileSync(file, "utf8");
  cache.set(file, text);
  return text;
}

/** 渲染模板：把 {{KEY}} 占位符替换为 ctx 里的值 */
export function render(raw, ctx = {}) {
  return String(raw).replace(/\{\{(\w+)\}\}/g, (_, k) => (k in ctx ? String(ctx[k]) : ""));
}

/** 便捷读取+渲染 */
export function prompt(sub, name, ctx = {}) {
  return render(loadPrompt(sub, name), ctx);
}

// ── 常用入口 ──

/**
 * 把角色卡叠到基础 system prompt 上。
 *
 * enabled=false（默认）时**原样返回 base**，连 trim 都不做 —— 保证关闭角色卡
 * 后模型看到的内容与迁移前完全一致。启用后若卡文件缺失/损坏，用 logPi.warn
 * 出声再回退 base：宁可不带人设，也不能静默把 system prompt 变成空串。
 *
 * @param {string} base 基础 system prompt（prompt/agent/system.md）
 * @param {{enabled?:boolean, cardFile?:string}} [persona] 默认取 config.pi.persona
 * @returns {string}
 */
export function applyPersona(base, persona = config.pi?.persona) {
  if (!persona?.enabled) return base;

  const rawFile = persona.cardFile || DEFAULTS.pi.persona.cardFile;
  const cardFile = path.isAbsolute(rawFile) ? rawFile : path.resolve(ROOT, rawFile);
  try {
    const card = loadCard(cardFile);
    return assembleSystemPrompt({ base, card });
  } catch (err) {
    logPi.warn(`角色卡装配失败，回退为基础 system prompt：${err?.message}`);
    return base;
  }
}

export const pSystemAgent = () => applyPersona(loadPrompt("agent", "system.md")); // 主 agent 系统提示词
export const pSystemReviewer = () => loadPrompt("reviewer", "system.md"); // 评审系统提示词
export const pReviewerInput = (ctx) => prompt("reviewer", "input.md", ctx); // 评审输入前缀
export const pSessionContext = (ctx) => prompt("context", "session.md", ctx); // 会话上下文块
export const pRiskNote = (ctx) => prompt("risk", "note.md", ctx); // 风险研判
export const pProactive = () => loadPrompt("proactive", "heartbeat.md"); // 主动回合指令
export const pProactiveEvent = () => loadPrompt("proactive", "event.md"); // 事件回合指令

/**
 * 安全模式系统提示词。
 *
 * 【为什么需要"读不到就用兜底"】
 * 安全模式本身就是「正常模式因代码/依赖坏掉而起不来」时的急救通道，
 * 而提示词文件损坏正是可能的原因之一。若这里直接 loadPrompt，
 * 一旦 prompt/safe/system.md 缺失/损坏，安全模式会二次崩溃——急救通道就断了。
 * 因此：提示词正文放 prompt/（统一管理），代码内保留一份等价兜底。
 *
 * @param {string} fallback 兜底文案（调用方持有，含 GIVEUP_TOKEN 等动态值）
 */
export function pSystemSafe(fallback = "") {
  try {
    return loadPrompt("safe", "system.md");
  } catch {
    return fallback;
  }
}

/**
 * 安全模式的自护提醒（禁止自伤动作）。同 pSystemSafe：文件优先、代码兵底。
 * @param {string} fallback 兵底文案
 */
export function pSystemSelfGuard(fallback = "") {
  try {
    return loadPrompt("safe", "self-guard.md").trim();
  } catch {
    return fallback;
  }
}

/**
 * 空回复重试时注入的纠正指令（模型返回空内容 → 让它重新正常回答）。
 * 正文：prompt/retry/empty-reply.md
 */
export const pRetryEmptyReply = () => loadPrompt("retry", "empty-reply.md").trim();

/**
 * 工具调用文本泄露——连续超限时让模型输出一句失败提示。
 * 正文：prompt/retry/leak-final.md
 */
export const pRetryLeakFinal = () => loadPrompt("retry", "leak-final.md").trim();

/**
 * 工具调用文本泄露——未超限时要求模型重走真实工具通道。
 * 正文：prompt/retry/leak-retry.md
 */
export const pRetryLeakRetry = () => loadPrompt("retry", "leak-retry.md").trim();

/**
 * 工具描述（label + description）——从 prompt/tools/<name>.md 读取解析。
 * 文件格式：frontmatter label + 正文 description；正文可用 {{KEY}} 占位符。
 * @param {string} name 工具名
 * @param {object} [ctx] 占位符值（如 { SANDBOX: "/path" }）
 * @returns {{label:string, description:string}}
 */
export function pTool(name, ctx = {}) {
  const raw = loadPrompt("tools", `${name}.md`);
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw.trimStart());
  let label = "";
  let body = raw;
  if (fm) {
    const meta = fm[1];
    label = /label:\s*(.*)/.exec(meta)?.[1]?.trim() ?? "";
    body = fm[2];
  }
  return { label, description: render(body, ctx).trim() };
}
