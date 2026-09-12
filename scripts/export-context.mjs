#!/usr/bin/env node
/**
 * PI2X 上下文导出工具（调试用）
 * 用法: node export-context.mjs [sessionFilePath] [outFile]
 * 输出: system prompt(重建) + 注入上下文 + 工具清单 + 完整消息历史
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = process.argv[2];
if (!file) {
  console.error("用法: node export-context.mjs <会话文件路径> [输出文件]");
  console.error("会话文件在 sessions/ 下，名为 <chatType>_<id>.jsonl");
  process.exit(2);
}
const out = process.argv[3] || path.join(ROOT, "tmp", "context-export.txt");
fs.mkdirSync(path.dirname(out), { recursive: true });

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

// ---- 1. 重建 system prompt（读 prompt/ 文件）----
function readPrompt(sub, name) {
  try { return fs.readFileSync(path.join(ROOT, "prompt", sub, name), "utf8"); } catch { return ""; }
}
let sys = readPrompt("agent", "system.md");
const base2x = readPrompt("context", "2x.md");
if (base2x) sys += "\n\n" + base2x;

// ---- 2. 工具清单（从 prompt/tools/*.md 读 label）----
const toolDir = path.join(ROOT, "prompt", "tools");
const tools = [];
if (fs.existsSync(toolDir)) {
  for (const f of fs.readdirSync(toolDir).filter((x) => x.endsWith(".md")).sort()) {
    const c = fs.readFileSync(path.join(toolDir, f), "utf8");
    const labelM = c.match(/^label:\s*(.+)$/m);
    const desc = c.split("---").pop?.()?.trim?.() || "";
    const label = labelM ? labelM[1] : f.replace(".md", "");
    const firstLine = desc.split("\n")[0] || "";
    tools.push("- " + f.replace(".md", "") + "：" + label + (firstLine ? "\n    " + firstLine : ""));
  }
}

// ---- 3. 完整历史消息 ----
const entries = [];
for (const line of lines) {
  try {
    const rec = JSON.parse(line);
    if (rec.type === "message") {
      const msg = rec.message;
      const role = msg?.role ?? "?";
      const content = msg?.content ?? [];
      const textParts = content.filter((c) => c?.type === "text").map((c) => c.text).join("");
      const hasImg = content.some((c) => c?.type === "image");
      const hasTool = content.some((c) => c?.type === "toolCall");
      const hasToolRes = content.some((c) => c?.type === "toolResult");
      entries.push(`[${role}${hasImg ? " +图片" : ""}${hasTool ? " +工具调用" : ""}${hasToolRes ? " +工具结果" : ""}] ${textParts.slice(0, 2000)}`);
    } else if (rec.type === "session" || rec.type === "model_change" || rec.type === "thinking_level_change") {
      entries.push(`[${rec.type}] ${JSON.stringify({ id: rec.id, modelId: rec.modelId, thinkingLevel: rec.thinkingLevel, cwd: rec.cwd }).slice(0, 300)}`);
    }
  } catch {}
}

// ---- 组装输出 ----
const outText = [
  "=".repeat(60),
  "PI2X 上下文导出",
  `会话文件: ${file}`,
  `导出时间: ${new Date().toISOString()}`,
  `总消息行: ${entries.length}`,
  "=".repeat(60),
  "",
  "## SYSTEM PROMPT（重建：agent/system.md + context/2x.md）",
  "=".repeat(60),
  sys,
  "",
  "=".repeat(60),
  "## 工具清单（prompt/tools/*.md label）",
  "=".repeat(60),
  tools.join("\n"),
  "",
  "=".repeat(60),
  "## 完整历史（含注入上下文/图片标记/工具调用）",
  "=".repeat(60),
  entries.join("\n"),
].join("\n");

fs.writeFileSync(out, outText, "utf8");
console.log(`已导出 ${entries.length} 条 → ${out}`);