/**
 * 日志 —— 结构化、带轮次 ID 与耗时
 *
 * 【为什么需要】
 * 重构前全项目 35 处裸 console.log，输出是纯文本且没有时间戳，排查问题只能靠
 * 在 bridge.log 里数行号、对相邻行猜因果。典型的痛点是：
 *   · 想知道「这一轮为什么慢」→ 无法区分是模型慢、工具慢还是压缩慢
 *   · 想知道「这条日志属于哪个会话/哪一轮」→ 上下文靠人脑补
 *   · 想按级别过滤 → 没有级别，只能 grep 关键词
 *
 * 【设计】
 *  1. **级别**：debug < info < warn < error，由 LOG_LEVEL 环境变量控制（默认 info）
 *  2. **轮次 ID**：用 AsyncLocalStorage 传递 turnId，异步链内自动继承，
 *     工具与子模块不需要手动传参就能把日志归到同一轮
 *  3. **耗时**：logger.time(label) 返回一个 stop() 函数，用于测量任意区间
 *  4. **双通道**：默认人类可读（保持 tail 可用）；LOG_FORMAT=json 时输出 JSON Lines，
 *     便于将来接采集器
 *  5. **零依赖**：只用 node:async_hooks / node:util，不引第三方
 *
 * 【用法】
 *   import { log } from "./log.mjs";
 *   log.info("boot", "服务已就绪");
 *   const stop = log.time("turn", "模型调用");
 *   ... await 慢操作 ...
 *   stop();                       // 自动输出「耗时 xx ms」
 *   log.withTurn("private:123", () => { ... });   // 此作用域内所有日志自动带轮次号
 */
import { AsyncLocalStorage } from "node:async_hooks";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** 当前生效级别（LOG_LEVEL=silent 可完全静音） */
function pickLevel() {
  const raw = String(process.env.LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}
let threshold = pickLevel();

/** 输出格式：human（默认，保持 tail 可读）| json（JSON Lines，便于采集） */
const FORMAT = String(process.env.LOG_FORMAT ?? "human").toLowerCase();

const turnStore = new AsyncLocalStorage();

/** 轮次计数器：给每一轮分配一个稳定短号，便于在日志里追同一轮 */
let turnSeq = 0;

/**
 * 在指定轮次上下文中执行函数。异步链内所有 log 调用自动带上该轮次号。
 * @template T
 * @param {string} chatKey 会话键（如 private:1000000001）
 * @param {() => T} fn
 * @returns {T}
 */
export function withTurn(chatKey, fn) {
  const id = `t${++turnSeq}`;
  return turnStore.run({ id, chatKey }, fn);
}

/** 取当前轮次上下文（无则 null） */
export function currentTurn() {
  return turnStore.getStore() ?? null;
}

function fmtArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/**
 * 本地时间 YYYY-MM-DD HH:MM:SS.mmm（人类可读通道用；JSON 通道用 ISO UTC 标准格式）
 *
 * 【为什么必须带日期】原先只输出 HH:MM:SS.mmm，日志文件是 append 累积的、也不按天切分，
 * 于是同一个 12:19:15 在文件里可能有多个（分属不同日期）。2026-09-14 就真踩过这个坑：
 * 按 `grep 12:19:15` 找到的是 9/12 那天的行，被当成当天的用户消息，据此推理一路跑偏。
 * 带日期后既不歧义、又天然可排序。
 */
function localStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  return `${date} ${time}`;
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const ctx = turnStore.getStore();
  const msg = fmtArgs(args);
  if (FORMAT === "json") {
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, scope, turn: ctx?.id ?? null, chat: ctx?.chatKey ?? null, msg })}\n`
    );
    return;
  }
  const tag = `[${level}]`;
  const scopeTag = scope ? `[${scope}]` : "";
  const turnTag = ctx ? `[${ctx.id}${ctx.chatKey ? ` ${ctx.chatKey}` : ""}]` : "";
  process.stdout.write(`${localStamp()} ${tag}${scopeTag}${turnTag} ${msg}\n`);
}

/** 记录器工厂：绑定一个 scope（模块/子系统名） */
export function createLogger(scope) {
  if (!scope) return rootLogger;
  const scoped = {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
    /**
     * `console.log` 兼容别名 → info。
     * 存在的理由：TurnAssembler 这类组件历史上按 `console` 接口注入 logger（调 `.log()`），
     * 不传 logger 时就落到真 console，裸写 stdout 绕过本模块 —— 那些行因此没有时间戳。
     * 提供 .log() 后，调用方可以直接注入 createLogger(...)，输出自然带时间戳与 scope。
     */
    log: (...a) => emit("info", scope, a),
    /**
     * 计时器：stop() 输出耗时；stop(extra) 可附加上文
     * @param {string} label
     * @returns {(extra?: string) => number} 返回 stop，且 stop 返回毫秒数
     */
    time(label) {
      const t0 = Date.now();
      return (extra) => {
        const ms = Date.now() - t0;
        emit("info", scope, [`${label} 用时 ${ms}ms${extra ? ` · ${extra}` : ""}`]);
        return ms;
      };
    },
    withTurn,
  };
  return scoped;
}

const rootLogger = {
  debug: (...a) => emit("debug", "", a),
  info: (...a) => emit("info", "", a),
  warn: (...a) => emit("warn", "", a),
  error: (...a) => emit("error", "", a),
  log: (...a) => emit("info", "", a), // console.log 兼容别名，见 createLogger
  time(label) {
    const t0 = Date.now();
    return (extra) => {
      const ms = Date.now() - t0;
      emit("info", "", [`${label} 用时 ${ms}ms${extra ? ` · ${extra}` : ""}`]);
      return ms;
    };
  },
  withTurn,
};

export const log = rootLogger;

/** 运行期调整级别（供 /loglevel 之类的命令使用；也可用于测试） */
export function setLevel(name) {
  threshold = LEVELS[String(name).toLowerCase()] ?? threshold;
  return threshold;
}

export function getLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold) ?? "info";
}

export default log;
