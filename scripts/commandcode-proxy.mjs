/**
 * Command Code Go 套餐适配代理（多账号池 + 真流式 + 心跳保活 + 完整历史转换）
 *
 * OpenAI 兼容 → Command Code 私有 /alpha/generate。
 *
 * 关键设计：
 *  1) 立即建立响应 + 每 5s 心跳（SSE `: ping` / JSON 前导空白）→ 下游首字节超时永不触发。
 *  2) 上游事件边收边转发（真流式）；工具参数按 tool-input-delta 增量转发。
 *  3) stream:false 返回规范 chat.completion JSON。
 *  4) 思考内容 → delta.reasoning_content。
 *  5) **历史消息完整转换**：OpenAI 线格式的 assistant 消息里
 *     content(string) / reasoning_content / tool_calls[] 必须都保留，
 *     否则上游会看到孤立的 tool 结果 → 模型"话说到一半停住"。
 *  6) usage 按 OpenAI 规范输出（prompt_tokens 为总数 + prompt_tokens_details.cached_tokens）。
 *  7) 多账号池轮询 + 鉴权/额度/5xx 自动切换。
 */
import http from "node:http";
import fs from "node:fs";
import dns from "node:dns";
import { URL } from "node:url";

// 本机 IPv6 路由不可用（api.commandcode.ai 仅解析出 Cloudflare AAAA 且 connect 黑洞）→ 强制优先 IPv4。
// 否则 Node 偶发先试 IPv6 → 黑洞式 ETIMEDOUT（表现为三个账号全部超时）。
dns.setDefaultResultOrder("ipv4first");

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根：由本文件位置推导，避免写死部署路径 */
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const BASE = "https://api.commandcode.ai";
const CC_VERSION = "0.26.20";
const PORT = Number(process.env.COMMANDCODE_PROXY_PORT ?? 20228);
const MODELS_URL = `${BASE}/provider/v1/models`;
const CATALOG_URL = "https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md";
const POOL_FILE = process.env.COMMANDCODE_POOL_FILE ?? path.join(ROOT_DIR, ".cc-pool.json");
const HEARTBEAT_MS = Number(process.env.COMMANDCODE_HEARTBEAT_MS ?? 5000);
/** 单次尝试的「等响应头」超时：连接/排队问题快速暴露，而不是挂到客户端超时 */
const HEADER_TIMEOUT_MS = Number(process.env.COMMANDCODE_HEADER_TIMEOUT_MS ?? 60000);
/** 流式传输中「无数据」空闲超时（正常流有事件/心跳，长时间静默视为卡死） */
const IDLE_TIMEOUT_MS = Number(process.env.COMMANDCODE_IDLE_TIMEOUT_MS ?? 300000);
/** 账号池轮询轮数（网络抖动时多试一轮） */
const ATTEMPT_ROUNDS = Number(process.env.COMMANDCODE_ATTEMPT_ROUNDS ?? 2);
/** 账号 429/额度超限后的冷却时长（默认 10 分钟；命中 Retry-After 时以它为准，上限 1 小时）。
 *  作用：把「已超额」的账号暂时踢出轮询，避免每次都白跑一次再切（省 ~2s/请求 的额外延迟）。 */
const COOLDOWN_MS = Number(process.env.COMMANDCODE_429_COOLDOWN_MS ?? 600000);
const COOLDOWN_MAX_MS = Number(process.env.COMMANDCODE_429_COOLDOWN_MAX_MS ?? 3600000);
/** 账号名 -> 冷却到期时间戳 */
const coolingUntil = new Map();
const RETRY_STATUS = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);

