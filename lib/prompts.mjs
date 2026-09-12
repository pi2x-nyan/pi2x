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
export const pSystemAgent = () => loadPrompt("agent", "system.md");      // 主 agent 系统提示词
export const pSystemReviewer = () => loadPrompt("reviewer", "system.md"); // 评审系统提示词
export const pReviewerInput = (ctx) => prompt("reviewer", "input.md", ctx); // 评审输入前缀
export const pSessionContext = (ctx) => prompt("context", "session.md", ctx); // 会话上下文块
export const pRiskNote = (ctx) => prompt("risk", "note.md", ctx); // 风险研判

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
