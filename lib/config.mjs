/**
 * 配置与路径 —— 全项目唯一配置入口（单一数据源）
 *
 * 设计原则：
 *  1. **一处定义**：配置默认值只写在这里，业务代码不再散落 `?? 2000` 这类魔数。
 *  2. **容错读取**：config.json 缺失/损坏时用内置默认值启动（只告警，不崩溃）。
 *  3. **浅合并语义**：默认值只在「键缺失」时补齐，不覆盖用户显式写的值
 *     （数组整体替换，不做逐元素合并，避免出现无法预期的半合并状态）。
 *  4. **路径统一**：ROOT / AGENT_DIR / WORKSPACE / SESSIONS_DIR / SKILLS_DIR 从这里导出，
 *     避免各文件自己 `path.dirname(path.dirname(...))` 拼路径。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 内置默认值（与 config.json 中已写明的值保持一致；改这里等于改全项目默认行为） */
export const DEFAULTS = Object.freeze({
  napcat: {
    dir: "./napcat",
    qqAccount: "?",
    onebot: { wsHost: "127.0.0.1", wsPort: 3001, token: "" },
    autoLogin: true,
  },
  pi: {
    workspace: "./workspace",
    agentDir: "./agent-dir",
    replyTimeoutMs: 180000,
    maxReplyChars: 1500,
    model: "omniroute/deepseek-flash",
    streamReplies: true,
    submitTimeoutMs: 600000,
    streamFlushMin: 80,
    streamFlushMax: 500,
    streamFlushIdleMs: 2000,
    /** 会话上下文占用达到该百分比时触发自动压缩（pi 的 percent 量纲是 0~100） */
    compactPercent: 40,
    /** 同一会话两次自动压缩的最小间隔（毫秒），防抖 */
    compactCooldownMs: 60000,
    /** 压缩等待上限（毫秒）——超过则不再阻塞本轮提交 */
    compactWaitMs: 120000,
    /**
     * 闲置压缩：**整轮结束**后经过该毫秒数、且上下文占比超过 compactIdlePercent 时自动压一次。
     * 默认 23 小时 —— 特意卡在「缓存偶尔可达 24 小时」之下：
     * 短闲置时上游缓存可能还热着（此时压缩会把热缓存作废，反而增加下一轮的未命中），
     * 只有接近 24 小时才基本确定缓存已失效，压缩才纯粹是收益。
     * 注意「一轮里工具执行很久」不算闲置 —— 巡检会跳过进行中的轮次。
     */
    compactIdleMs: 82800000,
    /** 闲置压缩的最低上下文占比（0~100）：太小则压了不划算 */
    compactIdlePercent: 20,
    /** 闲置巡检间隔（毫秒） */
    compactIdleScanMs: 60000,
    /**
     * 摘要输出预算（pi 的 reserveTokens）：摘要 token 上限 = floor(0.8 × 此值)。
     * 40983 ⇒ 摘要最多写 32786 token。
     * pi 默认为 16384（只允许写 13107 token），长历史会被截断、
     * 导致整次压缩被静默放弃 —— 故显式抬高。详见 lib/agent/settings.mjs。
     */
    compactionReserveTokens: 40983,
    /** 压缩后原样保留的近期上下文 token 数 */
    compactionKeepRecentTokens: 40000,
    /** 工具调用耗时超过该值（毫秒）才记日志，避免高频小工具刷屏 */
    slowToolMs: 500,
    /** 工具调用文本泄露的连续重试上限（超过则改用固定兜底文案） */
    leakMaxRetries: 3,
    /** subagent 默认超时（秒） */
    subagentTimeoutSec: 240,
    /** 人格注入配置（enabled + 提示词文件名）——结构随配置变化，用空对象占位 */
    persona: {},
  },
  permissions: {
    groupReplyMode: "mention",
    nameKeywords: ["pi2x", persona],
    driftCooldownMin: 30,
    driftProbability: 0.04,
    driftStaleMin: 10,
  },
  memory: {
    enabled: true,
    dbPath: "./workspace/memories/memory.db",
    modelDir: "./workspace/memories/models",
    sandboxDir: "./sandbox",
    harvestIntervalMin: 10,
    maxFacts: 500,
    injectChars: 2500,
    harvestModel: "deepseek-chat",
    embedModel: "Xenova/multilingual-e5-small",
    embedPrefixQuery: "query: ",
    embedPrefixPassage: "passage: ",
    scoring: {},
    reflect: { enabled: true, hours: 336, limit: 80, intervalMin: 720 },
  },
  winShell: {
    enabled: true,
    host: null,
    fallbackHost: null,
    fallbackHosts: [],
    probeTimeoutMs: 800,
    /** 地址探测结果的缓存有效期（毫秒）：过期后重新探测，防首选地址悄悄挂掉 */
    probeTtlMs: 20000,
    port: 8123,
    token: "",
    timeoutMs: 60000,
  },
  /** 工具参数默认值与约束（模型的调用契约，同时写在 prompt/tools/*.md 里，改这里要同步改文档） */
  tools: {
    // search_memories
    searchLimitDefault: 10,
    searchLimitMax: 30,
    // subagent_result
    resultDefaultChars: 3000,
    resultMinChars: 100,
    resultMaxChars: 8000,
    // list_reminders
    listAllLimit: 20,
  },
  /** 自建网关（可选）：地址与密钥不应写进代码，故只从环境变量或本地配置读 */
  omniroute: {
    baseUrl: null,
    apiKey: null,
  },
  /** 生命周期与降级链（看门狗读这里） */
  lifecycle: {
    /** 正常/安全模式心跳间隔（毫秒） */
    heartbeatIntervalMs: 60000,
    /** 心跳超过多久算「进程卡死」——给 3 分钟宽容，避免偶发卡顿误判 */
    heartbeatStaleMs: 180000,
    /** 正常模式自动拉起次数上限：先自救三次，三次都失败才降级到安全模式 */
    maxNormalAttempts: 3,
    /** 安全模式连续拉不起来几次后，下沉到纯回退模式 */
    maxSafeAttempts: 3,
    /**
     * 安全模式的管理员兜底名单：白名单文件读取失败或其结果为空时使用。
     * 正常应保持与 whitelist.json 里的 admin 一致。
     */
    safeAdminIds: [],
  },
  /** 沙箱内 bash 工具的超时约束（秒） */
  sandboxBash: {
    defaultTimeoutSec: 15,
    minTimeoutSec: 3,
    maxTimeoutSec: 120,
    /** 单条命令输出截断上限（字符） */
    maxOutputChars: 20000,
  },
});