/** 对外模型名 -> 上游真实模型名 */
const MODEL_ALIASES = {
  "deepseek-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek-v4-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp": "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek/deepseek-v4-flash-vision-exp": "deepseek/deepseek-v4-flash-vision-exp",
};
const resolveUpstream = (m) => MODEL_ALIASES[m] ?? m;
const PUBLIC_MODELS = [{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash", object: "model", owned_by: "commandcode-go", context_length: 1000000, max_output_tokens: 384000 }];

// ── 账号池 ──
let poolFile = { mtime: 0, accounts: [] };
function loadPool() {
  try {
    const st = fs.statSync(POOL_FILE);
    if (st.mtimeMs !== poolFile.mtime) {
      const arr = JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
      poolFile = { mtime: st.mtimeMs, accounts: (Array.isArray(arr) ? arr : []).filter((a) => a?.key) };
      console.log(`[cc-go] 账号池已加载 ${poolFile.accounts.length} 个: ${poolFile.accounts.map((a) => a.name).join(", ")}`);
    }
  } catch {}
  const envKeys = String(process.env.COMMANDCODE_API_KEYS ?? process.env.COMMANDCODE_API_KEY ?? "").split(/[,\s]+/).filter(Boolean);
  const merged = [...poolFile.accounts.map((a) => ({ name: a.name ?? "?", key: a.key })), ...envKeys.map((k) => ({ name: "env", key: k }))];
  const seen = new Set();
  return merged.filter((a) => (seen.has(a.key) ? false : (seen.add(a.key), true)));
}
let rr = 0;

// ── 模型目录（COMMANDCODE_LIST_ALL=1 时列全量）──
async function fetchCatalog() {
  const r = await fetch(CATALOG_URL, { headers: { accept: "text/markdown" }, signal: AbortSignal.timeout(30000) });
  const md = await r.text();
  const map = new Map();
  for (const line of md.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const id = cells[1]?.startsWith("`") ? cells[1].replace(/`/g, "") : undefined;
    const minPlan = cells[6]?.trim();
    if (id && minPlan) map.set(id, { minPlan });
  }
  return map;
}
async function listAllModels() {
  const [cat, listing] = await Promise.all([
    fetchCatalog().catch(() => new Map()),
    fetch(MODELS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) }).then((r) => r.json()).catch(() => ({ data: [] })),
  ]);
  const out = [];
  for (const raw of listing?.data ?? []) {
    const id = raw?.id;
    if (!id) continue;
    const entry = cat.get(id);
    if (cat.size > 0 && (!entry || entry.minPlan.split(/\s+/)[0] !== "Go")) continue;
    out.push({ id, name: raw?.name, object: "model", owned_by: "commandcode-go", context_length: Number(raw?.context_length ?? 1000000) || 1000000 });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ── OpenAI 线格式消息 → Cc 消息（完整保留 text / reasoning / tool_calls / tool 结果）──
const asText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text ?? "").join("") : "");

function buildEnvelope(body, upstreamModel) {
  const msgs = body.messages ?? [];
  // tool_call_id -> 工具名（供 tool 结果补齐 toolName）
  const nameById = new Map();
  for (const m of msgs) {
    if (m?.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        const id = String(tc?.id ?? "");
        if (id) nameById.set(id, String(tc?.function?.name ?? tc?.name ?? ""));
      }
    }
  }

  let system = "";
  const messages = [];
  for (const m of msgs) {
    const role = m?.role;
    if (role === "system" || role === "developer") { system += (system ? "\n\n" : "") + asText(m.content); continue; }

    if (role === "assistant") {
      const parts = [];
      // ① 思考（DeepSeek 要求带工具的 assistant 消息回传 reasoning）
      const reasoning = m.reasoning_content ?? m.reasoning ?? m.reasoning_text;
      if (typeof reasoning === "string" && reasoning.length > 0) parts.push({ type: "reasoning", text: reasoning });
      // ② 文本
      const text = asText(m.content);
      if (text.length > 0) parts.push({ type: "text", text });
      // ③ 工具调用（OpenAI 线格式：顶层 tool_calls）
      for (const tc of m.tool_calls ?? []) {
        let input = {};
        const rawArgs = tc?.function?.arguments ?? tc?.arguments;
        try { input = typeof rawArgs === "string" ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs ?? {}); } catch { input = { _raw: String(rawArgs ?? "") }; }
        parts.push({ type: "tool-call", toolCallId: String(tc?.id ?? tc?.toolCallId ?? ""), toolName: String(tc?.function?.name ?? tc?.name ?? tc?.toolName ?? ""), input });
      }
      // ④ 兼容数组式 content 里的 tool_use / reasoning 块
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c?.type === "tool_use") parts.push({ type: "tool-call", toolCallId: String(c.id ?? ""), toolName: String(c.name ?? ""), input: c.input ?? {} });
        }
      }
      if (parts.length === 0) continue; // 跳过空 assistant 消息（避免上游报错）
      messages.push({ role: "assistant", content: parts });
      continue;
    }

    if (role === "tool" || role === "function") {
      const cid = String(m.tool_call_id ?? m.toolCallId ?? "");
      const out = { type: m.is_error ? "error-text" : "text", value: asText(m.content) || "(no output)" };
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: cid, toolName: nameById.get(cid) || String(m.name ?? "unknown"), output: out }] });
      continue;
    }

    // user（含图片）
    const parts = [];
    if (typeof m.content === "string") parts.push({ type: "text", text: m.content });
    else for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === "text") parts.push({ type: "text", text: String(c.text ?? "") });
      else if (c?.type === "image_url" || c?.type === "image") {
        const u = c.image_url?.url ?? c.data ?? "";
        const mt = c.mimeType ?? (typeof u === "string" && u.startsWith("data:") ? u.slice(5, u.indexOf(";")) : "image/png");
        parts.push({ type: "image", image: typeof u === "string" && u.startsWith("data:") ? u : `data:${mt};base64,${u}`, mimeType: mt });
      }
    }
    if (parts.length === 0) continue;
    messages.push(parts.length === 1 && parts[0].type === "text" ? { role: "user", content: parts[0].text } : { role: "user", content: parts });
  }

  const tools = (body.tools ?? body.functions ?? []).map((t) => ({
    type: "function",
    name: t.name ?? t.function?.name ?? "",
    ...(t.description ?? t.function?.description ? { description: t.description ?? t.function?.description } : {}),
    input_schema: t.parameters ?? t.function?.parameters ?? {},
  }));
  const params = { model: upstreamModel, messages, tools, system, max_tokens: body.max_tokens ?? body.maxTokens ?? 64000, stream: true };
  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;
  if (body.reasoning_effort && ["low", "medium", "high", "xhigh", "max"].includes(body.reasoning_effort)) params.reasoning_effort = body.reasoning_effort;
  return {
    config: { workingDir: ROOT_DIR, date: new Date().toISOString().split("T")[0], environment: "linux-arm64", structure: [], isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] },
    memory: "", taste: "", skills: null, permissionMode: "standard",
    params,
  };
}

/** 上游 usage → OpenAI 规范（pi 期望 prompt_tokens 为总数 + cached_tokens 明细） */
function usageOf(u) {
  if (!u) return null;
  const inDet = u.inputTokenDetails ?? {};
  const outDet = u.outputTokenDetails ?? {};
  const totalIn = Number(u.inputTokens ?? 0);
  const cacheRead = Number(inDet.cacheReadTokens ?? 0);
  const out = Number(u.outputTokens ?? 0);
  return {
    prompt_tokens: totalIn,
    completion_tokens: out,
    total_tokens: Number(u.totalTokens ?? totalIn + out),
    prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: Number(outDet.reasoningTokens ?? 0) },
  };
}
function mapFinish(ev) {
  const r = ev?.finishReason ?? ev?.rawFinishReason ?? "stop";
  if (r === "tool_calls" || r === "tool-calls" || r === "tool_call") return "tool_calls";
  if (r === "length" || r === "max_tokens") return "length";
  if (r === "content_filter") return "content_filter";
  return "stop";
}
function parseLineObj(line) {
  const t = line.trim();
  if (!t || t.startsWith(":")) return null;
  try { const o = JSON.parse(t); return o && typeof o.type === "string" ? o : null; } catch { return null; }
}

// ── HTTP ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let bodyRaw = "";
  req.on("data", (c) => (bodyRaw += c));
  req.on("end", async () => {
    try {
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const models = process.env.COMMANDCODE_LIST_ALL === "1" ? await listAllModels() : PUBLIC_MODELS;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/pool") {
        const pool = loadPool();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ count: pool.length, accounts: pool.map((a, i) => ({ index: i, name: a.name, key: a.key.slice(0, 12) + "…" + a.key.slice(-4) })) }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = JSON.parse(bodyRaw || "{}");
        const wantStream = body.stream !== false;
        const upstreamModel = resolveUpstream(body.model);
        const envelope = buildEnvelope(body, upstreamModel);
        const cmplId = "chatcmpl-" + Math.random().toString(36).slice(2, 14);
        const tReq = Date.now();
        const now = () => Math.floor(Date.now() / 1000);

        // ① 立即建响应 + 立即发首个 role 帧（保证下游一开始就看到「非 ping」的 SSE 事件）+ 心跳
        if (wantStream) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        else res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
        const hb = setInterval(() => { try { res.write(wantStream ? ": ping\n\n" : "\n"); } catch {} }, HEARTBEAT_MS);
        const bodyBytes = Buffer.byteLength(bodyRaw || "", "utf8");
        const ac = new AbortController();
        let ended = false;
        const endRes = () => { if (ended) return; ended = true; clearInterval(hb); try { res.end(); } catch {} };
        res.on("close", () => { clearInterval(hb); try { ac.abort(); } catch {} });

        let roleSent = false, usage = null, finishReason = "stop";
        let content = "", reasoning = "";
        const toolByKey = new Map();          // toolCallId -> { index, id, name, args }
        let toolIndex = 0;
        const writeChunk = (delta, extra = {}) => {
          if (!wantStream) return;
          try { res.write(`data: ${JSON.stringify({ id: cmplId, object: "chat.completion.chunk", created: now(), model: body.model, choices: [{ index: 0, delta, ...extra }] })}\n\n`); } catch {}
        };
        const sendRole = () => { if (!roleSent) { roleSent = true; writeChunk({ role: "assistant", content: "" }); } };
        sendRole(); // 立即发出：即使上游全部失败，下游也能看到合法 SSE 事件而非“只有 ping”

        // ② 账号池轮询 + 失败切换（多轮重试；等头超时快速失败）
        const pool = loadPool();
        if (!pool.length) {
          const msg = "COMMANDCODE_API_KEYS / 账号池为空（需要 user_xxx key）";
          console.log("[cc-go] " + msg);
          if (wantStream) { res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`); res.write("data: [DONE]\n\n"); } else res.write(JSON.stringify({ error: { message: msg } }));
          return endRes();
        }
        const start = rr++ % pool.length;
        // 候选顺序：从轮询起点开始，但把「冷却中」的账号排到最后（全在冷却时仍按原顺序试）
        const now0 = Date.now();
        const ordered = [];
        for (let i = 0; i < pool.length; i++) ordered.push(pool[(start + i) % pool.length]);
        const candidates = [
          ...ordered.filter((a) => (coolingUntil.get(a.name) ?? 0) <= now0),
          ...ordered.filter((a) => (coolingUntil.get(a.name) ?? 0) > now0),
        ];
        const nCooling = candidates.length - candidates.filter((a) => (coolingUntil.get(a.name) ?? 0) <= now0).length;
        if (nCooling > 0) {
          const names = ordered.filter((a) => (coolingUntil.get(a.name) ?? 0) > now0)
            .map((a) => a.name + "(" + Math.ceil(((coolingUntil.get(a.name) - now0) / 60000)) + "min)").join(", ");
          console.log(`[cc-go] 冷却中跳过 ${nCooling} 个账号: ${names}`);
        }
        let up = null, acct = null, lastErr = "no attempt";
        outer: for (let round = 0; round < Math.max(1, ATTEMPT_ROUNDS); round++) {
          for (let i = 0; i < candidates.length; i++) {
            if (ac.signal.aborted) return endRes();
            const cand = candidates[i];
            const tAttempt = Date.now();
            const ac2 = new AbortController();
            const onClientAbort = () => { try { ac2.abort(); } catch {} };
            ac.signal.addEventListener("abort", onClientAbort, { once: true });
            const headerTimer = setTimeout(() => { try { ac2.abort(new Error(`等响应头超时(${HEADER_TIMEOUT_MS}ms)`)); } catch {} }, HEADER_TIMEOUT_MS);
            try {
              const r = await fetch(`${BASE}/alpha/generate`, {
                method: "POST",
                headers: { authorization: `Bearer ${cand.key}`, "content-type": "application/json", "x-command-code-version": CC_VERSION, "x-cli-environment": "production", "x-co-flag": "false" },
                body: JSON.stringify(envelope),
                signal: ac2.signal,
              });
              clearTimeout(headerTimer);
              if (r.ok) { up = r; acct = cand; coolingUntil.delete(cand.name); break outer; }
              const t = await r.text().catch(() => "");
              lastErr = `upstream ${r.status}: ${t.slice(0, 200)}`;
              if (r.status === 429 || r.status === 402) {
                const ra = Number(r.headers.get("retry-after"));
                const cd = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, COOLDOWN_MAX_MS) : COOLDOWN_MS;
                coolingUntil.set(cand.name, Date.now() + cd);
                console.log(`[cc-go] 账号 ${cand.name} 额度/限流(${r.status})，冷却 ${(cd / 60000).toFixed(1)} 分钟后重试`);
              }
              console.log(`[cc-go] 账号 ${cand.name} 失败(${r.status}) ${((Date.now()-tAttempt)/1000).toFixed(1)}s，切换下一个`);
              if (!RETRY_STATUS.has(r.status)) { clearTimeout(headerTimer); break outer; }
            } catch (e) {
              const code = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(e);
              lastErr = String(code).slice(0, 200);
              console.log(`[cc-go] 账号 ${cand.name} 失败(${lastErr}) ${((Date.now()-tAttempt)/1000).toFixed(1)}s`);
              if (ac.signal.aborted) return endRes();
            } finally {
              clearTimeout(headerTimer);
              ac.signal.removeEventListener("abort", onClientAbort);
            }
          }
          if (round < ATTEMPT_ROUNDS - 1) await new Promise((r) => setTimeout(r, 1200));
        }
        if (ac.signal.aborted) return endRes();
        if (!up) {
          console.log(`[cc-go] 全部账号失败(${pool.length}个×${ATTEMPT_ROUNDS}轮): ${lastErr}`);
          if (wantStream) { res.write(`data: ${JSON.stringify({ error: { message: `all accounts failed: ${lastErr}` } })}\n\n`); res.write("data: [DONE]\n\n"); } else res.write(JSON.stringify({ error: { message: `all accounts failed: ${lastErr}` } }));
          return endRes();
        }
        const nTools = envelope.params.tools.length;
        console.log(`[cc-go] acct=${acct.name} stream=${wantStream ? 1 : 0} model=${upstreamModel} msgs=${envelope.params.messages.length} tools=${nTools} req=${(bodyBytes/1024).toFixed(0)}KB 等头=${((Date.now()-tReq)/1000).toFixed(1)}s`);

        // ③ 事件处理
        const handleEvent = (ev) => {
          const t = ev.type ?? "";
          if (t.includes("reasoning") || t.includes("thinking")) {
            if (t.endsWith("-start") || t.endsWith("-end") || t.endsWith("start") || t.endsWith("end")) return true;
            const txt = String(ev.text ?? ev.delta ?? ev.content ?? "");
            if (!txt) return true;
            sendRole();
            reasoning += txt;
            writeChunk({ reasoning_content: txt });
            return true;
          }
          if (t === "text-start") { sendRole(); return true; }
          if (t === "text-delta" || t === "text") {
            const txt = String(ev.text ?? ev.delta ?? ev.content ?? "");
            if (!txt) return true;
            sendRole();
            content += txt;
            writeChunk({ content: txt });
            return true;
          }
          if (t === "tool-input-start") {
            sendRole();
            const id = String(ev.id ?? ev.toolCallId ?? `call_${toolIndex}`);
            const rec = { index: toolIndex++, id, name: String(ev.toolName ?? ev.name ?? ""), args: "" };
            toolByKey.set(id, rec);
            writeChunk({ tool_calls: [{ index: rec.index, id: rec.id, type: "function", function: { name: rec.name, arguments: "" } }] });
            return true;
          }
          if (t === "tool-input-delta") {
            const id = String(ev.id ?? ev.toolCallId ?? "");
            const rec = toolByKey.get(id);
            const d = String(ev.delta ?? ev.text ?? ev.inputDelta ?? "");
            if (!d) return true;
            if (rec) { rec.args += d; writeChunk({ tool_calls: [{ index: rec.index, function: { arguments: d } }] }); }
            return true;
          }
          if (t === "tool-input-end") return true;
          if (t === "tool-call" || t === "tool-input-available") {
            sendRole();
            const id = String(ev.toolCallId ?? ev.id ?? `call_${toolIndex}`);
            let rec = toolByKey.get(id);
            const input = ev.input ?? ev.args ?? ev.toolInput ?? {};
            const argsStr = typeof input === "string" ? input : JSON.stringify(input);
            if (!rec) {
              rec = { index: toolIndex++, id, name: String(ev.toolName ?? ev.name ?? ""), args: argsStr };
              toolByKey.set(id, rec);
              writeChunk({ tool_calls: [{ index: rec.index, id: rec.id, type: "function", function: { name: rec.name, arguments: rec.args } }] });
            } else {
              rec.name = String(ev.toolName ?? rec.name ?? "");
              if (!rec.args) { rec.args = argsStr; writeChunk({ tool_calls: [{ index: rec.index, function: { arguments: rec.args } }] }); }
            }
            return true;
          }
          if (t === "finish-step") { usage = usageOf(ev.usage ?? ev.totalUsage) ?? usage; return true; }
          if (t === "finish") { usage = usageOf(ev.usage ?? ev.totalUsage) ?? usage; finishReason = mapFinish(ev); return true; }
          if (t === "error") {
            const msg = JSON.stringify(ev.error ?? ev).slice(0, 500);
            if (wantStream) { res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`); res.write("data: [DONE]\n\n"); } else res.write(JSON.stringify({ error: { message: msg } }));
            ended = true; clearInterval(hb);
            return false;
          }
          return true;
        };

        const ct = up.headers.get("content-type") || "";
        if (!up.body || ct.includes("application/json")) {
          const raw = await up.text();
          for (const line of raw.split("\n")) { const ev = parseLineObj(line); if (ev && !handleEvent(ev)) break; }
        } else {
          const reader = up.body.getReader();
          const dec = new TextDecoder();
          let buf = "", stop = false;
          // 空闲看门狗：长时间无数据（既无上游事件）则中止，避免永久挂住
          let idleTimer = null;
          const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              console.log(`[cc-go] 上游空闲超时(${IDLE_TIMEOUT_MS}ms)，中止本次流`);
              try { ac.abort(); } catch {}
            }, IDLE_TIMEOUT_MS);
          };
          resetIdle();
          try {
            while (!stop) {
              const { done, value } = await reader.read();
              if (done) break;
              resetIdle();
              buf += dec.decode(value, { stream: true });
              let nl;
              while ((nl = buf.indexOf("\n")) !== -1) {
                const ev = parseLineObj(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                if (ev && !handleEvent(ev)) { stop = true; break; }
              }
            }
          } catch (e) {
            if (!ac.signal.aborted) console.log("[cc-go] 读取上游流出错:", String(e?.message ?? e).slice(0, 160));
          } finally {
            if (idleTimer) clearTimeout(idleTimer);
          }
        }
        if (ended) return endRes();

        // ④ 收尾
        const toolList = [...toolByKey.values()].sort((a, b) => a.index - b.index);
        if (toolList.length > 0 && finishReason === "stop") finishReason = "tool_calls";
        if (wantStream) {
          const last = { id: cmplId, object: "chat.completion.chunk", created: now(), model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
          if (usage) last.usage = usage;
          res.write(`data: ${JSON.stringify(last)}\n\n`);
          res.write("data: [DONE]\n\n");
        } else {
          const message = { role: "assistant", content: content || null };
          if (reasoning) message.reasoning_content = reasoning;
          if (toolList.length) message.tool_calls = toolList.map((r) => ({ id: r.id, type: "function", function: { name: r.name, arguments: r.args || "{}" } }));
          res.write(JSON.stringify({ id: cmplId, object: "chat.completion", created: now(), model: body.model, choices: [{ index: 0, message, finish_reason: finishReason }], usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
        }
        return endRes();
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    } catch (e) {
      const msg = String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e);
      console.log("[cc-go] 处理请求异常:", msg.slice(0, 300), e?.stack ? "|" + String(e.stack).split("\n")[1]?.trim().slice(0, 120) : "");
      try {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: msg.slice(0, 500) } }));
        } else {
          res.write(`data: ${JSON.stringify({ error: { message: msg.slice(0, 300) } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } catch {}
    }
  });
});
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 120000;

// ── 优雅退出：收到 SIGTERM 时停止接受新连接，等在途请求（流式）收尾再退，
//    避免重启时把下游（OmniRoute）的进行中请求打断 → 502 Bad Gateway。
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = typeof server.getConnections === "function" ? "" : "";
  console.log(`[cc-go] 收到 ${sig}：停止接受新连接，等待在途请求结束…`);
  try { server.closeIdleConnections?.(); } catch {}
  server.close(() => { console.log("[cc-go] 已干净退出"); process.exit(0); });
  const t = setTimeout(() => { console.log("[cc-go] 等待超时(120s)，强制退出"); process.exit(0); }, 120000);
  t.unref?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "127.0.0.1", () => {
  const pool = loadPool();
  console.log(`[cc-go] proxy on :${PORT} | 账号池 ${pool.length} 个 (${pool.map((a) => a.name).join(", ") || "空"})`);
});
