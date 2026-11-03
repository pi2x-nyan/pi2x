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

/**
 * DNS 解析顺序（可用 env 覆盖）—— 这一行曾把服务搞挂，务必读完再改。
 *
 * 历史两个阶段，方向完全相反：
 *   · 阶段一（旧网络）：本机 IPv6 到 Cloudflare 是黑洞 → 必须在进程里
 *     写死 setDefaultResultOrder("ipv4first")，否则每个请求都先试 IPv6 挂在
 *     那里，表现为「三/四个账号全部 ETIMEDOUT」。
 *   · 阶段二（2026-09-24 网络变更后）：反过来 —— **IPv4 到 Cloudflare 不通，
 *     IPv6 通**。而写死的 ipv4first 让 Node 优先走 IPv4，于是大请求全部
 *     0.7s 级 ETIMEDOUT（实测对照：同一 5.68MB 请求 default 顺序 15.9s 成功，
 *     ipv4first 0.7s 失败）；小请求偶尔靠 Happy Eyeballs 回退到 IPv6 才能过，
 *     所以症状看起来时好时坏、且“只有大请求失败”。
 *   · 结论：**两个方向都不能写死** —— 网络会变，写死哪一边早晚会翻车。
 *     默认不动 Node 的选择（它默认 autoSelectFamily：IPv6/IPv4 并发尝试，
 *     哪个先通先用）；确需强制时用 COMMANDCODE_DNS_ORDER 显式指定。
 *
 * 取值：default（默认，不干预）| ipv4first | ipv6first | verbatim
 */
const DNS_ORDER = (process.env.COMMANDCODE_DNS_ORDER ?? "default").toLowerCase();
if (["ipv4first", "ipv6first", "verbatim"].includes(DNS_ORDER)) {
  dns.setDefaultResultOrder(DNS_ORDER);
}

/**
 * 长连接保活（对付手机链路到 Cloudflare 的**新建连接**周期性快速失败）。
 *
 * 【实测依据 2026-09-24/25】同一时刻对照：
 *   直连上游（新建连接）0/3 失败（ETIMEDOUT 0.7~2.6s）
 *   经本代理（复用已有连接）3/3 成功
 * 也就是说“能不能连上”取决于连接是不是已建立的。而 Node fetch 默认空闲 4 秒就关，
 * 每轮对话都得重新握手 → 必然踩上抖动窗口 → 12 次尝试全灭 → bot 只能回兜底文案。
 * 把连接池的空闲保活拉长，让一条已验证可用的连接持续复用即可绕过大部分抖动；
 * 代价为零（不发心跳请求、不消耗额度）。
 */
try {
  const { Agent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: Number(process.env.COMMANDCODE_KEEPALIVE_MS ?? 300000),
    keepAliveMaxTimeout: Number(process.env.COMMANDCODE_KEEPALIVE_MAX_MS ?? 900000),
    connections: Number(process.env.COMMANDCODE_POOL_CONNS ?? 8),
    connect: { timeout: Number(process.env.COMMANDCODE_CONNECT_TIMEOUT_MS ?? 20000) },
  }));
  console.log("[cc-go] 连接池：keep-alive 5 分钟 · 最多 8 连接 · 连接超时 20s");
} catch (e) {
  console.log("[cc-go] undici 不可用，沿用默认连接池:", String(e?.message ?? e).slice(0, 80));
}

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根：由本文件位置推导，避免写死部署路径 */
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 号池文件路径：private/.cc-pool.json 优先，其次旧位置 <root>/.cc-pool.json。
 *
 * 【为什么不能写死 ROOT_DIR/.cc-pool.json】
 * 隐私数据迁进 private/ 后，写死旧路径会读不到池子。
 * 注意本脚本是长期常驻进程（screen 托管）：**迁移前启动的进程会一直
 * 拿着旧的解析结果**，必须重启才会生效。
 */
function resolvePoolFile() {
  const inPrivate = path.join(ROOT_DIR, "private", ".cc-pool.json");
  try {
    if (fs.statSync(inPrivate).isFile()) return inPrivate;
  } catch {
    /* private/ 未启用或未搬完 */
  }
  return path.join(ROOT_DIR, ".cc-pool.json");
}

