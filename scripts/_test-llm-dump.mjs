#!/usr/bin/env node
/** 触发一次真实 LLM 调用，验证 before_agent_start 注入（2X diff + 记忆 memInjection）进入发给 LLM 的 system prompt */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAgent } from "../lib/piagent.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PI2X_DUMP_LLM = "1";

const bridge = { sendPrivateMsg: async () => ({ retcode: 0 }), api: async () => ({}) };
const a = createPiAgent({ bridge });
await a.init({ whitelistFile: "./whitelist.json" });

// 模拟 _runTurn 设置的 ctx（userId + memInjection）
a.ctx = {
  chatType: "private",
  targetId: "1000000001",
  selfId: "x",
  userName: "测试用户",
  userId: "1000000001",
  chatKey: "private:1000000001",
  memInjection: "【全局】\n- PI2X 运行于 Linux\n【记忆】\n- [fact] 用户是东南大学学生，关注 SUSCTF",
};

const entry = await a._getSession("private:1000000001", "1000000001");
console.log("发送测试消息（模拟真实 _runTurn 注入）...");
await entry.asm.submit("你好，简短回复我即可（测试 2X diff + 记忆注入）");
await new Promise((r) => setTimeout(r, 2500));

const dir = path.join(ROOT, "tmp", "llm-requests");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
console.log("dump 文件数:", files.length);
if (files.length) {
  const f = path.join(dir, files[files.length - 1]);
  const raw = fs.readFileSync(f, "utf8");
  console.log("最新 dump:", path.basename(f), `(${raw.length} 字)`);
  let text = raw;
  try { const d = JSON.parse(raw); text = (d.messages ?? []).map((m) => `=====${m.role}=====\n${m.content ?? ""}`).join("\n\n"); } catch {}
  console.log("含【2X 口吻补充】:", text.includes("2X 口吻补充") ? "✓" : "✗");
  console.log("含 memInjection 记忆【全局】/【记忆】:", (text.includes("【全局】") && text.includes("【记忆】")) ? "✓" : "✗");
  console.log("含 PI2X 运行于 Linux:", text.includes("PI2X 运行于 Linux") ? "✓" : "✗");
}
a.disposeAll?.().catch(() => {});
process.exit(0);
