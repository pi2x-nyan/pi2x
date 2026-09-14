/**
 * 合并压缩：一次 LLM 调用同时产出「上下文摘要」与「长期事实」。
 *
 * 【为什么合并】压缩与收割本来就是同一件事的两面：
 *   · 压缩要把一段历史压成摘要（保留大体脉络，细节丢失）；
 *   · 收割要从同一段历史里抽出值得长期记住的事实。
 * 两者面对的是**完全相同**的一段消息。分开跑 = 同一段内容读两遍、两次 LLM 调用，
 * 而且各自理解一遍，摘要里可能提到的事实在收割那边被漏掉，反之亦然。
 *
 * 【怎么合并】pi 提供 `session_before_compact` 钩子，允许扩展接管整次压缩：
 *   · 我们从钩子拿到 preparation.messagesToSummarize（**恰好等于即将被丢弃的那段**，
 *     比自己去拼上下文更准，且天然与压缩范围一致）；
 *   · 用自定义提示词调一次模型，要求先输出标准结构的摘要，再输出 `===FACTS===`
 *     分隔线 + 一个 JSON（事实数组，可选 used_ids）；
 *   · 解析出摘要与事实；**摘要原样交给 pi**（走 result.compaction 接管），
 *     事实写入记忆库。
 *
 * 【必须守住的失败回退】
 * pi 有一条硬规则：摘要若因 token 上限被截断（stopReason === "length"），
 * 它判定「摘要不完整」并**直接放弃整次压缩** —— 历史一条不少，从外部看就是
 * 「压缩没反应」，极难排查（见 lib/agent/settings.mjs 的注释）。
 * 合并后输出变多，撞上限的概率上升。所以：
 *   · 解析失败 / 输出被截断 → **不接管**（返回空结果），让 pi 走它自己的标准摘要；
 *   · 事实部分单独解析失败，只丢事实，摘要照旧交付（不能因为事实而赔上压缩）。
 */
import { config } from "../config.mjs";

/** 分隔线：提示词要求模型在摘要与 JSON 之间输出它 */
export const FACTS_DELIMITER = "===FACTS===";

/**
 * 把模型的一次输出切成 { summary, facts, usedIds }。
 *
 * 宽容处理（模型不一定严格照办）：
 *  · 没有分隔线 → 全是摘要，facts 为空（不算失败）；
 *  · 分隔线后有 ```json 围栏 → 剥掉围栏再解析；
 *  · JSON 里 facts 不是数组 / 元素缺 content → 过滤掉那些元素，保留可用的；
 *  · JSON 完全解析不了 → facts 为空，但**摘要仍然可用**。
 *
 * @param {string} text 模型原始输出
 * @returns {{summary:string, facts:Array, usedIds:string[], parseError:string|null}}
 */
export function splitCompactOutput(text) {
  const raw = String(text ?? "");
  const idx = raw.indexOf(FACTS_DELIMITER);
  if (idx < 0) {
    return { summary: raw.trim(), facts: [], usedIds: [], parseError: null };
  }
  const summary = raw.slice(0, idx).trim();
  let jsonPart = raw.slice(idx + FACTS_DELIMITER.length).trim();
  // 剥 markdown 代码围栏（模型常自作主张加上）
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(jsonPart);
  if (fence) jsonPart = fence[1].trim();
  // 兜底：截取第一个 { 到最后一个 }
  if (!jsonPart.startsWith("{")) {
    const a = jsonPart.indexOf("{");
    const b = jsonPart.lastIndexOf("}");
    if (a >= 0 && b > a) jsonPart = jsonPart.slice(a, b + 1);
  }
  let obj;
  try {
    obj = JSON.parse(jsonPart);
  } catch (e) {
    return { summary, facts: [], usedIds: [], parseError: `facts JSON 解析失败: ${e?.message}` };
  }
  const facts = (Array.isArray(obj?.facts) ? obj.facts : [])
    .filter((f) => f && typeof f === "object" && String(f.content ?? "").trim())
    .slice(0, 10);
  const usedIds = (Array.isArray(obj?.used_ids) ? obj.used_ids : []).map((x) => String(x));
  return { summary, facts, usedIds, parseError: null };
}

/**
 * 判断这次模型输出能不能安全地当作压缩摘要交付。
 *
 * 只有两个硬条件：
 *   · 摘要非空（空的摘要等于把历史全丢了）；
 *   · 没有被 token 上限截断 —— 这一条是 pi 的硬规则，截断的摘要它拒收。
 *
 * @param {{summary:string, stopReason?:string}} o
 * @returns {string|null} 失败原因，null 表示可用
 */
export function summaryRejection({ summary, stopReason }) {
  if (!String(summary ?? "").trim()) return "摘要为空";
  if (stopReason === "length") return "摘要被 token 上限截断（pi 会拒收，改回标准摘要）";
  return null;
}

/**
 * 是否启用合并压缩。
 * 开关落在 config.memory.mergeHarvestIntoCompact（默认 true）。
 */
export function mergeEnabled(cfg = config) {
  const v = cfg?.memory?.mergeHarvestIntoCompact;
  return v !== false; // 只有显式 false 才关闭
}

/**
 * 从 fileOps 算出「只读过」与「被改过」两组文件。
 *
 * 为什么要自己实现：pi 的 computeFileLists/formatFileOperations **没有导出**，
 * 而接管压缩后摘要末尾的 <read-files>/<modified-files> 段落得由我们自己补 ——
 * 少了它，压缩后模型就不知道之前动过哪些文件（pi 默认是带的）。
 * 逻辑与 pi 源码一致（dist/core/compaction/utils.js），很短，抄进来比依赖私有路径稳。
 */
export function computeFileLists(fileOps) {
  const read = fileOps?.read ?? new Set();
  const written = fileOps?.written ?? new Set();
  const edited = fileOps?.edited ?? new Set();
  const modified = new Set([...edited, ...written]);
  const readOnly = [...read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

/** 拼出 pi 风格的尾部文件清单段落（空则返回空串） */
export function formatFileOperations(readFiles, modifiedFiles) {
  const sections = [];
  if (readFiles?.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles?.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (!sections.length) return "";
  return `\n\n${sections.join("\n\n")}`;
}
