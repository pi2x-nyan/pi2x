/**
 * strix 框架会话管理 —— 让 QQ 用户（仅 admin）把当前会话切到 strix 引擎上
 *
 * ┌── 为什么需要它 ────────────────────────────────────────────────────────┐
 * │ PI2X 的主 agent 是 pi SDK（工具齐全、能读写文件、能跑子代理）。          │
 * │ strix 是另一个框架：自主渗透引擎，自带多 agent 编排（侦察/猎手/验证/报告）│
 * │ 用户希望**按会话切换**用哪个框架：自己的会话切到 strix 后，跟它多轮对话；  │
 * │ 其他用户的会话照旧走 PI2X，互不影响。                                    │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * 【核心设计：常驻会话，不是一轮一进程】
 * strix 自己就是「交互式会话」的模型：
 *   · agent 调用 `respond_to_user` → park 成 waiting，等用户回话
 *   · `coordinator.send()` 注入消息 → 唤醒它接着干
 * 所以这里维持**一个常驻 worker 进程**（strix/scripts/pi2x_worker.py），
 * 反复 send/poll，而不是每轮重启 + `--resume` 重放历史。
 * 历史本来就在 strix 的 agents.db 里，进程内存里也有完整状态 —— 重启是下策，
 * 只在进程死了、或者要切换/恢复另一个 run 时才用。
 *
 * 【会话隔离】
 * 每个 QQ 用户一个 worker（自己的 run_name、自己的 agents.db）。
 * 群里多个用户互不串台；别人的消息压根不进这里。
 *
 * 【谁在用】
 * 只有 admin —— 命令前缀 `/` 的统一鉴权已经在 piagent.handleCommand 里做了
 * （需要 files:full），本模块不再重复判断，但仍是**防御性**的：
 * 它由命令入口构造，构造时用的就是已鉴权过的 userId。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createLogger } from "./log.mjs";
import { ROOT, STATE_DIR } from "./config.mjs";

const logSx = createLogger("strix");

const STRIX_DIR = path.join(ROOT, "strix");
const WORKER = path.join(STRIX_DIR, "scripts", "pi2x_worker.py");
const RUNNER = process.env.PI2X_STRIX_RUNNER || path.join(STRIX_DIR, "scripts", "pi2x-worker.sh");
const RUNS_DIR = path.join(STRIX_DIR, "runs", "strix_runs");
const SESS_FILE = path.join(STATE_DIR, "strix-sessions.json");

/** 单条输出发给 QQ 的上限（QQ 单条消息不宜过长） */
const MAX_CHUNK = 1200;
/** 一轮对话的静默上限：超过这么久没新输出就先把已收到的回给用户 */
const IDLE_GRACE_MS = 90_000;
/** 一轮的绝对上限，防跑飞 */
const TURN_HARD_MS = 30 * 60_000;
/** worker 启动（模型预检 + 建会话）的超时上限 */
const STRIX_BOOT_TIMEOUT_MS = 120_000;

/**
 * 从 worker 的 stderr 里挖出「真正有用的那一句」。
 *
 * 【背景】strix 启动失败时会在 stderr 里打一整套 usage（十几行），最后一两行
 * 才是原因（如 `error: argument -t/--target: ...`）。整段丢给用户就是刷屏，
 * 所以只取 error/异常那几行。
 *
 * @param {string} buf
 * @returns {string} 提炼后的原因（拿不到就返回空串）
 */
export function extractStrixError(buf) {
  const s = String(buf ?? "");
  if (!s.trim()) return "";
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 优先：argparse 的 error 行、或 Python 异常末行
  const errLine = [...lines].reverse().find((l) => /^error:|^\S*Error:/.test(l));
  if (errLine) return errLine;
  // 次选：usage 之前的最后一行（strix 常把原因放这里）
  const usageIdx = lines.findIndex((l) => /^usage:/i.test(l));
  if (usageIdx > 0) return lines[usageIdx - 1];
  return lines[lines.length - 1] ?? "";
}

/** 落库的会话映射（userId → {runName, chatKey, since}）
 *
 * 【用途】记住某人上次用的会话，重启后 /strix status 能直接告诉他「你上次是哪个」，
 * 不用自己去 ls 里找（桥接进程重启会丢掉内存里的实例池，但这份记录留着）。
 * 它只是**提示**：真正接回仍需 /strix use，不会自动接管一个旧会话 ——
 * 自动接管会让「上次在扫生产环境」这种场景在重启后自己接着扫，风险太大。
 */