const CONFIG_PATH = path.join(ROOT, "config.json");

/** 深合并：只补缺失键；数组与标量一律「用户值优先」 */
function mergeDefaults(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || typeof base !== "object") return override;
  if (typeof override !== "object" || Array.isArray(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = mergeDefaults(base[k], v);
  return out;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { cfg: mergeDefaults(DEFAULTS, raw), ok: true, error: null };
  } catch (e) {
    return { cfg: mergeDefaults(DEFAULTS, {}), ok: false, error: e };
  }
}

const loaded = load();

/** 合并后的配置对象（默认值已补齐） */
export const config = loaded.cfg;

/** 加载是否成功（用于启动时告警） */
export const CONFIG_OK = loaded.ok;
export const CONFIG_ERROR = loaded.error;

if (!loaded.ok) {
  // 只告警不退出：宁可带默认值运行，也不要因为一个配置文件让 bot 起不来。
  // 注意：config.mjs 不能 import log.mjs（会形成循环依赖），故这里直接写 stderr。
  process.stderr.write(`[warn][config] 读取配置失败，已回退默认配置：${loaded.error?.message}\n`);
}

/** 点号取值：cfg("pi.submitTimeoutMs") —— 拿不到就返回 fallback */
export function cfg(dotted, fallback = undefined) {
  let cur = config;
  for (const part of String(dotted).split(".")) {
    if (cur == null || typeof cur !== "object") return fallback;
    cur = cur[part];
    if (cur === undefined) return fallback;
  }
  return cur === undefined ? fallback : cur;
}

/** 原子写：先写临时文件再 rename，避免进程被杀时留下半截 JSON */
export function saveConfig(mutate) {
  const current = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const next = mutate(current) ?? current;
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

export const AGENT_DIR = path.resolve(ROOT, config.pi.agentDir);
export const WORKSPACE = path.resolve(ROOT, config.pi.workspace);
export const SESSIONS_DIR = path.join(ROOT, "sessions");
export const SKILLS_DIR = path.join(ROOT, "prompt", "skills");
export const LOGS_DIR = path.join(ROOT, "logs");
/**
 * 运行状态目录（模式标记、心跳、已知可用版本…）。
 * 允许用 PI2X_STATE_DIR 覆盖 —— 演练/测试需要在沙盒里跑真实的看门狗代码，
 * 又绝不能碰正在服务的进程的真实状态文件。
 */
export const STATE_DIR = process.env.PI2X_STATE_DIR
  ? path.resolve(process.env.PI2X_STATE_DIR)
  : path.join(ROOT, "state");

export default config;
