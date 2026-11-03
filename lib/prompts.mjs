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
import { PERSONA_DIR } from "./config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROMPT_DIR = path.join(ROOT, "prompt");

const cache = new Map();

/** 人设缓存：与 prompt/ 的 cache 分开，避免同名文件互相污染（必须声明在 loadPersona 之前） */
const personaCache = new Map();

/**
 * 读取**人设**文件。
 *
 * 【为什么不复用 loadPrompt("context", ...)】
 * 人设已随「私密数据收进 private/」迁到 PERSONA_DIR（默认 private/persona/；
 * 未启用 private 时回落 prompt/context/），而 loadPrompt 固定读
 * PROMPT_DIR/<sub>/<name>。注入点当初改漏了这一处：在 private 布局下
 * loadPrompt("context", "2x.md") 必然 ENOENT，又被上层 try/catch 静默吞掉 ——
 * 表现为「人设整段没注入」，而单测与冒烟全绿（它们只验证文件存在与内容自洽，
 * 从未走一遍运行时的读取路径），因此极难发现。
 *
 * 现在人设统一从这里读：调用方不再自己拼路径，路径只有这一个来源。
 *
 * @param {string} name 人设文件名（如 2x.md）
 * @returns {string} 人设文本
 * @throws {Error} 文件不存在时抛出 —— 调用方**必须记录告警，不要静默吞掉**
 */
export function loadPersona(name) {
  const file = path.join(PERSONA_DIR, name);
  if (personaCache.has(file)) return personaCache.get(file);
  const text = fs.readFileSync(file, "utf8");
  personaCache.set(file, text);
  return text;
}

/** 人设文件的绝对路径（供测试与导出过滤等需要路径的场景使用） */
export function personaPath(name) {
  return path.join(PERSONA_DIR, name);
}

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
export const pSystemAgent = () => loadPrompt("agent", "system.md");      // 主 agent 系统提示词
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
