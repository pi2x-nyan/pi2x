#!/usr/bin/env node
/**
 * 三条路径同载荷对比：直连上游 / 经代理 / 经 OmniRoute（bot 真实路径）。
 * 结果写日志文件，供后台运行（SSH 断开也不丢结果）。
 *
 * 用法：node scripts/_path-bench.mjs [载荷MB] [--tools]
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const targetMB = Number(args[0] ?? 5.7);
const WITH_TOOLS = args.includes("--tools");
const OUT = "<PI2X_ROOT>/private/logs/path-bench.log";

const env = fs.readFileSync("/root/.omniroute/.env", "utf8");
const OR_KEY = /OMNIROUTE_API_KEY=(.+)/.exec(env)?.[1]?.trim();
const pool = JSON.parse(fs.readFileSync("<PI2X_ROOT>/private/.cc-pool.json", "utf8"));
const acct = pool.find((a) => a.name === "42zam") ?? pool[0];

const unit = "这是一段用于填充上下文的文本，模拟真实会话历史与工具输出内容。";
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(line);
  fs.appendFileSync(OUT, line + "\n");
};

// 构造 messages：n 条，使总载荷约 targetMB
function buildMessages(n = 950) {
  const perMsg = Math.max(20, Math.round((targetMB * 1048576) / n / 3 / unit.length));
  const msgs = [];
  for (let i = 0; i < n; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: unit.repeat(perMsg) + ` #${i}` });
  msgs.push({ role: "user", content: "只回复两个字：好了" });
  return msgs;
}
const msgs = buildMessages();
const toolsOA = WITH_TOOLS
  ? Array.from({ length: 28 }, (_, i) => ({ type: "function", function: { name: "tool_" + i, description: "测试工具 " + i, parameters: { type: "object", properties: { a: { type: "string" } } } } }))
  : [];
const toolsAnth = WITH_TOOLS
  ? Array.from({ length: 28 }, (_, i) => ({ type: "function", name: "tool_" + i, description: "测试工具 " + i, input_schema: { type: "object", properties: { a: { type: "string" } } } }))
  : [];

const OA_BODY = JSON.stringify({ model: "deepseek-flash", messages: msgs, tools: toolsOA, max_tokens: 100, stream: true });
const ANTH_BODY = JSON.stringify({
  config: { workingDir: "<PI2X_ROOT>", date: new Date().toISOString().slice(0, 10), environment: "linux-arm64", structure: [], isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] },
  memory: "", taste: "", skills: null, permissionMode: "standard",
  params: { model: "deepseek/deepseek-v4.1-flash", messages: msgs, tools: toolsAnth, system: "", max_tokens: 100, stream: true },
});

async function timed(label, url, headers, body) {
  const mb = (Buffer.byteLength(body) / 1048576).toFixed(2);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(300000) });
    const hdr = Date.now() - t0;
    const rd = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", deltas = 0, content = "", err = "", first = null, bytes = 0;
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      if (!first) first = Date.now() - t0;
      bytes += value.length;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        if (!p.startsWith("data: ")) continue;
        const d = p.slice(6).trim();
        if (d === "[DONE]") continue;
        try {
          const j = JSON.parse(d);
          if (j.error) err = JSON.stringify(j.error).slice(0, 90);
          const dl = j.choices?.[0]?.delta ?? {};
          if (dl.content) { deltas++; content += dl.content; }
        } catch { /* 分片 */ }
      }
    }
    const total = Date.now() - t0;
    log(`${label} · ${mb}MB → HTTP ${r.status} | 头 ${(hdr / 1000).toFixed(1)}s · 首数据 ${((first ?? 0) / 1000).toFixed(1)}s · 全量 ${(total / 1000).toFixed(1)}s | delta ${deltas} · ${content.length} 字 · 收 ${(bytes / 1024).toFixed(0)}KB${err ? ` | 流内错误: ${err}` : ""}`);
  } catch (e) {
    log(`${label} · ${mb}MB → 失败 ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e?.cause?.code ?? e?.message}`);
  }
}

fs.appendFileSync(OUT, `\n===== ${new Date().toISOString()} 路径对比（${WITH_TOOLS ? "含 28 工具" : "无工具"}）=====\n`);
await timed("① 直连上游 api.commandcode.ai", "https://api.commandcode.ai/alpha/generate", {
  authorization: `Bearer ${acct.key}`, "x-command-code-version": "0.26.20", "x-cli-environment": "production", "x-co-flag": "false",
}, ANTH_BODY);
await new Promise((r) => setTimeout(r, 3000));
await timed("② 经本地代理 :20228", "http://127.0.0.1:20228/v1/chat/completions", {}, OA_BODY);
await new Promise((r) => setTimeout(r, 3000));
await timed("③ 经 OmniRoute :20128（bot 真实路径）", "http://127.0.0.1:20128/v1/chat/completions", { authorization: `Bearer ${OR_KEY}` }, OA_BODY);
log("对比结束");
