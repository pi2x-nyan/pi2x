/**
 * 角色卡（Character Card V2 子集）—— 人设从写死的 system.md 迁到卡文件
 *
 * 【迁移说明】
 * prompt/agent/system.md 前 13 行的「妹妹」角色人设原文，已**一字不改**地
 * 搬进 private/persona/card.json 的 description 字段；system.md 只保留
 * 「干活的样子」运维规则。
 *
 * system.md 里不要再写迁移注释：它会被整体注入模型，注释同样占上下文、
 * 干扰行为。所有迁移/维护说明都留在本文件头部。
 *
 * 卡文件属于私密数据（private/ 已被 .gitignore 整目录忽略），不进仓库；
 * 本模块只负责读取、校验与拼装，不内置任何人设正文。
 *
 * 【为什么失败必须抛错】
 * 人设曾经被静默吞成空串而丢失过一次。loadCard 对「文件不存在 / JSON 语法错 /
 * 字段类型不对」一律抛错，由调用方（lib/prompts.mjs 的 pSystemAgent）用
 * logPi.warn 出声后再降级；绝不允许静默返回一张空卡。
 *
 * 【字段】
 * 只认 Character Card V2 的一个子集，且全部可选：
 *   name / description / personality / scenario / first_mes / mes_example /
 *   system_prompt / post_history_instructions
 * 其余未知字段原样收进返回值的 extensions，不报错（保住 V2 的扩展位）。
 */
import fs from "node:fs";

/** 本模块认识的字符串字段（顺序即文档顺序，与拼装顺序无关） */
export const CARD_STRING_FIELDS = Object.freeze([
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
]);

const FIELD_SET = new Set(CARD_STRING_FIELDS);

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * 读取并校验一张角色卡。
 *
 * @param {string} filePath 卡文件路径（JSON）
 * @returns {{name:string, description:string, personality:string, scenario:string,
 *   first_mes:string, mes_example:string, system_prompt:string,
 *   post_history_instructions:string, extensions:object}}
 * @throws {Error} 文件读不到、JSON 语法错、根不是对象、已知字段不是字符串
 */
export function loadCard(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("角色卡路径无效：需要一个非空文件路径");
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`读取角色卡失败：${filePath}（${err?.code || err?.message || "未知错误"}）`, { cause: err });
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`角色卡 JSON 解析失败：${filePath}（${err?.message || "语法错误"}）`, { cause: err });
  }

  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`角色卡根节点必须是对象，实际是 ${typeName(obj)}：${filePath}`);
  }

  const card = { extensions: {} };
  for (const key of CARD_STRING_FIELDS) {
    const value = obj[key];
    if (value === undefined) {
      card[key] = "";
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(
        `角色卡字段 ${key} 类型错误：期望 string，实际是 ${typeName(value)}（${filePath}）`,
      );
    }
    card[key] = value;
  }

  // 未知字段（含 V2 的 spec/spec_version/avatar 等）原样收进扩展位，不丢、不报错。
  for (const [key, value] of Object.entries(obj)) {
    if (!FIELD_SET.has(key)) card.extensions[key] = value;
  }

  return card;
}

function substitute(text, charName, userName) {
  return String(text)
    .replaceAll("{{char}}", charName)
    .replaceAll("{{user}}", userName);
}

/**
 * 按固定顺序拼装最终 system prompt：
 *
 *   base
 *   → card.system_prompt
 *   → card.description
 *   → card.personality
 *   → card.scenario
 *   → [Example] ... [/Example]（mes_example）
 *   → card.post_history_instructions
 *
 * 空字段整体跳过，段与段之间只留一个空行，不产生多余空行。
 * 占位符：{{char}} → card.name，{{user}} → userName（默认「用户」）。
 * 卡里没有可拼内容时，原样返回 base（保证 enabled=false 的等价语义）。
 *
 * @param {{base?:string, card?:object, userName?:string}} opts
 * @returns {string}
 */
export function assembleSystemPrompt({ base = "", card = {}, userName = "用户" } = {}) {
  const baseText = base == null ? "" : String(base);
  const charName = typeof card?.name === "string" ? card.name : "";
  const who = userName == null || userName === "" ? "用户" : String(userName);

  const segments = [];
  const push = (value) => {
    if (typeof value !== "string") return;
    const text = substitute(value, charName, who).trim();
    if (text) segments.push(text);
  };

  push(card.system_prompt);
  push(card.description);
  push(card.personality);
  push(card.scenario);

  if (typeof card.mes_example === "string" && card.mes_example.trim()) {
    const example = substitute(card.mes_example, charName, who).trim();
    segments.push(`[Example]\n${example}\n[/Example]`);
  }

  // TODO: post_history_instructions 的理想位置是「最后一条 user 消息之后」的
  // 历史尾部（而不是 system prompt 末尾）。当前注入链路只会在会话开始时装配
  // system prompt，先拼在末尾保证内容不丢；等尾部注入能力就绪后再挪过去。
  push(card.post_history_instructions);

  if (!segments.length) return baseText;

  // 人设段在前、基础提示词在后 —— 与迁移前 system.md「13 行人设 + 干活的样子」的顺序保持一致。
  return [...segments, baseText.trimEnd()].filter(Boolean).join("\n\n");
}
