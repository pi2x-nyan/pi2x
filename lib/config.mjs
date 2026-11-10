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
    // 角色卡（Character Card V2 子集）：人设正文放卡文件，system.md 只留运维规则。
    // 默认关闭 —— enabled=false 时 system prompt 与迁移前的基础文本一字不差。
    persona: {
      enabled: false,
      cardFile: "./private/persona/card.json",
    },
    replyTimeoutMs: 180000,
    maxReplyChars: 1500,
    // 默认模型：用 OmniRoute 侧的**精确模型 ID**而非 combo 别名。
    // 原因：网关对 `deepseek-flash` 这个 combo 别名做能力探测，带 image 的请求会被
    // fallback 到 gpt-5.6（长期 404/cooldown）；精确 ID `openai/deepseek-flash` 可正常
    // 路由并识图（详见 lib/model-config.mjs 的 OMNIROUTE_MODELS 注释）。
    model: "omniroute/openai/deepseek-flash",
    streamReplies: true,
    // 主动回合（heartbeat）：没人说话时周期性自检「有没有该说的事」。
    // 默认关闭；开启后由 lib/proactive.mjs 的四道闸控制（静默时段/冷却/每日上限/用户活跃）。
    proactive: {
      enabled: false,
      chats: [],
      intervalMinutes: 180,
      quietHours: [23, 8],
      dailyMax: 3,
      minIdleMinutes: 15,
      maxChars: 120,
    },
    /**
     * 系统唤醒：外部事件队列（mooc/disk/job）→ 唤醒 Router 一轮。
     * 与 proactive.enabled **无关** —— 事件是「出事了」，不该被静默时段挡住。
     * chat 留空 = 取 proactive.chats 第一个（即 admin 私聊）。
     */
    systemWake: {
      enabled: true,
      types: ["mooc", "disk", "job"],
      chat: "",
      intervalSec: 60,
      throttleMinutes: 30,
      dailyMax: 12,
    },
    // 工单运行时（借鉴 dsh-superagent 的 Ticket/Router/Worker）
    //   mode: off      只接人当面点的活（私聊、@我）
    //         observe  额外把「按规则本来会接的活」记成影子工单，不执行
    //         auto     observe 记录的也真派下去
    //   slotLimit      同时能跑几个 worker，超出的排队
    //   followupRouting 人引用我的通知再说一句时，把它递进对应工单（默认关）
    superagent: {
      mode: "off",
      slotLimit: 3,
      followupRouting: false,
      allowedUsers: [],
      listenAllChats: [],
      allowBots: false,
      paused: false,
    },
    submitTimeoutMs: 600000,
    /**
     * 单轮总时长硬上限（毫秒），0 = 不设。
     *
     * submitTimeoutMs 现已语义为**空闲超时**（任何活动都续期，只有连续静默才判卡死）；
     * 本项是与之互补的总时长上限，用于弟住「每步都有活动但永不收敛」的病态循环。
     * 默认不开：持续干活本就是正常行为，不应被总时长砍断。
     */
    submitTotalTimeoutMs: 0,
    streamFlushMin: 80,
    streamFlushMax: 500,
    streamFlushIdleMs: 2000,
    /**
     * 静默提醒：本轮**一个字都还没发出去**、且连续静默超过该毫秒数时，
     * 主动给用户回一句「还在处理」——避免长任务里用户以为进程挂了而反复追问。
     * 0 = 关闭。最多提醒 6 次（NOTICE_MAX）。
     */
    silenceNoticeMs: 600000,
    /** 模型「成功返回但内容为空」时，换连接重试的最大次数（0 = 不重试，直接回兜底文案） */
    emptyRetryMax: 1,
    /**
     * 所有会话的思考等级（新会话默认值 + 打开既有会话时强制覆盖）。
     *
     * 【为什么用 max】上游 deepseek-v4.1-flash 是推理模型，正文与推理是两个字段：
     * 思考预算不足时它可能把整轮 token 都花在推理上、正文为空，
     * 客户端收到「一个 delta 都没有」的空流。给足思考预算能显著降低这种「只想不说」。
     *
     * 取值：off / minimal / low / medium / high / xhigh / max。
     * 模型不支持的等级由 SDK 的 clampThinkingLevel 自动落到相邻可用档，
     * 所以这里写死一个等级是安全的（不会因为换了模型而报错）。
     */
    thinkingLevel: "max",
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
    /**
     * 子代理跑在哪台机器：auto | win | linux。
     *
     * 【为什么要有这个开关】默认 auto 是「Windows 优先」（因为 Windows 上有网页浏览/
     * 截图/UI 自动化等专属能力）。但子任务里给的路径往往是 **本机 Linux 路径**
     * （<PI2X_ROOT>/tmp/...），而 Windows 根本看不到这些文件 —— 于是子代理会
     * **秒退且没有任何输出**（实测：4 个任务全在 4 秒内 done、正文为空、产物为 0）。
     * 这种失败很隐蔽：状态是 done 不是 failed，不看产物根本发现不了。
     * linux：强制本机；win：强制 Windows（不可用即失败，不静默回退）；auto：旧行为。
     */
    subagentRunner: "auto",
    /**
     * 子任务超时上限（秒），默认 1800（30 分钟）。
     *
     * 【为什么不是 600】硬编码 600s 对「啃一道 CTF 逆向题」这类任务远远不够：
     * 子代理常常刚反汇编完、正要复刻解密逻辑就被砍掉。配合「异常结束留档」
     * （见 _startSubAsync 的 finally 分支 + sessions/subagent-archive/）才不会白烧。
     */
    subagentMaxTimeoutSec: 1800,
    /**
     * 【重启后自动接续】
     * 用户明确要求：bridge 重启后应自己接上，不要等人再发一条消息唤醒。
     *   restartResume          总开关（false 关闭）
     *   restartResumeDelayMs   启动后延迟多久执行（等 QQ 连接/模型就绪）
     *   restartResumeWindowMs  只接续「最近这个时间窗内被改动过」的会话（避免翻旧账）
     * 另：子任务派发时会落盘 pending 记录，重启后残留的会被当成「被重启打断」上报。
     */
    restartResume: true,
    restartResumeDelayMs: 8000,
    restartResumeWindowMs: 600000,
  },
  permissions: {
    groupReplyMode: "mention",
    nameKeywords: ["pi2x", "2x"],
    /**
     * 群聊里是否屏蔽「@全体成员」消息（默认 true）。
     *
     * 【为什么要有这个开关】@全体成员 是面向全群的公告，不是叫 bot；
     * 但 isMentioned 会把 at 段的 qq==="all" 也算命中，等于任何公告都能把 bot 拽醒。
     * true：这类消息整条忽略（不进模型、不回复）。
     * 注意：若消息**另外单独 @ 了 bot 本人**，仍然放行。
     * 设 false 可退回旧行为（用于排查「bot 怎么不说话了」）。
     */
    ignoreAtAll: true,
    driftCooldownMin: 30,
    driftProbability: 0.04,
    driftStaleMin: 10,
  },
  memory: {
    enabled: true,
    dbPath: "./workspace/memories/memory.db",
    // QQ → 称呼（仅私聊来源）。例：{ "10001": "主人" }
    // 抽取记忆时，凡指代该用户一律用这个称呼；公开仓不带任何具体值。
    addressing: {},
    modelDir: "./workspace/memories/models",    sandboxDir: "./sandbox",
    /**
     * 是否把「摘要」与「事实抽取」合并为同一次 LLM 调用（方案 A1）。
     *
     * true：压缩时自定义摘要提示词，让它一次输出 {summary, facts[]}，
     *       再用 session_before_compact 钩子接管这次压缩。省一次调用，
     *       且摘要与事实来自同一次理解，不会各读一遍。
     * false：退回「摘要由 pi 生成 + 另跑一次 harvest」的两次调用老路。
     *
     * 默认开。注意 false 是安全回退路径：合并方案若出问题可立即切回。
     */
    mergeHarvestIntoCompact: true,
    /**
     * 收割节流（分钟）。**0 = 不节流**。
     *
     * 收割已收敛为「每次压缩前跑一次」（见 lib/piagent.mjs 的 _harvestBeforeCompact），
     * 调用频率天然极低 —— 这时再套节流只会带来反面效果：压缩要丢历史了，
     * 却因为「该会话 10 分钟内刚收割过」而被拒，那批内容就真的没人来得及抢救。
     * 所以默认关闭；需要限流（如手动批量收割）时再调大。
     */
    harvestIntervalMin: 0,
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
    /** 所有候选地址都不可达时，自动扫描局域网重新发现 win-agent 并写回 config.json（默认关，避免误扫） */
    autoDiscover: false,
    /** 自动发现的超时上限（毫秒）——扫整个 /18 约需 30~60s */
    discoverTimeoutMs: 120000,
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
    /**
     * 重启锁的最长有效期（毫秒）。锁存在且未过期时，看门狗**只跳过一轮**探活
     * （避免与重启脚本抢拉），之后无论锁是否还在都照常探活 ——
     * 于是「重启最多被容忍这么久」，超时未就绪就由看门狗接管。
     * 这也是对残留死锁的兜底：脚本被 kill、锁没清掉，也不会让探活永久失效。
     */
    restartLockTtlMs: 120000,
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

const CONFIG_DIR_LEGACY = ROOT;

/**
 * 私密数据根目录 —— **所有本机私密信息都放这里**。
 *
 * 【为什么要单独一个目录】
 * 以前私密数据散落在仓库各处（config.json / whitelist.json / sessions/ / logs/ /
 * workspace/ / state/ / browser-profile/ / napcat/ / 人设文件…），只能靠 .gitignore
 * 逐条列，且发布时还得靠 scripts/export-public.mjs 另造一份「剥离快照」。
 * 后果：本地仓库 ≠ 公开仓库，两套东西、两个脑子记；一个手滑 push 就可能把人设/密钥推上去。
 *
 * 现在改成：私密全部收进 private/，仓库里只留纯代码。
 *   · .gitignore 只需忽略 private/ 一行；
 *   · 本仓库可以直接 push、直接 pull 别人的更新（不再需要“先导出公开版”）；
 *   · 新人部署只需建 private/ 并放入自己的配置（模板见根目录的示例配置）。
 *
 * 【向后兼容（平滑迁移，不是“一刀切”）】
 * 旧的部署里数据散在各处。若 private/ 不存在，就回落到旧布局 ——
 * 这样改代码与搬数据可以分两步走，任一步出问题都能退回旧行为、不影响服务。
 * 用 PI2X_PRIVATE_DIR 可显式指定（演练/测试用）。
 */
export const PRIVATE_DIR = process.env.PI2X_PRIVATE_DIR
  ? path.resolve(process.env.PI2X_PRIVATE_DIR)
  : path.join(ROOT, "private");

/** private/ 是否已启用（存在即启用；否则回落旧布局） */
export const PRIVATE_ENABLED = (() => {
  try {
    return fs.statSync(PRIVATE_DIR).isDirectory();
  } catch {
    return false;
  }
})();

/**
 * 定位一个私密资源：private/ 启用就用新位置，否则回落旧位置。
 *
 * 例：privPath("config.json")    → private/config.json    或 <root>/config.json
 *     privPath("sessions")       → private/sessions/       或 <root>/sessions/
 *
 * @param {string} rel private/ 下的相对路径
 * @param {string} [legacyRel] 旧布局下的相对路径（默认同 rel）
 * @returns {string} 绝对路径
 */
export function privPath(rel, legacyRel = rel) {
  return PRIVATE_ENABLED ? path.join(PRIVATE_DIR, rel) : path.join(ROOT, legacyRel);
}

/**
 * 配置文件路径：private/config.json（优先），其次旧位置 <root>/config.json。
 * 注：这里不用 PRIVATE_ENABLED 单判 —— 迁移过程中可能 private/ 已建、
 * 但 config.json 还没搬过去，那种半途中也不能读不到配置。
 */
const CONFIG_PATH = (() => {
  const inPrivate = path.join(PRIVATE_DIR, "config.json");
  const legacy = path.join(ROOT, "config.json");
  try {
    if (fs.statSync(inPrivate).isFile()) return inPrivate;
  } catch {
    /* private/ 未启用或未搬完 */
  }
  return legacy;
})();

export { CONFIG_PATH, CONFIG_DIR_LEGACY };

/**
 * 白名单文件路径：private/whitelist.json 优先，否则旧位置 <root>/whitelist.json。
 * 同 CONFIG_PATH，不用 PRIVATE_ENABLED 单判 —— 半搬迁状态下也能读到。
 */
export const WHITELIST_PATH = (() => {
  const inPrivate = path.join(PRIVATE_DIR, "whitelist.json");
  try {
    if (fs.statSync(inPrivate).isFile()) return inPrivate;
  } catch {
    /* 未启用或未搬完 */
  }
  return path.join(ROOT, "whitelist.json");
})();

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

// ── 运行期目录（全部经 privPath 派生：private/ 优先，否则回落旧布局）──
//
// 【为什么 WORKSPACE / AGENT_DIR 不能直接用 config.pi.workspace】
// 配置里默认是相对路径 `./workspace`，而 path.resolve(ROOT, ...) 会把它
// 固定在仓库根下 —— 于是 private/ 启用后，记忆库/凭据库仍旧写到旧位置，
// 相当于“搬家后又在新房子旁边盖了个旧仓库”。
// 现改为：**用户显式配置了绝对路径才用它**；否则用 private/ 派生位置。
const _absIfExplicit = (v, fallback) =>
  typeof v === "string" && path.isAbsolute(v) ? v : fallback;

export const AGENT_DIR = _absIfExplicit(config.pi.agentDir, privPath("agent-dir"));
export const WORKSPACE = _absIfExplicit(config.pi.workspace, privPath("workspace"));
export const SESSIONS_DIR = privPath("sessions");
export const SKILLS_DIR = path.join(ROOT, "prompt", "skills");
export const LOGS_DIR = privPath("logs");
/**
 * 运行状态目录（模式标记、心跳、已知可用版本…）。
 * 允许用 PI2X_STATE_DIR 覆盖 —— 演练/测试需要在沙盒里跑真实的看门狗代码，
 * 又绝不能碰正在服务的进程的真实状态文件。
 */
export const STATE_DIR = process.env.PI2X_STATE_DIR
  ? path.resolve(process.env.PI2X_STATE_DIR)
  : privPath("state");

/** 沙箱根目录（operator 用户的受限工作区） */
export const SANDBOX_DIR = privPath("sandbox");
/** 浏览器 profile（含登录态 cookie） */
export const BROWSER_PROFILE_DIR = privPath("browser-profile");
export const BROWSER_PROFILE_OP_DIR = privPath("browser-profile-op");
/** 临时文件目录 */
export const TMP_DIR = privPath("tmp");

/**
 * 解析一个「可能写在配置里的相对路径」，让它跟着 private/ 走。
 *
 * 【要解决的问题】配置里的默认值写的是相对路径，比如：
 *     memory.dbPath   = "./workspace/memories/memory.db"
 *     memory.modelDir = "./workspace/memories/models"
 * 这些字段一旦有值，`config.memory?.dbPath ?? path.join(WORKSPACE, ...)` 里的
 * 兵底就永远不会生效 —— 于是 private/ 启用后，记忆库/向量模型仍旧往
 * 旧位置 ./workspace/ 写（实测：搬家后又在那儿新长出一个 memory.db）。
 *
 * 本函数把这种「旧相对路径」映射到新位置：
 *   · 绝对路径 → 原样（用户显式指定的位置优先）
 *   · ./workspace/xxx → <WORKSPACE>/xxx
 *   · ./sandbox/xxx  → <SANDBOX_DIR>/xxx
 *   · 其它相对路径 → 相对 ROOT
 *
 * @param {string} p 配置里的路径
 * @param {string} [fallback] p 为空时的兵底
 * @returns {string} 绝对路径
 */
export function resolveDataPath(p, fallback) {
  if (typeof p === "string" && path.isAbsolute(p)) return p;
  if (!p) return fallback ?? "";
  const rel = String(p).replace(/^\.\//, "");
  if (rel === "workspace" || rel.startsWith("workspace/")) {
    const rest = rel.slice("workspace".length).replace(/^\//, "");
    return rest ? path.join(WORKSPACE, rest) : WORKSPACE;
  }
  if (rel === "sandbox" || rel.startsWith("sandbox/")) {
    const rest = rel.slice("sandbox".length).replace(/^\//, "");
    return rest ? path.join(SANDBOX_DIR, rest) : SANDBOX_DIR;
  }
  return path.join(ROOT, rel);
}

export default config;