const BASE = "https://api.commandcode.ai";
const CC_VERSION = "0.26.20";
const PORT = Number(process.env.COMMANDCODE_PROXY_PORT ?? 20228);
const MODELS_URL = `${BASE}/provider/v1/models`;
const CATALOG_URL = "https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md";
const POOL_FILE = process.env.COMMANDCODE_POOL_FILE ?? resolvePoolFile();
const HEARTBEAT_MS = Number(process.env.COMMANDCODE_HEARTBEAT_MS ?? 5000);
/** 单次尝试的「等响应头」超时：连接/排队问题快速暴露，而不是挂到客户端超时 */
const HEADER_TIMEOUT_MS = Number(process.env.COMMANDCODE_HEADER_TIMEOUT_MS ?? 60000);
/** 流式传输中「无数据」空闲超时（正常流有事件/心跳，长时间静默视为卡死） */
const IDLE_TIMEOUT_MS = Number(process.env.COMMANDCODE_IDLE_TIMEOUT_MS ?? 300000);
/** 账号池轮询轮数（网络抖动时多试一轮） */
const ATTEMPT_ROUNDS = Number(process.env.COMMANDCODE_ATTEMPT_ROUNDS ?? 4);
/**
 * 轮次之间的退避（毫秒，逐轮递增）。
 * 【为什么需要】上游到 Cloudflare 的连接会**瞬时抖动**：失败很快（ETIMEDOUT 常在 0.5~2.7s 返回），
 * 但下一次可能就正常。原先只等 1.2s、仅 2 轮 —— 抖动窗口内 8 次尝试会在 2 秒内全部烧完，
 * 整轮就变成空回复。改成递增退避 + 3 轮，把这类瞬时抖动“熬过去”。
 */
const ROUND_BACKOFF_MS = String(process.env.COMMANDCODE_ROUND_BACKOFF_MS ?? "1000,4000,10000,20000")
  .split(",")
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x) && x >= 0);
/** 账号 429/额度超限后的冷却时长（默认 10 分钟；命中 Retry-After 时以它为准，上限 1 小时）。
 *  作用：把「已超额」的账号暂时踢出轮询，避免每次都白跑一次再切（省 ~2s/请求 的额外延迟）。 */
const COOLDOWN_MS = Number(process.env.COMMANDCODE_429_COOLDOWN_MS ?? 600000);
const COOLDOWN_MAX_MS = Number(process.env.COMMANDCODE_429_COOLDOWN_MAX_MS ?? 3600000);
/**
 * 账号「余额不足以覆盖本次请求」（上游 400 insufficient credits）的冷却时长：默认 1 小时。
 * 这类失败不会自己好（要充值或等月度重置），所以比限流冷却得更久，
 * 否则每个请求都会把已经没有额度的账号白试一遍（实测白试了 40 次）。
 */
const CREDITS_COOLDOWN_MS = Number(process.env.COMMANDCODE_CREDITS_COOLDOWN_MS ?? 3600000);
/** 全池状态文件：供 scripts/cc-pool-alert.sh 判断「是不是所有账号都不可用了」并发告警 */
const POOL_STATE_FILE = path.join(ROOT_DIR, "private", "state", "cc-pool-state.json");