function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSessions(obj) {
  try {
    fs.mkdirSync(path.dirname(SESS_FILE), { recursive: true });
    const tmp = `${SESS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, SESS_FILE);
  } catch (e) {
    logSx.warn(`会话映射写入失败: ${e?.message}`);
  }
}

/** 列出 strix 已有会话（读 runs 目录，按最近活动排序） */
export function listStrixSessions(limit = 20) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(RUNS_DIR)) {
    const full = path.join(RUNS_DIR, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(full, "run.json"), "utf8"));
    } catch {
      /* 没有 run.json 也列出来（扫到一半的） */
    }
    // 显示名：优先用用户当初起的名字（.label），否则回退目录名
    let label = null;
    try {
      label = fs.readFileSync(path.join(full, ".label"), "utf8").trim() || null;
    } catch {
      /* 老会话没有标签，用目录名 */
    }
    out.push({
      runName: name,
      label,
      mtime: st.mtimeMs,
      status: meta.status ?? "?",
      mode: meta.scan_mode ?? "?",
      cost: Number(meta.llm_usage?.cost ?? 0),
      targets: (meta.targets_info ?? []).map((t) => t.original).filter(Boolean),
      instruction: String(meta.user_instruction || meta.instruction || "").slice(0, 120),
      vulns: Array.isArray(meta.scan_results?.vulnerabilities)
        ? meta.scan_results.vulnerabilities.length
        : null,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/**
 * 一个 QQ 会话对应的 strix worker。
 *
 * 生命周期：ensure() 惰性拉起 → send()/poll() 反复用 → stop() 收尾。
 * 进程死了会自动重启（同 runName 走 --resume，历史不丢）。
 */
class StrixSession {
  /**
   * @param {object} opts
   * @param {string} opts.userId   归属用户（隔离用）
   * @param {string} opts.chatKey  归属会话（隔离用）
   * @param {string|null} opts.runName 要接管的已有 run（null = 新建）
   */
  constructor({ userId, chatKey, runName = null }) {
    this.userId = String(userId);
    this.chatKey = String(chatKey);
    this.runName = runName;
    // 用户起的名字（可能与落盘名不同：中文名会落成 s<时间戳>）
    this.label = null;
    this.child = null;
    this.rl = null;
    this.ready = null;         // Promise<{runName, rootId}>
    this.rootId = null;
    this.resolvedRunName = null;
    this.pending = [];         // 收到但还没交给上层的输出
    this.waiters = [];         // 等待「有新输出 / 状态变化」的 resolve
    this.lastActivity = Date.now();
    this.busy = false;         // agent 是否正在干活
    this.settled = false;      // 本轮是否已收工（root 非 running）
    this.lastStatus = null;
    this.dead = false;
    this.generation = 0;       // 进程代次，用于识别重启
    /**
     * 「已登记但还没启动」的会话配置。
     *
     * 【为什么需要懒启动】`/strix new <名字>` 只给名字、不给任务，那时拉起 strix
     * 没有意义：agent 拿到的是空任务，不知道该干什么；而且 strix 自己也会拒绝
     * 恢复这种「无目标、无指令」的会话（run.json has no targets_info，实测）。
     * 所以 new/use 只登记，**第一句话才真正拉起** —— 那句话就是它的任务指令，
     * 之后的历史里就有据可查，恢复才不会失败。
     */
    this.pendingBoot = null;
  }

  /** 登记一个待启动的会话（new / use 时调用，不拉进程） */
  setPending(cfg) {
    this.pendingBoot = { ...cfg };
    return this.pendingBoot;
  }

  /**
   * 把用户起的会话名转成 strix 能用的内部名。
   *
   * 【为什么要转】strix 自己只吃 ASCII：它的 `_slugify_for_run_name`
   * 把非 `a-z0-9` 一律换成 `-`，且这个名字直接当目录名用（run_dir_for）。
   * 所以中文名不能原样交给它（实测 `我的审计` 会被拒/变成一串 `-`）。
   * 做法：显示名保留用户原样（存 label），落盘名用安全的 slug；
   * 两者都不含路径分隔符，避免目录穿越。
   *
   * @param {string} label 用户起的名字
   * @returns {string} 可安全做目录名的内部名
   */
  static slugOf(label) {
    const s = String(label ?? "").trim();
    const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
    // 保 ASCII 字母数字；其余（中文/空格/符号）转 '-'；再折叠连续 '-'。
    let ascii = s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "");
    // 【为什么带中文时不用 ASCII 碎片】「测试 A」曾落成 `a` —— 目录名认不出，
    // 而且不同名字容易撞出同一个 slug。带中文就直接用 `s<时间戳>` 更可辨。
    if (hasCjk || !ascii) {
      // 带 2 位随机后缀：只用时间戳时，同一毫秒内建两个中文名会撞出同一个目录
      // （实测「测试 A」与「扫描_生产」撞了），撞名会把新建变成悄悄接续旧会话。
      const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
      return `s${Date.now().toString(36)}${rand}`;
    }
    return ascii;
  }

  get hasPending() {
    return !!this.pendingBoot;
  }

  get alive() {
    return !!this.child && this.child.exitCode === null && !this.dead;
  }

  /** 起进程（或按需恢复） */
  /**
   * @param {object} o
   * @param {string|null} [o.sessionName] 会话名（新建时用；不填由 strix 自动命名）
   * @param {string[]} [o.targets] 目标：URL / IP / 域名 / 本地目录或文件（可空）
   * @param {string} [o.workspace] 无目标会话时给 agent 干活的工作目录
   */
  async start({ sessionName = null, targets = [], mode = "quick", budget = null, turns = null, instruction = "", workspace = null } = {}) {
    if (this.alive) return this.ready;
    this.dead = false;
    // 空/空白名字等同于「没有」—— 否则会拼出 `--resume ""` 让 strix 报参数错
    if (!String(this.runName ?? "").trim()) this.runName = null;
    const gen = ++this.generation;

    // 参数分两段，中间用一个 `--` 隔开：
    //     [--name X] [--workspace Y] -- <strix 原生参数...>
    // 【为什么不用两个 `--`】早先写成 `["--", ...自定义..., "--", ...strix...]`，
    // 结果 worker 把**第一个** `--` 当成前置段结束符，于是 `--name tyxsjpt` 被
    // 原样丢给 strix 的 argparse → “参数不合法”（实测）。前置段用「未加引号的
    // 形式」出现在首段，中间一个 `--` 才是分隔符。
    // sessionName 是给人看的名字；交给 strix 的必须是安全 slug（中文会变目录名）
    const storedName = sessionName ? StrixSession.slugOf(sessionName) : null;
    if (storedName && !this.runName) this.label = this.label ?? String(sessionName);
    const args = [];
    if (storedName && !this.runName) args.push("--name", storedName);
    if (workspace) args.push("--workspace", String(workspace));
    args.push("--");

    // 【为什么不传 -n】strix 的 `-n`（non-interactive）会强制要求 -t，于是
    // 「只建一个会话名、暂时不指定目标」就被它自己的 argparse 挡住了。而 `-n`
    // 我们并不需要：worker 是自己调 run_strix_scan() 的，不经过 strix 的 CLI
    // 主流程；不传 -n 时，无目标会走它官方的 setup 语义（挂 workspace + 指令），
    // 有目标则照常 build_targets_info。
    if (this.runName) {
      // 恢复：strix 的 --resume 会带出原来的目标列表，不能再给 -t
      args.push("--resume", String(this.runName));
      if (instruction) args.push("--instruction", instruction);
    } else {
      const list = (targets ?? []).filter(Boolean);
      // 目标可以没有 —— 交互式流程支持「只有一句话/一个工作目录」的会话。
      // 早先这里硬性要求至少一个目标，把「只想建个会话名」的用法挡在门外（用户要求）。
      for (const t of list) args.push("-t", String(t));
      args.push("--scan-mode", String(mode));
      if (instruction) args.push("--instruction", instruction);
    }
    // 【默认不限制】strix 的 --max-budget 默认 None、--max-turns 默认 500，
    // 本来就该由用户按需指定。早先硬塞 $2 / 30 轮，等于给每个会话套了个隐形绳套
    // （用户明确指出：「为什么会有预算限制」）—— 只有显式给了才传。
    if (budget != null) args.push("--max-budget", String(budget));
    if (turns != null) args.push("--max-turns", String(turns));

    logSx.info(
      `拉起 worker gen=${gen} 会话名=${storedName ?? this.runName ?? "(strix 自动命名)"}` +
        `${sessionName && storedName && sessionName !== storedName ? `（显示名「${sessionName}」）` : ""}` +
        ` 目标=${(targets ?? []).join(",") || "(无)"}`,
    );

    const child = spawn(RUNNER, args, {
      // cwd 必须是 strix/runs（与启动脚本内部一致）：strix 把 run 目录算作
      // `cwd/strix_runs/<name>`，cwd 不同会让会话落到另一个目录、`ls` 看不到。
      cwd: path.join(STRIX_DIR, "runs"),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;

    // 攒住 stderr：worker 启动失败（参数不合法等）时，报错只出现在这里 ——
    // 得把它带上，否则用户只看到一句「启动超时」，完全不知道该改什么。
    let stderrBuf = "";
    child.stderr.on("data", (d) => {
      const s = String(d);
      stderrBuf = (stderrBuf + s).slice(-4000);
      const t = s.trim();
      if (t) logSx.info(`worker[${gen}]: ${t.slice(0, 300)}`);
    });

    // 启动阶段的失败要**立刻**告诉用户。之前只在 180s 后抛「启动超时」：
    // 用户对着一条毫无信息量的文案干等三分钟，而真正的原因（strix 的
    // argparse 报错，目标格式不合法）就静静躺在 stderr 里 —— 这是实测踩到的。
    // settled / fail 必须在 Promise 构造器**内部**定义：写在外面时 fail 的闭包里
    // 拿不到 reject，真触发时抛 ReferenceError（实测把进程干崩了）。
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error(`strix 会话启动超时（${STRIX_BOOT_TIMEOUT_MS / 1000}s）`)),
        STRIX_BOOT_TIMEOUT_MS,
      );

      // worker 进程启动阶段就死了（参数错、依赖缺失…）→ 立刻失败并带上原因
      const onEarlyExit = (code, signal) => {
        if (settled) return;
        clearTimeout(timer);
        const detail = extractStrixError(stderrBuf) || `退出码 ${code}${signal ? ` signal ${signal}` : ""}`;
        fail(new Error(detail));
      };
      child.once("exit", onEarlyExit);
      const onLine = (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          clearTimeout(timer);
          settled = true;
          this.rootId = msg.root_id;
          this.resolvedRunName = msg.run_name;
          // 落盘一个小标签，记下「用户当初起的名字」。
          // 落盘名是转过的安全 slug（中文会变成 s<时间戳>），光看目录名
          // 根本认不出是哪个会话 —— 所以要单独存显示名。
          if (this.label) {
            try {
              fs.writeFileSync(
                path.join(RUNS_DIR, msg.run_name, ".label"),
                String(this.label),
                "utf8",
              );
            } catch (e) {
              logSx.warn(`写会话标签失败: ${e?.message}`);
            }
          }
          // 记住归属：run ↔ 用户
          const all = readSessions();
          all[this.userId] = {
            runName: msg.run_name,
            chatKey: this.chatKey,
            label: this.label ?? null,
            since: new Date().toISOString(),
          };
          writeSessions(all);
          resolve({ runName: msg.run_name, rootId: msg.root_id, label: this.label ?? null });
        } else if (msg.type === "error") {
          clearTimeout(timer);
          reject(new Error(msg.message));
        } else {
          this._ingest(msg);
        }
      };
      this.rl = readline.createInterface({ input: child.stdout });
      this.rl.on("line", onLine);
    });

    child.on("exit", (code, signal) => {
      logSx.warn(`worker gen=${gen} 退出 code=${code} signal=${signal}`);
      if (this.generation === gen) {
        this.dead = true;
        this.child = null;
        this.busy = false;
        this._wake({ type: "exit", code, signal });
      }
    });

    return this.ready;
  }

  /** 收 worker 的报文 → 进 pending，并唤醒等待者 */
  _ingest(msg) {
    this.lastActivity = Date.now();
    if (msg.type === "batch") {
      for (const it of msg.items ?? []) this._ingest(it);
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "status") {
      this.lastStatus = msg;
      this.busy = msg.root_status === "running";
      // agent 进了终态/等人：说明这轮说完了（strix 的语义：交付答复=让出控制权）
      this.settled = msg.root_status !== "running";
      this._wake({ type: "status", status: msg });
      return;
    }
    if (msg.type === "say") {
      this.pending.push(msg);
      this._wake({ type: "say", item: msg });
      return;
    }
    if (msg.type === "sent") {
      // 收到消息后重新进入「干活中」
      this.settled = false;
      return;
    }
    if (msg.type === "bye") {
      this._wake({ type: "bye" });
      return;
    }
    if (msg.type === "error") {
      this.pending.push({ type: "error", text: msg.message });
      this._wake({ type: "error", message: msg.message });
    }
  }

  _wake(evt) {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w(evt);
  }

  _write(obj) {
    if (!this.alive) throw new Error("strix 会话未运行");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** 等待下一个事件（新输出 / 状态 / 退出），带超时 */
  _nextEvent(timeoutMs) {
    if (this.pending.length) return Promise.resolve({ type: "pending" });
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
      this.waiters.push((e) => {
        clearTimeout(t);
        resolve(e);
      });
    });
  }

  /**
   * 发一条用户消息，并**收集到本轮结束为止的所有输出**。
   *
   * 「结束」的判定：agent 转入 waiting（park 等人）且没有新的正文在涌出。
   * 这是 strix 自己的语义 —— respond_to_user 交付答复并 park，两者是同一个动作，
   * 所以 waiting 就等于「这轮说完了」。
   *
   * @returns {Promise<{text:string, progress:string[], replies:string[], costUsd:number|null}>}
   */
  async send(text, { maxMs = TURN_HARD_MS } = {}) {
    // 【懒启动】还没起来但有登记配置 → 用这第一句话作为任务把它拉起来。
    // 这句话会进 strix 的指令/会话历史，之后 --resume 才有东西可恢复。
    if (!this.alive && this.pendingBoot) {
      const cfg = this.pendingBoot;
      this.pendingBoot = null;
      const isResume = !!cfg.resume;
      // 记住用户起的名字（显示用），落盘名由 start() 转 slug
      this.label = cfg.label ?? cfg.sessionName ?? null;
      // 【关键】只有「恢复旧会话」才允许把 runName 交给 start() 当 --resume。
      // 新建会话时 runName 必须保持 null —— 否则 start() 的 `if (this.runName)`
      // 会走 --resume 分支，而那时它还没被赋值到底（实测拼出空的 `--resume`，
      // 然后被 strix 的 argparse 判为「参数不合法」）。
      this.runName = isResume
        ? (this.runName ?? cfg.sessionName ?? null)
        : null;
      await this.start({
        sessionName: cfg.sessionName ?? null,
        targets: cfg.targets ?? [],
        mode: cfg.mode ?? "quick",
        budget: cfg.budget ?? null,
        turns: cfg.turns ?? null,
        workspace: cfg.workspace ?? null,
        instruction: String(text),
      });
      // 新建时这句话已作为首轮指令交给 strix；恢复时它由 resume_instruction 注入。
      // 两种都无需再 send 一次，直接收本轮输出。
      return this._collectTurn({ maxMs });
    }

    this.settled = false;
    this._write({ op: "send", text: String(text) });
    return this._collectTurn({ maxMs });
  }

  /**
   * 收集「本轮」的输出，直到 agent 收工（root 不再是 running）。
   *
   * 抽出来是因为有两条入口都要用它：正常 send（先注入消息）和懒启动（启动时
   * 已把指令交给 strix，只需收结果）。两边都靠 strix 自己的语义判断收工 ——
   * 交付答复（respond_to_user）与让出控制权是同一个动作，所以 park 即本轮完。
   *
   * @param {number} maxMs 本轮上限
   */
  async _collectTurn({ maxMs = TURN_HARD_MS } = {}) {
    const progress = [];
    const replies = [];
    const collect = (items) => {
      for (const it of items) {
        if (it.kind === "reply") replies.push(it.text);
        else if (it.text) progress.push(it.text);
      }
    };
    const leftover = this.pending;
    this.pending = [];
    collect(leftover);

    const deadline = Date.now() + maxMs;
    let idleSince = Date.now();
    let lastStatusAt = 0;
    const pollEveryMs = 6000;
    // 【必须等它真的跑起来过】strix 的 root 在启动时/刚 park 时状态是 waiting；
    // 一上来看到 waiting 就当作「本轮结束」，会在 agent 还没被唤醒时就空手返回
    // —— 实测第一轮收到空输出、而回答被挤到了下一轮才冒出来。
    let seenRunning = false;

    // worker 会**主动推**输出（它的 stdout_loop），所以这里只需循环读 +
    // 周期查状态。等「root 不再是 running」且没有新输出在涌，就算本轮完了。
    while (Date.now() < deadline) {
      const evt = await this._nextEvent(1000);

      if (evt.type === "pending" || evt.type === "say") {
        const items = this.pending;
        this.pending = [];
        collect(items);
        idleSince = Date.now();
        continue;
      }
      if (evt.type === "error") {
        replies.push(`（strix 报错：${evt.message}）`);
        break;
      }
      if (evt.type === "exit" || evt.type === "bye") {
        this.dead = true;
        break;
      }
      if (evt.type === "status") {
        if (this.busy) seenRunning = true;
        // 只有「确实跑起来过」之后的收工才算本轮结束
        if (seenRunning && !this.busy) {
          // 给 park 前最后吐出的答复留个小窗口
          await new Promise((r) => setTimeout(r, 2000));
          const items = this.pending;
          this.pending = [];
          collect(items);
          break;
        }
        continue;
      }

      // 超时：定期查一次状态（判断是不是已经收工了）
      const now = Date.now();
      if (now - lastStatusAt >= pollEveryMs) {
        lastStatusAt = now;
        try {
          this._write({ op: "status" });
        } catch {
          break;
        }
      }

      // 兜底：长时间静默（agent 在跑长命令）且已有内容 → 先把已有的回给用户
      if (now - idleSince > IDLE_GRACE_MS && (replies.length || progress.length)) {
        break;
      }
      // 兜底二：一直没跑起来也没任何输出（消息没被消费）——别干等到硬超时，
      // 给上层一句说明，让人知道该去查状态而不是以为还在跑。
      if (!seenRunning && now - idleSince > 180_000) {
        if (!replies.length && !progress.length) {
          replies.push("（strix 没回应：消息未被消费。可用 /strix status 看状态，或 /pi2x 退回后重试）");
        }
        break;
      }
    }

    const rest = this.pending;
    this.pending = [];
    collect(rest);

    let costUsd = null;
    try {
      const st = await this.status();
      costUsd = st?.cost_usd ?? null;
    } catch {
      /* 取不到就算了 */
    }

    const body = replies.length ? replies.join("\n\n") : progress.join("\n\n");
    return { text: body.trim(), progress, replies, costUsd };
  }

  async status(timeoutMs = 8000) {
    if (!this.alive) return null;
    const p = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      const w = (e) => {
        if (e.type === "status") {
          clearTimeout(t);
          resolve(e.status);
        }
      };
      this.waiters.push(w);
    });
    try {
      this._write({ op: "status" });
    } catch {
      return null;
    }
    return p;
  }

  /** 立刻回传当前积压（不等待） */
  drainNow() {
    const items = this.pending;
    this.pending = [];
    return items;
  }

  async stop() {
    try {
      if (this.alive) {
        this._write({ op: "quit" });
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch {
      /* ignore */
    }
    try {
      this.rl?.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.child = null;
    this.dead = true;
  }

  /** 进程死了就按原 run 恢复（历史在 agents.db 里，不会丢） */
  async revive(opts = {}) {
    if (this.alive) return;
    this.runName = this.runName ?? this.resolvedRunName;
    if (this.runName) {
      await this.start({ ...opts, instruction: opts.instruction ?? "" });
      return;
    }
    await this.start(opts);
  }
}

// ---------- 全局注册表（按用户隔离） ----------

/** userId → StrixSession */
const pool = new Map();

function keyOf(userId, chatKey) {
  return `${chatKey}|${userId}`;
}

/**
 * 取（或建）某个会话的 strix 实例。
 * @param {{userId:string, chatKey:string, runName?:string|null}} opts
 */
export function getStrixSession({ userId, chatKey }) {
  const k = keyOf(userId, chatKey);
  let s = pool.get(k);
  if (!s) {
    s = new StrixSession({ userId, chatKey });
    pool.set(k, s);
  }
  return s;
}

/** 该会话是否已在 strix 框架（有活的实例） */
export function isOnStrix(userId, chatKey) {
  const s = pool.get(keyOf(userId, chatKey));
  return !!s && s.alive;
}

/** 当前实例（没有则 null） */
export function peekStrixSession(userId, chatKey) {
  return pool.get(keyOf(userId, chatKey)) ?? null;
}

/** 退出 strix：停掉该会话的实例 */
export async function dropStrixSession(userId, chatKey) {
  const k = keyOf(userId, chatKey);
  const s = pool.get(k);
  if (!s) return false;
  await s.stop();
  pool.delete(k);
  return true;
}

/** 收尾所有实例（bridge 退出时调用） */
export async function disposeAllStrix() {
  const all = [...pool.values()];
  pool.clear();
  await Promise.all(all.map((s) => s.stop().catch(() => {})));
}

/**
 * 清扫残留的 strix worker 进程（bridge 启动时调用）。
 *
 * 【为什么需要】worker 是独立子进程，bridge 被 kill -9 / OOM 时不会连带退掉，
 * 那些 worker 就带着 strix agent 和 headless Chrome 白跑（烧钱、占会话目录）。
 * 启动瞬间不可能存在「属于本进程」的 worker，所以此刻扫到的一律是孤儿。
 *
 * 只杀命令行里同时含 pi2x_worker.py 与 strix/scripts 的进程 ——
 * 避免误伤用户手工跑的 `strix-cli.mjs scan`（那是另一个用途，不该被清）。
 *
 * @returns {number} 杀掉的进程数
 */
export function sweepStrixOrphans() {
  let killed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (pid === process.pid) continue;
    let cmd = "";
    let ppid = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      ppid = st.slice(st.lastIndexOf(")") + 2).split(" ")[1];
    } catch {
      continue;
    }
    if (!cmd.includes("pi2x_worker.py")) continue;
    // 只清真正的孤儿（ppid=1）。若父进程仍活着，说明它由别的实例管着，不动。
    if (ppid !== "1") continue;
    try {
      process.kill(pid, "SIGKILL");
      killed++;
      logSx.warn(`已清理孤儿 strix worker pid=${pid}`);
    } catch {
      /* 已经退了 */
    }
  }
  return killed;
}

/** 该用户上次用过的 strix 会话名（仅供提示；会话已删则返回 null） */
export function lastSessionOf(userId) {
  const all = readSessions();
  const rec = all[String(userId)];
  if (!rec?.runName) return null;
  // 会话目录已被清理（手工删/磁盘清理）就不提了，否则会指向不存在的东西
  if (!fs.existsSync(path.join(RUNS_DIR, rec.runName))) return null;
  return rec;
}

/** 按 run 名找 run 目录（给 report 用） */
export function runDirOf(runName) {
  return path.join(RUNS_DIR, String(runName));
}

/**
 * strix 引擎是否就绪：venv 在、补丁已应用、worker 脚本存在。
 * 在**启动/切换**时查（不是每次消息），避免每条消息都 spawn 一个子进程。
 */
export function isStrixToolReady() {
  try {
    if (!fs.existsSync(WORKER) || !fs.existsSync(RUNNER)) return false;
    const py = path.join(STRIX_DIR, "venv", "bin", "python");
    if (!fs.existsSync(py)) return false;
    const strixBin = path.join(STRIX_DIR, "venv", "bin", "strix");
    if (!fs.existsSync(strixBin)) return false;
    return true;
  } catch {
    return false;
  }
}

/** 读某次 run 的产物摘要 */
export function readRunSummary(runName) {
  const dir = runDirOf(runName);
  const out = { runName, exists: fs.existsSync(dir) };
  try {
    out.meta = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  } catch {
    out.meta = null;
  }
  const report = path.join(dir, "penetration_test_report.md");
  if (fs.existsSync(report)) {
    try {
      out.report = fs.readFileSync(report, "utf8");
    } catch {
      out.report = null;
    }
  }
  return out;
}

export { StrixSession, MAX_CHUNK, IDLE_GRACE_MS };