/** 写全池状态（成功/失败都写；带时间戳，告警脚本据此判断新鲜度） */
function writePoolState(ok, reason = "") {
  try {
    fs.mkdirSync(path.dirname(POOL_STATE_FILE), { recursive: true });
    fs.writeFileSync(POOL_STATE_FILE, JSON.stringify({ ok, reason, at: new Date().toISOString() }));
  } catch {
    /* 写不了就算了，不影响主流程 */
  }
}
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
        // 只服务本代理声明的模型。收到别的模型名（例如 OmniRoute 把 anthropic:glm-4.6 之类
        // 误路由到这里）直接拒绝 —— 否则会原样转发上游，4 账号 × 2 轮全被 403 拒掉，纯浪费。
        const reqModel = String(body.model ?? "");
        if (!Object.prototype.hasOwnProperty.call(MODEL_ALIASES, reqModel)) {
          const msg = "unsupported model: " + reqModel + "（本代理仅提供 deepseek-flash）";
          console.log("[cc-go] " + msg);
          // 注意：此处 endRes/心跳尚未初始化（在下面才定义），所以**不能**用 endRes，
          // 直接回 400 即可（此刻还没发响应头）。—— 之前用 endRes() 触发过 TDZ 异常。
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: msg } }));
          return;
        }
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
        // 上游把「请求被拒」之类的错误藏在 HTTP 200 的流里（实测超限时回
        // {"type":"error","error":{"message":"Bad Request","statusCode":400}}）。
        // 不识别的话客户端只会看到一个“一个 delta 都没有的空流”，bot 报「模型返回了空内容」，
        // 完全看不出真因；而且这个失败是**请求级**的（换账号也没用），应立即失败、不再白传 12 次。
        let upstreamErr = null;
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
              if (r.ok) { up = r; acct = cand; coolingUntil.delete(cand.name); writePoolState(true, ""); break outer; }
              const t = await r.text().catch(() => "");
              lastErr = `upstream ${r.status}: ${t.slice(0, 200)}`;
              // 额度类失败：429/402，以及 400 的「insufficient credits」（余额不够覆盖本次请求）
              const isCredits = r.status === 400 && /insufficient credits|insufficient_credits/i.test(t);
              if (r.status === 429 || r.status === 402 || isCredits) {
                const ra = Number(r.headers.get("retry-after"));
                const base = isCredits ? CREDITS_COOLDOWN_MS : COOLDOWN_MS;
                const cd = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, Math.max(base, COOLDOWN_MAX_MS)) : base;
                coolingUntil.set(cand.name, Date.now() + cd);
                console.log(`[cc-go] 账号 ${cand.name} ${isCredits ? "余额不足" : "额度/限流"}(${r.status})，冷却 ${(cd / 60000).toFixed(1)} 分钟后重试`);
                // 注意：**不要**在这里写 writePoolState(false) —— 这只是「单个账号」没钱，
                // 其他账号还能用；全池状态只能在整个轮询彻底失败时（下面的 !up 分支）才置为不可用。
                // 否则单号欠费就会误报「号池不可用」告警。
              }
              // 模型不被上游识别：是请求本身的问题，换账号也没用 → 立即停止轮询，别再白试
              if (r.status === 403 && /Model\/provider not recognized/i.test(t)) {
                console.log(`[cc-go] 上游不认这个模型，停止轮询：${t.slice(0, 120)}`);
                lastErr = `model not recognized: ${t.slice(0, 160)}`;
                clearTimeout(headerTimer);
                break outer;
              }
              // 【账号级失败必须换号重试】余额不足/额度类失败是**单个账号**的问题，
              // 其他账号仍可能可用，因此必须继续下个候选，不能 break outer 直接放弃。
              // （400 不在 RETRY_STATUS 里 —— 早期写法会让「余额不足」走到下面
              //   那个 break outer，表现为「一个号没钱 → 整池放弃」，实测踩过。）
              if (isCredits) {
                console.log(`[cc-go] 账号 ${cand.name} 余额不足，切换下一个账号`);
                // 用 continue（内层）而非 continue outer：后者会跳到下一轮，
                // 把本轮剩下未试的账号全部略过；ATTEMPT_ROUNDS=1 时甚至一个都不试。
                continue;
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
          if (round < ATTEMPT_ROUNDS - 1) {
            const wait = ROUND_BACKOFF_MS[Math.min(round, ROUND_BACKOFF_MS.length - 1)] || 1000;
            console.log(`[cc-go] 第 ${round + 1} 轮全失败，${(wait / 1000).toFixed(1)}s 后重试（共 ${ATTEMPT_ROUNDS} 轮）`);
            await new Promise((r) => setTimeout(r, wait));
          }
        }
        if (ac.signal.aborted) return endRes();
        if (!up) {
          console.log(`[cc-go] 全部账号失败(${pool.length}个×${ATTEMPT_ROUNDS}轮): ${lastErr}`);
          writePoolState(false, lastErr);
          if (wantStream) { res.write(`data: ${JSON.stringify({ error: { message: `all accounts failed: ${lastErr}` } })}\n\n`); res.write("data: [DONE]\n\n"); } else res.write(JSON.stringify({ error: { message: `all accounts failed: ${lastErr}` } }));
          return endRes();
        }
        const nTools = envelope.params.tools.length;
        console.log(`[cc-go] acct=${acct.name} stream=${wantStream ? 1 : 0} model=${upstreamModel} msgs=${envelope.params.messages.length} tools=${nTools} req=${(bodyBytes/1024).toFixed(0)}KB 等头=${((Date.now()-tReq)/1000).toFixed(1)}s`);

        // ③ 事件处理
        const handleEvent = (ev) => {
          const t = ev.type ?? "";
          // ① 流内错误帧：捕获并停止转发 → 外层当作本次尝试失败（换号/报错），避免静默转成空流
          if (t === "error" || ev.error) {
            const em = ev.error?.message ?? ev.message ?? JSON.stringify(ev.error ?? ev).slice(0, 200);
            upstreamErr = `upstream stream error: ${em}`;
            console.log(`[cc-go] 上游流内错误: ${String(em).slice(0, 200)}`);
            return false;
          }
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
        // 上游在流里报了错（已停止转发）：把它当本次尝试失败抛出，由外层换账号/汇总报错。
        // 这样“空回复”不再是黑盒子 —— 日志里会直接写上游的原话。
        if (upstreamErr) throw new Error(upstreamErr);

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
