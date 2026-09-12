/**
 * PI2X Agent 管理 — 以 pi SDK 为框架，环境完全隔离
 *
 * 隔离策略（不污染其他 pi agent 的环境）：
 *  - 独立 agentDir（D:\PI2X\agent-dir），不读写 ~/.pi/agent
 *  - noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles：
 *    不加载用户全局与任意项目的扩展、skills、提示词、AGENTS.md
 *  - additionalSkillPaths：只加载本项目 prompt/skills 下的 bot skills
 *  - session 文件：显式路径 D:\PI2X\sessions\{chatKey}.jsonl
 *  - customTools：bot 专属工具，仅本会话可见
 */
import {
  createAgentSession,
  createFindTool,
  createGrepTool,
  createLsTool,
  DefaultResourceLoader,
  defineTool,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { QQBridge } from "./qqbridge.mjs";
import { pSystemAgent, pSessionContext, pRiskNote, pTool, loadPrompt } from "./prompts.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assessRequest } from "./risk-review.mjs";
import { statusLines as ccUsageStatusLines } from "./ccusage.mjs";

import { ROOT, config, AGENT_DIR, WORKSPACE, SESSIONS_DIR, SKILLS_DIR, saveConfig } from "./config.mjs";
import { detectToolLeak } from "./text.mjs";
import { winHost, winActiveHost } from "./winhost.mjs";
import { TurnAssembler } from "./agent/turn-assembler.mjs";
import { chatKeyOf, sessionKeyOf, pickSessionEntry } from "./agent/chat-key.mjs";
import { makeSettingsManager } from "./agent/settings.mjs";
import { memorySourceOf } from "./memory-source.mjs";
import { checkGrant, checkRevoke, PRESET_LEVEL as PRESET_LEVEL_TABLE, levelOf as opLevelOf } from "./op-policy.mjs";
import { runWithTurnCtx, getTurnCtx, patchTurnCtx, deleteTurnCtxField } from "./turn-context.mjs";
import * as CP from "./agent/compact-policy.mjs";
import { buildTools } from "./tools/index.mjs";
import { createModelRuntime, resolveModel, OMNIROUTE_MODELS } from "./model-config.mjs";
import { log, createLogger, withTurn } from "./log.mjs";

/* 各子系统日志器（scope 决定日志里的 [xxx] 标签，取代原先手写的 "[xxx] " 前缀） */
const logPi = createLogger("pi");
const logBrowser = createLogger("browser");
const logSkills = createLogger("skills");
const logSub = createLogger("subagent");
const logNapcat = createLogger("napcat");
const logRisk = createLogger("risk");
const logSteer = createLogger("steer");
const logMemory = createLogger("memory");
const logCompact = createLogger("compact");
const logLeak = createLogger("tool-leak");

// 向后兼容导出（外部脚本曾从本模块 import 这些符号）
export { AGENT_DIR, WORKSPACE, SESSIONS_DIR, detectToolLeak, winActiveHost };

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(AGENT_DIR, { recursive: true });

class PiAgent {
  /** 命令别名（/mem、/memmory → memory 等） */
  static ALIASES = { mem: "memory", memmory: "memory", mems: "memory", st: "status", r: "restart" };

  /**
   * 内置命令注册表（仅管理员，统一由 handleCommand 鉴权）。
   * 【新增命令】只需在此添加一项 { name, desc, usage?, run(self, ctx, rest) }，/help 自动生成。
   */
  static BUILTIN = {
    help: {
      desc: "本帮助",
      usage: "",
      run: (self) => [
        "可用命令（仅管理员）：",
        "  $ 命令     执行 Linux Bash（如：$ df -h）",
        "  > 命令     执行 Windows Shell（如：> tasklist）",
        ...Object.entries(PiAgent.BUILTIN).map(([n, e]) => `  /${n}      ${e.desc}`),
      ].join("\n"),
    },
    status: {
      desc: "系统状态",
      usage: "",
      run: async (self, ctx) => {
        const stats = self.memory?.stats();
        const botQQ = config.napcat?.qqAccount ?? "?";
        const lines = [
          `PI2X 在线 · ${botQQ}`,
          `模型 ${self.model?.id ?? "?"}`,
          `记忆 ${stats?.total ?? 0} 条 · 全局 ${stats?.globals ?? 0}`,
          `会话 ${self.sessions.size} 活跃`,
          ...(await self._statusContextUsage(ctx)),
        ];
        // Command Code 号池用量 + 缓存命中率（取不到就不显示，不阻塞 /status）
        try {
          const cc = await ccUsageStatusLines();
          if (cc) { lines.push(""); lines.push(...cc.split("\n")); }
        } catch (e) {
          lines.push(`CC 号池 取数异常：${String(e?.message ?? e).slice(0, 60)}`);
        }
        return lines.join("\n");
      },
    },
    model: {
      desc: "查看/切换模型（/model 编号）",
      usage: "[编号|别名]",
      run: async (self, ctx, rest) => {
        // 自动生成菜单：omniroute/*（网关模型）+ deepseek/*（直连模型）
        const buildMenu = () => {
          const arr = [];
          for (const m of self._omModels ?? []) arr.push({ id: `omniroute/${m.id}`, label: `omniroute/${m.id}` });
          const ds = (self.modelRuntime.getModels?.() ?? []).filter((m) => m.provider === "deepseek").map((m) => m.id).sort();
          for (const id of ds) arr.push({ id: `deepseek/${id}`, label: `deepseek/${id}` });
          const seen = new Set();
          return arr.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
        };
        const menu = buildMenu();
        if (!rest.length) {
          const cur = self.model ? `${self.model.provider}/${self.model.id}` : "?";
          const lines = [`当前模型: ${cur}`, "切换: /model <编号>", ""];
          menu.forEach((it, i) => lines.push(`[${i}] ${it.id}`));
          return lines.join("\n");
        }
        const t = String(rest[0]);
        const pick = async (cliModel) => {
          const rr = resolveCliModel({ cliModel, modelRuntime: self.modelRuntime });
          return rr.error ? null : rr.model;
        };
        let cliModel = null;
        if (/^\d+$/.test(t)) {
          const it = menu[Number(t)];
          if (!it) return `编号 ${t} 不存在，输入 /model 查看列表。`;
          cliModel = it.id;
        } else {
          const low = t.toLowerCase();
          // deepseek 硬编码真实默认模型（config.pi.model 可能被 /model 持久化污染，不能依赖它）
          if (low === "deepseek" || low === "ds") cliModel = "deepseek/deepseek-v4-flash-vision-exp";
          else if (low === "free" || low === "auto") cliModel = "omniroute/free";
          else if (low === "flash" || low === "deepseek-flash" || low === "ds-flash") cliModel = "omniroute/deepseek-flash";
          else cliModel = t.includes("/") ? t : `omniroute/${t}`;
        }
        const m = await pick(cliModel);
        if (!m) return `模型解析失败(${cliModel})，输入 /model 查看。`;
        // 更新本对象（新会话）
        self.model = m;
        // 更新所有活跃会话（persist:false 不落盘）
        let n = 0;
        for (const [, entry] of self.sessions) {
          try { await entry.session.setModel?.(m, { persist: false }); n++; } catch (e) { /* 单会话失败不阻塞 */ }
        }
        // 持久化到 config.json（重启后仍生效）
        let saved = "";
        try {
          saveConfig((cfg) => {
            cfg.pi = cfg.pi ?? {};
            cfg.pi.model = cliModel;
            return cfg;
          });
          saved = "· 已持久化（重启保留）";
        } catch (e) { saved = "· 持久化失败（仅本次运行）"; }
        return `已切换模型: ${m.provider}/${m.id} · 更新 ${n} 个活跃会话 ${saved}`;
      },
    },
    memory: {
      desc: "记忆查询/清理（/mem [search 词|list|delete id|clear|词]）",
      usage: "[search <词>] [list [n]] [delete <id>] [clear] 或直接 /mem <词>",
      run: async (self, ctx, rest) => {
        const m = self.memory;
        if (!m) return "（记忆系统未启用）";
        const fmt = (rows, title) => {
          if (!rows.length) return `${title}：无匹配记录`;
          const lines = rows.map((r) => {
            const ago = (() => {
              const diff = Date.now() - r.ts;
              const m = Math.floor(diff / 60000);
              if (m < 1) return "刚刚";
              if (m < 60) return `${m}分钟前`;
              const h = Math.floor(m / 60);
              if (h < 24) return `${h}小时前`;
              return `${Math.floor(h / 24)}天前`;
            })();
            return `- [${r.type} · ${ago}] ${r.content}${r.sensitive ? " 🔒" : ""}`;
          });
          return `${title} ${rows.length} 条：\n` + lines.join("\n");
        };
        if (!rest.length) {
          const s = m.stats();
          const es = m.embedderState?.() ?? {};
          const embLine = s.embOk >= s.total
            ? `向量 ${s.embOk}/${s.total} · 模型 ${es.model ?? "?"}(${es.dim ?? "?"}维)`
            : `向量 ${s.embOk}/${s.total} ⚠️ 未就绪(${es.error ?? "embedding 不可用，已降级关键词检索"})`;
          return [
            `事实 ${s.total} 条（pinned ${s.pinned} · sensitive ${s.sensitive}）`,
            `类型: ${s.byType.map((t) => `${t.type}=${t.c}`).join(" ") || "无"}`,
            embLine,
            `收割 ${s.harvest.count} 次 · 全局常驻 ${s.globals} 条`,
            `子命令: /mem search <词> · /mem list · /mem delete <id> · /mem clear · /mem <词>`,
          ].join("\n");
        }
        const sub = String(rest[0]).toLowerCase();
        if (sub === "list") {
          return fmt(m.list({ limit: Math.min(Number(rest[1] ?? 20), 100) }), "最近记忆");
        }
        if (sub === "add" || sub === "remember") {
          const content = rest.slice(1).join(" ").trim();
          if (!content) return "用法: /mem add <内容>（永久记录，不淘汰）";
          const source = memorySourceOf(ctx) ?? `private:${ctx.userId}`;
          const r = await m.remember({ content, source, pinned: true });
          return r.ok
            ? `已永久记住${r.degraded ? "（⚠️ 向量未就绪，本次以关键词模式存入）" : ""}：${content.slice(0, 120)}`
            : `写入失败：${r.error ?? "未知"}`;
        }
        if (sub === "del" || sub === "delete") {
          const n = m.deleteById(String(rest[1] ?? ""));
          return n ? `已删除 ${n} 条` : `未找到 id=${rest[1] ?? ""}`;
        }
        if (sub === "clear" || sub === "purge") {
          const r = m.purgeDirty();
          return `已清除脏数据：孤儿记忆 ${r.facts} 条、空收割日志 ${r.harvest} 条。有效记忆与权限未受影响。`;
        }
        const kw = sub === "search" ? rest.slice(1).join(" ") : rest.join(" ");
        const rows = await m.search({ keyword: kw, chatType: ctx.chatType, limit: 10 });
        return fmt(rows, `搜索「${kw}」`);
      },
    },
    perms: {
      desc: "查看用户权限（/perms QQ号）",
      usage: "[QQ号]",
      run: (self, ctx, rest) => {
        const target = (rest[0] ?? ctx.userId).trim();
        const p = self.white.list(String(target));
        return `${target}: ${p.length ? p.join(", ") : "dialog（最低权限）"}`;
      },
    },
    whoami: {
      desc: "当前会话信息（加参数查看权限明细，如 /whoami 1）",
      usage: "[- 任意参数展开权限明细]",
      run: (self, ctx, rest) => {
        const base = `会话: ${ctx.chatType === "group" ? "群聊" : "私聊"} · 你的 QQ: ${ctx.userId} · 权限组: ${self.white.presetOf(ctx.userId)}`;
        if (rest && rest.length > 0) return base + `\n权限明细: ${self.white.list(ctx.userId).join(", ") || "（无）"}`;
        return base;
      },
    },
    cred: {
      desc: "凭据管理（/cred [list|get <域名>|del <域名>]）— 仅 admin；解密不在此显示明文",
      usage: "[list] [get <域名>] [del <域名>]",
      run: async (self, ctx, rest) => {
        if (!self.white.perms(ctx.userId).has("files:full")) return "越权：cred 仅系统管理员可用。";
        const sub = String(rest[0] || "list").toLowerCase();
        const { createCredentialStore } = await import("./credentials.mjs");
        const cs = createCredentialStore();
        try {
          if (sub === "list") {
            const rows = cs.list();
            if (!rows.length) return "（无凭据）";
            return "凭据列表：\n" + rows.map((r) => `- ${r.domain}${r.username ? ` (${r.username})` : ""}${r.hasPass ? " [密码]" : ""}${r.hasToken ? " [token]" : ""}`).join("\n");
          }
          if (sub === "get" || sub === "lookup") {
            const domain = String(rest[1] ?? "");
            if (!domain) return "用法: /cred get <域名>";
            const r = cs.get(domain);
            return r.ok ? `${r.domain}: 用户=${r.username || "-"} 密码=${r.password ? "已存" : "-"} token=${r.token ? "已存" : "-"}` : r.text;
          }
          if (sub === "del" || sub === "delete" || sub === "remove") {
            const domain = String(rest[1] ?? "");
            if (!domain) return "用法: /cred del <域名>";
            const n = cs.remove(domain);
            return n ? `已删除凭据 ${domain}` : `未找到 ${domain}`;
          }
          return "用法: /cred [list|get <域名>|del <域名>]";
        } finally {
          cs.close();
        }
      },
    },
    restart: {
      desc: "重启整个服务",
      usage: "",
      run: (self, ctx) => {
        // 先让回复发出，再重启整个 bridge 服务（独立脚本：pkill + nohup 拉起）
        const uid = String(ctx?.userId ?? "");
        const ctype = ctx?.chatType === "group" ? "group" : "private";
        const tid = String(ctx?.chatType === "group" ? ctx?.targetId : ctx?.userId ?? "");
        setTimeout(async () => {
          try {
            const { spawn } = await import("node:child_process");
            const script = path.join(ROOT, "scripts", "restart-pi2x.sh");
            const env = { ...process.env, PI2X_RESTART_UID: uid, PI2X_RESTART_CHAT: ctype, PI2X_RESTART_TARGET: tid };
            spawn("bash", [script], { detached: true, stdio: "ignore", env }).unref();
          } catch {}
        }, 300);
        return "正在重启服务…";
      },
    },
    stop: {
      desc: "中止当前正在运行的任务（含 subagent）",
      usage: "",
      run: async (self) => {
        let n = 0;
        for (const [, entry] of self.sessions) {
          try { await entry.asm.cancelAll("（已中止）"); n++; } catch {}
        }
        n += await self._stopSubs(); // 中止 subagent（Windows pi RPC + Linux 子会话）
        return n ? `已中止 ${n} 个会话/子代理中正在运行的任务。` : "（当前无任务运行）";
      },
    },
    op: {
      desc: "授予权限预设（/op QQ号 预设）",
      usage: "<QQ号> <friend|operator|admin>",
      run: async (self, ctx, rest) => {
        const r = await self._opUser(ctx.userId, String(rest[0] ?? ""), String(rest[1] ?? ""));
        return r.text;
      },
    },
    deop: {
      desc: "撤销权限（/deop QQ号）",
      usage: "<QQ号>",
      run: async (self, ctx, rest) => {
        const r = await self._deopUser(ctx.userId, String(rest[0] ?? ""));
        return r.text;
      },
    },
  };

  /** 预设等级表（防提权比较用） */
  /** 预设等级表 —— 唯一实现在 lib/op-policy.mjs（与 qq-cli 共用，避免两侧漂移） */
  static PRESET_LEVEL = PRESET_LEVEL_TABLE;

  _saveWhitelist(mutate) {
    const file = path.join(ROOT, "whitelist.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.users ??= {};
    mutate(raw.users);
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    this.white.load(true); // 强制重载，立即生效
  }

  /**
   * 授予权限（/op 命令与 qq-cli op 共用同一策略）。
   *
   * 规则见 lib/op-policy.mjs —— 与 qq-cli 那侧**同一份实现**，避免两侧漂移出提权缺口。
   * 拒绝文案刻意不带等级数字：否则任何群成员都能靠试错探出谁有权限、权限多高。
   */
  async _opUser(caller, target, preset) {
    if (!target) return { ok: false, text: "用法: /op <QQ号> <friend|operator|admin>" };
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "whitelist.json"), "utf8"));
    const r = checkGrant({
      callerPreset: raw.users?.[caller],
      targetPreset: raw.users?.[target],
      preset: String(preset ?? ""),
    });
    if (!r.ok) return { ok: false, text: r.text };
    this._saveWhitelist((users) => { users[target] = preset; });
    if (this.memory) this.memory.setUserPerm(target, preset, caller);
    return { ok: true, text: `已授予 ${target} 预设「${preset}」（热加载生效）` };
  }

  /** 撤销权限（/deop 命令与 qq-cli deop 共用同一策略） */
  async _deopUser(caller, target) {
    if (!target) return { ok: false, text: "用法: /deop <QQ号>" };
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "whitelist.json"), "utf8"));
    if (!(target in (raw.users ?? {}))) {
      // 措辞不说「该用户无授权」—— 那等于确认某个 QQ 在不在白名单里
      return { ok: false, text: "该用户当前无需撤销的权限。" };
    }
    const r = checkRevoke({
      callerPreset: raw.users?.[caller],
      targetPreset: raw.users?.[target],
      isTargetSelf: String(caller) === String(target),
    });
    if (!r.ok) return { ok: false, text: r.text };
    this._saveWhitelist((users) => { delete users[target]; });
    if (this.memory) this.memory.setUserPerm(target, "dialog", caller);
    return { ok: true, text: `已撤销 ${target} 的授权（恢复 dialog 最低权限）` };
  }

  constructor({ bridge }) {
    this.bridge = bridge;          // QQBridge 实例（供主动发消息工具）
    this.modelRuntime = null;
    this.loader = null;            // 统一 ResourceLoader（无角色分级）
    this.model = undefined;        // 按 config.pi.model 解析
    this.sessions = new Map();     // chatKey -> { session, tail: Promise, context }
    this._pending = new Map();     // chatKey -> Promise（防止并发重复创建会话）
    this.ctx = { chatType: null, targetId: null, selfId: null, userName: null, userId: null, chatKey: null };
    this.white = null;             // Whitelist 实例
    this.memory = null;            // MemoryStore 实例
    this.sandboxRoot = null;       // 沙盒根目录
    this.pendingRed = null;        // RED 高风险接口待确认（{api, params, uid, ts}）
    this._groupNameCache = new Map(); // 群号 -> Promise<群名>
    this._groupMembers = new Map();   // 群号 -> Map<QQ, 昵称>（消息流增量维护，供 @解析与上下文注入）
    this._subAbort = null;         // 当前 subagent 任务取消器（AbortController）
    this._activeSubSessions = new Set(); // 运行中的 Linux 子会话（可中止）
    this._subTasks = new Map();    // taskId -> 异步子任务状态（纯异步：启动即返回 taskId，可 steer/取结果）
  }

  async init(opts = {}) {
    const wlFile = opts.whitelistFile ?? path.join(ROOT, "whitelist.json");
    const { Whitelist } = await import("./whitelist.mjs");
    this.white = new Whitelist(wlFile);

    // 启动清扫：子代理的一次性会话文件在正常结束时会被 unlink，
    // 但进程被 kill（重启/OOM）时子代理正在跑 → 那个文件就永久成了孤儿。
    // 启动瞬间不可能有子代理在跑，所以这里看到的全是孤儿，可直接删。
    try {
      const { sweepOrphans } = await import("./sessions-maint.mjs");
      const r = sweepOrphans(SESSIONS_DIR);
      if (r.removed.length) {
        log.info(`[boot] 清理 ${r.removed.length} 个子代理孤儿会话文件，释放 ${(r.freed / 1024 / 1024).toFixed(2)}MB`);
        for (const f of r.removed) log.debug(`  已删 ${f.name}（${(f.bytes / 1024).toFixed(0)}KB）`);
      }
    } catch (e) {
      log.warn(`[boot] 孤儿会话清扫失败：${e?.message}`);
    }

    if (config.memory?.enabled !== false) {
      const { createMemoryStore } = await import("./memory.mjs");
      const dbPath = config.memory?.dbPath ?? path.join(WORKSPACE, "memories", "memory.db");
      const sc = config.memory?.scoring ?? {};
      this.memory = createMemoryStore({
        dbPath,
        modelDir: config.memory?.modelDir,
        harvestIntervalMs: config.memory.harvestIntervalMin * 60000,
        maxFacts: config.memory.maxFacts,
        injectChars: config.memory.injectChars,
        harvestModel: config.memory?.harvestModel ?? "deepseek-chat",
        embedModel: config.memory?.embedModel,
        embedPrefixQuery: config.memory?.embedPrefixQuery ?? "",
        embedPrefixPassage: config.memory?.embedPrefixPassage ?? "",
        center: sc.center,
        useCsls: sc.useCsls,
        cslsK: sc.cslsK,
        gateSim: sc.gateSim,
        mergeSim: sc.mergeSim,
        relatedSim: sc.relatedSim,
        recencyDecay: sc.recencyDecay,
        evictMode: sc.evictMode,
        autoSupersede: sc.autoSupersede,
        weights: sc.weights,
      });
    }
    this.sandboxRoot = path.resolve(config.memory?.sandboxDir ?? path.join(WORKSPACE, "..", "sandbox"));

    // 模型与 provider 装配：与安全模式共用同一份实现（lib/model-config.mjs），
    // 避免「两个入口各写一遍 provider 注册」导致配置漂移。
    this.modelRuntime = await createModelRuntime({ logger: logPi });
    this._omModels = OMNIROUTE_MODELS; // /model 菜单自动生成用
    // 确保 headless Chrome（CDP 9222）可用：供 browser_* 工具使用
    this._ensureChrome().catch((e) => logBrowser.warn(`chrome 自启异常: ${e?.message}`));
    // 模型解析必须在 loader 构建之后：自定义 provider 需先经 loader 注册完毕才解析得到
    this.loader = await this._buildLoader();
    const m = resolveModel(this.modelRuntime, { logger: logPi });
    if (m) {
      this.model = m;
      logPi.info(`使用模型: ${this.model.id}`);
    }
  }

  /** 统一系统提示（纯约束式：无角色扮演，仅行为规则与边界）——从 prompt/agent/system.md 读取 */
  _systemPrompt() {
    // 全局静态 system prompt：PI2X 约束（2X 视角由 before_agent_start 按用户动态注入、紧跟其后、不进历史）
    let base = pSystemAgent();
    // 显式注入 skills 列表（不依赖 pi 原生渲染时序，SKILL.md 放对目录即自动收录）：
    // 从每个 skill 目录的 SKILL.md 提取 name 与首段描述，模型按描述选用后以 read 读取全文执行。
    const lines = [];
    try {
      if (fs.existsSync(SKILLS_DIR)) {
        for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const file = path.join(SKILLS_DIR, e.name, "SKILL.md");
          if (!fs.existsSync(file)) continue;
          const raw = fs.readFileSync(file, "utf8").slice(0, 1200);
          const nameM = raw.match(/^name:\s*(.+)$/m);
          const descM = raw.match(/^description:\s*(.+)$/m);
          const name = (nameM ? nameM[1].trim() : e.name) || e.name;
          const desc = (descM ? descM[1].trim() : raw.replace(/^---[\s\S]*?---/, "").split(/\n+/).find((l) => l.trim()) || "");
          lines.push(`- ${name}：${desc}（用法见 ${path.join(SKILLS_DIR, e.name)}/SKILL.md，用 read 读取全文）`);
        }
      }
    } catch (err) {
      logSkills.warn(`注入失败: ${err?.message}`);
    }
    if (lines.length) base += "\n\n## 可用技能（skills）\n" + lines.join("\n");
    return base;
  }

  async _buildLoader() {
    // skill 经 pi 原生机制加载（additionalSkillPaths 指向 prompt/skills 下的子目录）；
    // 当前 qq-bot 的 SKILL.md 已并入 system.md 而删除，目录为空时返回空数组；后续添加新 skill 会被自动加载。
    const skillDirs = fs.existsSync(SKILLS_DIR)
      ? fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(SKILLS_DIR, e.name))
      : [];
    // 兼容：scripts/ 下 xxx/SKILL.md 的 skill 也加载（工具/脚本同目录放 scripts 的习惯）
    const scriptSkills = path.join(ROOT, "scripts");
    if (fs.existsSync(scriptSkills)) {
      for (const e of fs.readdirSync(scriptSkills, { withFileTypes: true })) {
        if (e.isDirectory() && fs.existsSync(path.join(scriptSkills, e.name, "SKILL.md"))) {
          skillDirs.push(path.join(scriptSkills, e.name));
        }
      }
    }
    // 公共 2X 基座已并入全局静态 system prompt（_systemPrompt）。
    // 记忆注入：通过 before_agent_start 把“当前请求的记忆”临时并入 system prompt（不进会话历史），
    // 历史只保留干净的 user/assistant/tool 消息。
    const me = this;
    const loader = new DefaultResourceLoader({
      cwd: WORKSPACE,
      agentDir: AGENT_DIR,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: skillDirs,
      systemPrompt: this._systemPrompt(),
      extensionFactories: [
        async (pi) => {
          // pi-web-access：web_search / fetch_content / 视频理解（零配置：keyless DuckDuckGo + fallback 链）
          try {
            const webPkg = "/root/.pi/agent/npm/node_modules/pi-web-access";
            const idx = path.join(webPkg, "index.ts");
            if (fs.existsSync(idx)) {
              const { createRequire } = await import("node:module");
              // 以 pi-coding-agent 为基解析 jiti
              const req = createRequire(path.join("/opt/pi2x/node_modules/@earendil-works/pi-coding-agent", "noop.cjs"));
              const jitiFactory = req("jiti");
              const jiti = (jitiFactory.default ?? jitiFactory)(path.join(webPkg, "loader.cjs"), {
                interopDefault: true,
                moduleCache: false,
              });
              const mod = jiti(idx);
              if (typeof mod?.default === "function") await mod.default(pi);
              logPi.info("pi-web-access 已加载（web_search/fetch_content）");
            }
          } catch (e) { logPi.warn(`pi-web-access 加载失败: ${e?.message}`); }
        },
        (pi) => {
          // before_agent_start：注入 2X 视角 + 记忆；同时（调试开关）dump 完整 LLM 上下文
          pi.on("before_agent_start", async (event, ctx) => {
            const me2 = me;
            // 1) 2X 视角：**统一人设**，一个文件对所有人生效
            //
            // 【为什么不再分 base / diff】原先拆成 2x-base.md（公共基座，所有人）+
            // 2x-diff-{admin,public}.md（按权限组二选一），再在代码里拼接。
            // 三层拼装带来的问题：改一句话要判断"该动哪个文件"，同一个意思容易在
            // 两个 diff 里各写一遍然后跑偏；而 base 与 diff 之间还会互相覆盖语气。
            // 现在合并为 prompt/context/2x.md 一个文件，人设的差异（如对管理员的称呼）
            // 直接写成人设内部的一句说明 —— 文件只有一个，读的人也只有一处。
            let add = "";
            try {
              const userId = (getTurnCtx() ?? me2?.ctx)?.userId;
              const persona = userId ? me2?._personaFor?.(userId) : null;
              if (persona?.promptFile) add += loadPrompt("context", persona.promptFile);
              // 权限白名单（私聊专用，此处为空串则不加）：
              // 同一私聊对象的权限稳定 → 放在 system 里不破坏前缀缓存。
              const tc0 = (getTurnCtx() ?? me2?.ctx) ?? {};
              if (tc0.permBlockSys) add += "\n\n" + tc0.permBlockSys;
            } catch (e) { /* 忽略 */ }
            // 调试：dump 调用 LLM 时的完整上下文（systemPrompt + 会话消息）
            if (process.env.PI2X_DUMP_LLM) {
              try {
                const allMsgs = [];
                if (event.systemPrompt) allMsgs.push({ role: "system", content: event.systemPrompt });
                if (add) allMsgs.push({ role: "system", content: add });
                // 从 sessionManager 读会话消息（用 compact-aware 的 buildSessionContext——只含压缩摘要+后续，非原始全量）
                try {
                  const sctx = ctx?.sessionManager?.buildSessionContext?.();
                  const msgs = sctx?.messages ?? [];
                  for (const m of msgs) {
                    const c = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
                    allMsgs.push({ role: String(m?.role ?? "?" + (m?.compacted ? "(压缩)" : "")), content: String(c).slice(0, 8000) });
                  }
                } catch {}
                const dir = path.join(ROOT, "tmp", "llm-requests");
                fs.mkdirSync(dir, { recursive: true });
                const ts = new Date().toISOString().replace(/[:.]/g, "-");
                const text = allMsgs
                  .map((m) => `===== ${m.role} =====\n${m.content.slice(0, 9000)}`)
                  .join("\n\n");
                fs.writeFileSync(path.join(dir, `req-${ts}.txt`), text, "utf8");
              } catch (e) { /* dump 失败不影响主流程 */ }
            }
            if (!add) return undefined;
            return { systemPrompt: event.systemPrompt + "\n\n" + add };
          });
        },
        // 每请求临时块（权限白名单 / 风险研判 / 记忆）—— 挂在报文最后一条消息的末尾
        //
        // 【为什么是这个钩子，而不是 system prompt 或 context 事件】（都有实测依据）
        //
        // 1) 为什么不放 system prompt：前缀缓存 = 「从第 0 个 token 起的最长公共前缀」，
        //    system 里任何位置一变，分叉点之后全部作废。而记忆检索结果每轮都在变，
        //    放 system 末尾 = 每轮都把整段历史缓存清空。
        //      实测：同一 system + 历史，动态块放 system 末尾 → 命中 29%；
        //            改挂消息末尾 → 命中 97%。
        //      生产佐证：连续两次调用 system 末尾的记忆块换了内容，命中从 99% 掉到 6%
        //            （只剩 system 头部那 ~2560 token 命中）。
        //
        // 2) 为什么不用 context 事件（transformContext）：实测它的改写会被写回会话状态，
        //    于是临时块照样落盘 —— 不满足「不进历史」。见 tmp/ctxhook*.mjs 的对照验证。
        //
        // 3) before_provider_request 在报文序列化之后、真正发请求之前触发，改的是线上报文，
        //    **不经过会话状态**。实测：payload 里有、会话文件里没有 → 既不持久化，也不碰缓存前缀。
        (pi) => {
          pi.on("before_provider_request", async (event) => {
            // ① 注入临时块
            try {
              const tc = (getTurnCtx() ?? me?.ctx) ?? {};
              // permBlockTail 只在群聊下有值（私聊的白名单已并入 system prompt）
              const blocks = [tc.permBlockTail, tc.riskNote, tc.memInjection].filter(Boolean);
              if (blocks.length) {
                const ok = appendTailBlock(event?.payload, blocks.join("\n\n"));
                if (!ok) logPi.warn("临时块注入失败（报文结构不符合预期）");
              }
            } catch (e) { logPi.warn(`临时块注入异常: ${e?.message}`); }
            // ②（可选）dump：放在注入之后，dump 出来的就是真正发出去的内容
            if (!process.env.PI2X_DUMP_LLM) return event?.payload;
            try {
              const dir = path.join(ROOT, "tmp", "llm-requests");
              fs.mkdirSync(dir, { recursive: true });
              const ts = new Date().toISOString().replace(/[:.]/g, "-");
              const p = path.join(dir, `req-${ts}.txt`);
              const payload = event?.payload;
              const src = Array.isArray(payload)
                ? payload.map((m) => `===== ${m?.role ?? "?"} =====\n` + String(m?.content ?? "")).join("\n\n")
                : JSON.stringify(payload, null, 2);
              fs.writeFileSync(p, src, "utf8");
            } catch (e) { /* dump 失败不影响主流程 */ }
            return event?.payload;
          });
        },
      ],
    });
    return loader.reload().then(() => loader);
  }

  _safeKey(chatKey) {
    return chatKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  _isStreaming(cm) {
    return cm?.session?.isStreaming ?? false;
  }

  /** 调用 Windows 上配置好的 pi（subagent，print 模式）——Windows 优先
   * @param {string} task
   * @param {number} timeoutSec
   * @param {AbortSignal} [outSignal] 外部中止信号（/stop） */
  async _runWinPi(task, timeoutSec = 240, outSignal) {
    const ws = config.winShell;
    if (!ws?.enabled || !ws?.token) throw new Error("winShell 未配置");
    const resp = await winHost.fetch("/pi/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ws.token}` },
      body: JSON.stringify({ task: String(task), timeout: timeoutSec, model: this.model?.id }),
      signal: outSignal,
      timeoutMs: (timeoutSec + 30) * 1000,
    });
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`win-pi HTTP ${resp.status}: ${d?.error ?? ""}`);
    const out = String(d?.stdout ?? "");
    if (!out && (d?.exitCode ?? 0) !== 0) throw new Error(`win-pi exit=${d?.exitCode} stderr=${String(d?.stderr ?? "").slice(0, 200)}`);
    return out || "（Windows pi 无输出）";
  }

  /** 纯异步：子任务后台运行，主 agent 可随时 steer / 取结果。
   * 安全：按发起者权限分级——仅全权用户（admin）的子代理可走 Windows；
   * 沙箱用户（operator）强制 Linux bwrap 沙箱（禁内置 bash/文件工具），防逃逸。 */
  async _startSubAsync(task, taskText, timeoutSec) {
    task.status = "running";
    const ownerPerms = task.ownerPerms ?? new Set();
    const canWin = ownerPerms.has("files:full") || ownerPerms.has("tools.windows_shell") || ownerPerms.has("tools.win_file_get");
    // Windows 优先（仅全权用户；沙箱用户跳过，强制 Linux 沙箱）
    if (canWin) {
      try {
        const tid = await this._startWinSubAsync(task, taskText, timeoutSec);
        if (tid) { task.type = "win"; return; }
      } catch (e) {
        logSub.warn(`Windows 不可用，Linux 回退: ${e?.message}`);
      }
    }
    // Linux 后台子 agent
    task.type = "linux";
    const cap = Math.min(Math.max(timeoutSec, 30), 600);
    const file = path.join(SESSIONS_DIR, `subtask-${task.id}-${Math.random().toString(36).slice(2, 7)}.jsonl`);
    let session;
    try {
      const opts = {
        cwd: WORKSPACE,
        agentDir: AGENT_DIR,
        resourceLoader: this.loader,
        sessionManager: SessionManager.open(file),
        settingsManager: makeSettingsManager(),
        modelRuntime: this.modelRuntime,
        model: this.model,
        customTools: [
          ...this._buildTools(new Set(), "subagent").filter((t) => t.name !== "run_task" && t.name !== "subagent_send" && t.name !== "subagent_result"),
          // subagent 专用：主动向主 agent 汇报（写入主 agent 会话，作为下一 turn 的 context asides）
          defineTool({
            name: "subagent_report",
            ...pTool("subagent_report"),
            parameters: Type.Object({ message: Type.String({ description: "要汇报/发给主 agent 的消息内容" }) }),
            execute: async (_id, params) => {
              const ms = task.mainSession;
              if (!ms) return { content: [{ type: "text", text: "（无可汇报的主 agent 会话）" }], details: {} };
              try {
                await ms.sendCustomMessage({ customType: "subagent-report", content: params.message, display: true }, { deliverAs: "nextTurn" });
                return { content: [{ type: "text", text: `已汇报给主 agent：${String(params.message).slice(0, 120)}` }], details: {} };
              } catch (e) {
                return { content: [{ type: "text", text: `汇报失败: ${e?.message}` }], details: {} };
              }
            },
          }),
        ],
      };
      // 沙箱用户（operator）的子代理：禁内置 read/bash/edit/write 全权工具，改用 bwrap 沙箱版本（防逃逸）
      if (ownerPerms.has("files") && !ownerPerms.has("files:full")) {
        opts.excludedToolNames = ["read", "bash", "edit", "write"];
        opts.customTools = [...this._sandboxFileTools(ownerPerms, task.ownerUserId ?? "?"), ...opts.customTools];
      }
      const { session: s } = await createAgentSession(opts);
      session = s;
      task.session = session;
      this._activeSubSessions.add(session); // /stop 可中止
      // 订阅增量输出
      task.unsub = session.subscribe((ev) => {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          task.reply += ev.assistantMessageEvent.delta ?? "";
        } else if (ev.type === "agent_settled") {
          task.status = "done";
        }
      });
      // 后台启动（不 await 完成），超时/中止由 sig 控制
      const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error("超时")), cap * 1000).unref?.());
      const abortP = task.sig ? new Promise((_, rej) => task.sig.addEventListener("abort", () => rej(new Error("已中止")), { once: true })) : null;
      session.prompt(taskText, { streamingBehavior: "followUp" })
        .then(() => { task.status = "done"; })
        .catch((e) => { task.status = task.sig?.aborted ? "aborted" : "failed"; task.error = e?.message || String(e); })
        .finally(() => {
          try { task.unsub?.(); } catch {}
          try { session.dispose(); } catch {}
          this._activeSubSessions.delete(session);
          try { fs.unlinkSync(file); } catch {}
        });
      Promise.race([timeoutP, abortP].filter(Boolean)).catch((e) => {
        if (task.status === "running") { task.status = task.sig?.aborted ? "aborted" : "failed"; task.error = e?.message || String(e); }
        try { session?.abort?.().catch(() => {}); } catch {}
      });
    } catch (e) {
      task.status = "failed";
      task.error = e?.message || String(e);
      try { session?.dispose(); } catch {}
      this._activeSubSessions.delete(session);
      // 会话创建失败也要删掉占位文件，否则会留下空文件（原先漏了这一步）
      try { fs.unlinkSync(file); } catch {}
    }
  }

  /** Windows 侧异步启动子任务。win-agent 若支持 taskId 维度可返回其 taskId；否则抛错。 */
  async _startWinSubAsync(task, taskText, timeoutSec) {
    const ws = config.winShell;
    if (!ws?.enabled || !ws?.token) throw new Error("winShell 未配置");
    const resp = await winHost.fetch("/pi/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ws.token}` },
      body: JSON.stringify({ task: String(taskText), timeout: Number(timeoutSec || 30), async: true, taskId: task.id, model: this.model?.id }),
    });
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`win-pi HTTP ${resp.status}: ${d?.error ?? ""}`);
    if (d?.async === false) throw new Error("win-agent 不支持异步任务");
    task.winTaskId = d?.taskId ?? task.id;
    return task.winTaskId;
  }

  /** 向子任务插话（steer）：Linux 用 session.steer；Windows 调 reach 的 /pi/steer */
  async _subSteer(task, message) {
    if (task.type === "linux" && task.session) {
      await task.session.steer(message);
      return;
    }
    if (task.type === "win" || task.winTaskId) {
      const ws = config.winShell;
      const resp = await winHost.fetch("/pi/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ws.token}` },
        body: JSON.stringify({ taskId: task.winTaskId ?? task.id, message }),
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(`win steer HTTP ${resp.status}: ${d?.error ?? ""}`);
      return;
    }
    throw new Error("子任务未处于可插话状态");
  }

  /** 创建独立子 agent 执行复杂任务（subagent）
   * 环境：优先 Windows pi（用户已配置专属工具）；Windows 不可达/失败 → 本机 Linux 子 agent 回退 */
  async _runSubAgent(task, timeoutSec = 240, outSignal) {
    const cap = Math.min(Math.max(timeoutSec, 30), 600);
    const file = path.join(SESSIONS_DIR, `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jsonl`);
    let session;
    try {
      const opts = {
        cwd: WORKSPACE,
        agentDir: AGENT_DIR,
        resourceLoader: this.loader,
        sessionManager: SessionManager.open(file),
        settingsManager: makeSettingsManager(),
        modelRuntime: this.modelRuntime,
        model: this.model,
        customTools: this._buildTools(new Set(), "subagent").filter((t) => t.name !== "run_task"),
      };
      // 沙箱用户（operator）：子代理同样禁内置文件工具 + bwrap 沙箱（防逃逸）
      const ownerId = this.ctx?.userId ?? "";
      const ownerPerms = this.white.perms(ownerId);
      if (ownerPerms.has("files") && !ownerPerms.has("files:full")) {
        opts.excludedToolNames = ["read", "bash", "edit", "write"];
        opts.customTools = [...this._sandboxFileTools(ownerPerms, ownerId || "?"), ...opts.customTools];
      }
      const { session: s } = await createAgentSession(opts);
      session = s;
      this._activeSubSessions.add(session); // 注册，/stop 可中止
      logSub.info(`启动任务(${cap}s): ${String(task).slice(0, 60)}`);
      let reply = "";
      const unsub = session.subscribe((ev) => {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          reply += ev.assistantMessageEvent.delta;
        }
      });
      const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error("超时")), cap * 1000).unref?.());
      const abortP = outSignal ? new Promise((_, rej) => outSignal.addEventListener("abort", () => rej(new Error("已中止")), { once: true })) : null;
      await Promise.race(abortP ? [session.prompt(task, { streamingBehavior: "followUp" }), timeoutP, abortP] : [session.prompt(task, { streamingBehavior: "followUp" }), timeoutP]);
      unsub();
      return reply || "（子任务无输出）";
    } finally {
      try { session?.dispose(); } catch {}
      this._activeSubSessions.delete(session);
      try { fs.unlinkSync(file); } catch {}
    }
  }

  /** 中止所有 subagent 任务（/stop）：Windows pi RPC abort + Linux 子会话 abort
   * @returns {number} 中止数量 */
  async _stopSubs() {
    let n = 0;
    if (this._subAbort && !this._subAbort.signal.aborted) {
      this._subAbort.abort();
      n++;
    }
    // Windows pi RPC 显式中止（让 win-agent 结束当前 prompt）
    const ws = config.winShell;
    if (ws?.enabled && ws?.token) {
      try {
        await winHost.fetch("/pi/abort", {
          method: "POST",
          headers: { Authorization: `Bearer ${ws.token}` },
          timeoutMs: 5000,
        }).catch(() => {});
      } catch {}
    }
    // 标记所有异步子任务为 aborted，并停止其会话
    for (const [tid, t] of this._subTasks) {
      if (t.status === "pending" || t.status === "running") {
        t.status = "aborted";
        try { t.sig?.abort?.(); } catch {}
        try { t.session?.abort?.().catch(() => {}); } catch {}
        n++;
      }
    }
    // Linux 子会话 abort
    for (const s of [...this._activeSubSessions]) {
      try { await s.abort().catch(() => {}); } catch {}
      n++;
    }
    this._activeSubSessions.clear();
    return n;
  }

  /** 判定沙盒根：files:full → WORKSPACE；files → 私有沙盒；否则 WORKSPACE */
  /** headless Chrome（CDP 9222）自启：供浏览器自动化 skill 使用（user-data-dir 持久登录态） */
  /**
   * 确保 headless Chrome 实例可用。
   *
   * 【两个实例，按使用者隔离凭据】
   *   9222 = 管理员实例，profile `browser-profile`（含 admin 登录态）
   *   9223 = 普通用户/operator 实例，profile `browser-profile-op`（全新，**不含** admin 凭据）
   *
   * 【为什么两个都要在这里常驻启动】
   * 原先只自启 9222。operator 在沙盒里自己跑 browser-cli 时，既找不到 Chrome 二进制
   * （沙盒是白名单挂载），也无法 detach 一个长驻进程（bwrap --die-with-parent）。
   * 现在由主进程统一把两个实例拉起来，沙盒内的 CLI 只需通过 CDP 连 localhost 使用。
   * 附带好处：profile 目录留在沙盒外，operator 改不到自己的浏览器凭据文件。
   *
   * @param {number} port 9222 | 9223
   */
  async _ensureChromeOne(port) {
    const { spawn } = await import("node:child_process");
    const fs2 = await import("node:fs");
    const findBin = () => {
      const base = "/root/.cache/ms-playwright";
      if (!fs2.existsSync(base)) return null;
      try {
        for (const d of fs2.readdirSync(base)) {
          const p = `${base}/${d}/chrome-linux-arm64/chrome`;
          const p2 = `${base}/${d}/headless_shell`;
          if (fs2.existsSync(p)) return p;
          if (fs2.existsSync(p2)) return p2;
        }
      } catch {
        return null;
      }
      return null;
    };
    const up = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
        return r.ok;
      } catch {
        return false;
      }
    };
    if (await up()) return true;
    const bin = findBin();
    if (!bin) {
      logBrowser.warn(`未找到 chrome 二进制（playwright 未下载），浏览器 skill 不可用（:${port}）`);
      return false;
    }
    const profile = port === 9222 ? "/opt/pi2x/browser-profile" : "/opt/pi2x/browser-profile-op";
    try {
      fs2.mkdirSync(profile, { recursive: true, mode: 0o700 });
    } catch {
      /* ignore */
    }
    // 清掉陈旧锁文件：上一个 Chrome 被 kill（重启/超时）时会留下 Singleton*，
    // 新实例可能因此拒绝启动 —— 表现为「端口迟迟不监听」，但手动删锁后立刻就好。
    // 只有在确认该端口没有实例在跑时才清（上面已 await up() 判过），安全。
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        fs2.rmSync(path.join(profile, f), { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      spawn(
        bin,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--remote-debugging-port=${port}`,
          "--user-data-dir=" + profile,
          "--window-size=1280,900",
          "--hide-scrollbars",
          "about:blank",
        ],
        { detached: true, stdio: "ignore" }
      ).unref();
      // 等它真的起来再返回，避免「刚启动就被调用」的竞态
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (await up()) {
          logBrowser.info(`headless Chrome 已启动（:${port}${port === 9223 ? " · operator 隔离实例" : ""}）`);
          return true;
        }
      }
      logBrowser.warn(`Chrome 启动后未就绪（:${port}）`);
      return false;
    } catch (e) {
      logBrowser.warn(`chrome 启动失败（:${port}）: ${e?.message}`);
      return false;
    }
  }

  /** 确保管理员与 operator 两个 Chrome 实例都可用（不阻塞主流程） */
  async _ensureChrome() {
    try {
      await this._ensureChromeOne(9222);
      await this._ensureChromeOne(9223);
    } catch (e) {
      logBrowser.warn(`Chrome 自启异常: ${e?.message}`);
    }
  }

  /** 创建独立子 agent 执行复杂任务（subagent）
   * 环境：优先 Windows pi（用户已配置专属工具）；Windows 不可达/失败 → 本机 Linux 子 agent 回退 */
  async _runSubAgent(task, timeoutSec = 240, outSignal) {
    const cap = Math.min(Math.max(timeoutSec, 30), 600);
    const file = path.join(SESSIONS_DIR, `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jsonl`);
    let session;
    try {
      const opts = {
        cwd: WORKSPACE,
        agentDir: AGENT_DIR,
        resourceLoader: this.loader,
        sessionManager: SessionManager.open(file),
        settingsManager: makeSettingsManager(),
        modelRuntime: this.modelRuntime,
        model: this.model,
        customTools: this._buildTools(new Set(), "subagent").filter((t) => t.name !== "run_task"),
      };
      // 沙箱用户（operator）：子代理同样禁内置文件工具 + bwrap 沙箱（防逃逸）
      const ownerId = this.ctx?.userId ?? "";
      const ownerPerms = this.white.perms(ownerId);
      if (ownerPerms.has("files") && !ownerPerms.has("files:full")) {
        opts.excludedToolNames = ["read", "bash", "edit", "write"];
        opts.customTools = [...this._sandboxFileTools(ownerPerms, ownerId || "?"), ...opts.customTools];
      }
      const { session: s } = await createAgentSession(opts);
      session = s;
      this._activeSubSessions.add(session); // 注册，/stop 可中止
      logSub.info(`启动任务(${cap}s): ${String(task).slice(0, 60)}`);
      let reply = "";
      const unsub = session.subscribe((ev) => {
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          reply += ev.assistantMessageEvent.delta;
        }
      });
      const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error("超时")), cap * 1000).unref?.());
      const abortP = outSignal ? new Promise((_, rej) => outSignal.addEventListener("abort", () => rej(new Error("已中止")), { once: true })) : null;
      await Promise.race(abortP ? [session.prompt(task, { streamingBehavior: "followUp" }), timeoutP, abortP] : [session.prompt(task, { streamingBehavior: "followUp" }), timeoutP]);
      unsub();
      return reply || "（子任务无输出）";
    } finally {
      try { session?.dispose(); } catch {}
      this._activeSubSessions.delete(session);
      try { fs.unlinkSync(file); } catch {}
    }
  }

  /** 中止所有 subagent 任务（/stop）：Windows pi RPC abort + Linux 子会话 abort
   * @returns {number} 中止数量 */
  async _stopSubs() {
    let n = 0;
    if (this._subAbort && !this._subAbort.signal.aborted) {
      this._subAbort.abort();
      n++;
    }
    // Windows pi RPC 显式中止（让 win-agent 结束当前 prompt）
    const ws = config.winShell;
    if (ws?.enabled && ws?.token) {
      try {
        await winHost.fetch("/pi/abort", {
          method: "POST",
          headers: { Authorization: `Bearer ${ws.token}` },
          timeoutMs: 5000,
        }).catch(() => {});
      } catch {}
    }
    // 标记所有异步子任务为 aborted，并停止其会话
    for (const [tid, t] of this._subTasks) {
      if (t.status === "pending" || t.status === "running") {
        t.status = "aborted";
        try { t.sig?.abort?.(); } catch {}
        try { t.session?.abort?.().catch(() => {}); } catch {}
        n++;
      }
    }
    // Linux 子会话 abort
    for (const s of [...this._activeSubSessions]) {
      try { await s.abort().catch(() => {}); } catch {}
      n++;
    }
    this._activeSubSessions.clear();
    return n;
  }

  /** 判定沙盒根：files:full → WORKSPACE；files → 私有沙盒；否则 WORKSPACE */
  /** headless Chrome（CDP 9222）自启：供浏览器自动化 skill 使用（user-data-dir 持久登录态） */
  async _ensureChrome() {
    const { spawn } = await import("node:child_process");
    const fs2 = await import("node:fs");
    const findBin = () => {
      const base = "/root/.cache/ms-playwright";
      if (!fs2.existsSync(base)) return null;
      let dirs = [];
      try { dirs = fs2.readdirSync(base); } catch { return null; }
      for (const d of dirs) {
        const p = `${base}/${d}/chrome-linux-arm64/chrome`;
        const p2 = `${base}/${d}/headless_shell`;
        if (fs2.existsSync(p)) return p;
        if (fs2.existsSync(p2)) return p2;
      }
      return null;
    };
    const checkUp = async () => {
      try {
        const r = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1200) });
        return r.ok;
      } catch { return false; }
    };
    checkUp().then((up) => {
      if (up) return;
      const bin = findBin();
      if (!bin) { logBrowser.warn("未找到 chrome 二进制（playwright 未下载），浏览器 skill 不可用"); return; }
      const profile = "/opt/pi2x/browser-profile";
      try { fs2.mkdirSync(profile, { recursive: true }); } catch {}
      try {
        const child = spawn(bin, [
          "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
          "--remote-debugging-port=9222", "--user-data-dir=" + profile,
          "--window-size=1280,900", "--hide-scrollbars", "about:blank",
        ], { detached: true, stdio: "ignore" });
        child.unref();
        logBrowser.info("headless Chrome 已启动（:9222）");
      } catch (e) { logBrowser.warn(`chrome 启动失败: ${e?.message}`); }
    });
  }

  _sessionCwd(userId, perms) {
    if (perms.has("files:full")) return WORKSPACE;
    if (perms.has("files")) {
      const dir = path.join(this.sandboxRoot, String(userId));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    }
    return WORKSPACE;
  }

  /** 取（或创建）某个 chatKey 的 agent 会话（按白名单权限决定工具集）
   * 注：用 pending Map 去重，避免并发调用时对同一 chatKey 重复创建（会触发会话文件 wx 冲突 EEXIST） */
  async _getSession(chatKey, userId) {
    // 群会话按用户隔离：group:gid:userId（权限/上下文各自独立，避免跨用户串权限）
    const sessionKey = sessionKeyOf(chatKey, userId);
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;
    const pending = this._pending.get(sessionKey);
    if (pending) return pending;
    const p = this._createSession(sessionKey, userId)
      .then((entry) => {
        entry.key = sessionKey;
        this.sessions.set(sessionKey, entry);
        this._pending.delete(sessionKey);

        return entry;
      })
      .catch((err) => {
        this._pending.delete(sessionKey);
        throw err;
      });
    this._pending.set(sessionKey, p);
    return p;
  }

  async _createSession(chatKey, userId) {
    const perms = this.white.perms(userId);
    const file = path.join(SESSIONS_DIR, `${this._safeKey(chatKey)}.jsonl`);
    const opts = {
      cwd: this._sessionCwd(userId, perms),
      agentDir: AGENT_DIR,
      resourceLoader: this.loader,
      sessionManager: SessionManager.open(file),
      settingsManager: makeSettingsManager(),
      modelRuntime: this.modelRuntime,
      model: this.model,
    };
    const hasFilesFull = perms.has("files:full");
    const hasFiles = perms.has("files");
    const customTools = this._buildTools(perms, userId);
    if (hasFilesFull) {
      // 内置基础工具全开：read/bash/edit/write + ls/find/grep（SDK 默认只注册核心 4 件套，extra 经 customTools 补）
      opts.customTools = [createLsTool(WORKSPACE), createFindTool(WORKSPACE), createGrepTool(WORKSPACE), ...customTools];
    } else if (hasFiles) {
      // 沙盒：内置文件工具替换为受限版（bwrap + 路径校验），自定义工具照常
      opts.excludedToolNames = ["read", "bash", "edit", "write"];
      opts.customTools = [...this._sandboxFileTools(perms, userId), ...customTools];
    } else {
      // 无文件权限：禁内置文件工具；无任何有效权限工具则纯对话（防 dialog 用户拿到内置 bash）
      const hasAnyPerm = perms.size > 0;
      opts.noTools = hasAnyPerm ? "builtin" : "all";
      opts.customTools = customTools;
    }
    const { session } = await createAgentSession(opts);
    const entry = {
      session,
      tail: Promise.resolve(),
      context: null,
      asm: new TurnAssembler(session),
      globalInjected: false, // 全局记忆只注入一次（首条消息），避免历史重复
    };
    logPi.info(`新会话 ${chatKey} [user ${userId}]
   权限: ${this.white.list(userId).join(", ") || "dialog(最低)"}`);
    return entry;
  }

  /** bot 专属工具（按白名单权限装载）
   * @param {Set<string>} perms 权限集合 */
  /** 特权 CLI（qq-cli）：由主进程执行（凭据/白名单不出沙箱），强制 --as 当前用户（防伪造），参数白名单防注入 */
  async _runPrivilegedCli(argsStr, userId) {
    const { execFileSync } = await import("node:child_process");
    let args = String(argsStr ?? "").trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--as") { i++; continue; } // 丢弃传入身份，强制为当前沙盒用户
      out.push(args[i]);
    }
    args = out;
    const action = args[0];
    const ALLOW = ["group_history", "msg_detail", "friend_list", "group_list", "ocr", "group_file_url", "download", "delete_msg", "napcat", "op", "deop"];
    if (!ALLOW.includes(action)) return { text: `qq-cli 支持的操作: ${ALLOW.join("、")}` };
    for (const a of args.slice(1)) {
      if (/[;&|`$\"'\\\n\r]/.test(a)) return { text: `参数含非法字符，已拒绝: ${a.slice(0, 40)}` };
    }
    try {
      const outStr = execFileSync("node", [path.join(ROOT, "scripts", "qq-cli.mjs"), "--as", String(userId), ...args], {
        encoding: "utf8", timeout: 90000, shell: false,
      }).trim();
      return { text: outStr || "（无输出）" };
    } catch (e) {
      return { text: `命令退出：${(e?.stdout?.toString?.() || e?.message || "执行失败").toString().slice(0, 1500)}` };
    }
  }

  /** 沙盒受限文件工具（files 权限，bwrap + 路径校验）
   * 仅能读写私有沙盒目录；bash 经 bwrap 强隔离（系统只读、禁网） */
  _sandboxFileTools(perms, userId) {
    const sandbox = this._sessionCwd(userId, perms);
    // 共享目录：所有 operator 沙箱可读写（协作），位于 workspace/shared
    const shared = path.join(WORKSPACE, "shared");
    try { fs.mkdirSync(shared, { recursive: true, mode: 0o777 }); } catch (e) { /* 忽略 */ }
    const allowBase = (base, fp) => {
      const rp = path.resolve(base);
      const fpp = path.resolve(fp);
      return fpp === rp || fpp.startsWith(rp + path.sep);
    };
    const inside = (p) => allowBase(sandbox, p) || allowBase(shared, p);
    const read = defineTool({
      name: "read",
      ...pTool("read", { SANDBOX: sandbox }),
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, p) => {
        if (!inside(p.path)) return { content: [{ type: "text", text: `拒绝：路径超出沙盒 ${sandbox}` }], details: {} };
        try { return { content: [{ type: "text", text: fs.readFileSync(p.path, "utf8") }], details: {} }; }
        catch (e) { return { content: [{ type: "text", text: `读取失败: ${e?.message}` }], details: {} }; }
      },
    });
    const write = defineTool({
      name: "write",
      ...pTool("write", { SANDBOX: sandbox }),
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id, p) => {
        if (!inside(p.path)) return { content: [{ type: "text", text: `拒绝：路径超出沙盒 ${sandbox}` }], details: {} };
        try {
          fs.mkdirSync(path.dirname(path.resolve(p.path)), { recursive: true });
          fs.writeFileSync(p.path, p.content);
          return { content: [{ type: "text", text: `已写入 ${p.path}` }], details: {} };
        } catch (e) { return { content: [{ type: "text", text: `写入失败: ${e?.message}` }], details: {} }; }
      },
    });
    const bash = defineTool({
      name: "bash",
      ...pTool("bash", { SANDBOX: sandbox }),
      parameters: Type.Object({
        command: Type.String({ description: "要执行的 shell 命令" }),
        timeout: Type.Number({ description: "超时秒数（必填，上限 120）——必须显式指定" }),
      }),
      execute: async (_id, p) => {
        const { execFileSync } = await import("node:child_process");
        // ── 需要系统凭据的脚本（qq-cli）：由主进程强制以当前用户身份执行（沙箱内不暴露 config/whitelist，身份防伪造） ──
        const m = String(p.command ?? "").match(/^\s*node\s+\S*qq-cli\.mjs\s+(.*)$/s);
        if (m) {
          const res = await this._runPrivilegedCli(m[1], userId);
          return { content: [{ type: "text", text: res.text }], details: {} };
        }
        // 截图等产物默认落在自己的沙盒内（沙箱里 /opt/pi2x/tmp 不可见，不能作默认目录）
        const cmd = `export PI2X_SANDBOX_DIR=${JSON.stringify(sandbox)}; export PI2X_SHARED_DIR=${JSON.stringify(shared)}; cd ${JSON.stringify(sandbox)} && ${p.command}`;
        // ── 沙盒挂载：**白名单**模式 ──────────────────────────────────────────
        //
        // 【为什么从黑名单改成白名单】
        // 原先的做法是「整个文件系统只读挂载，再遮蔽几个敏感路径」，属黑名单 ——
        // 遮了 /root、config.json、whitelist.json、memories，却漏了 sessions/、logs/、
        // state/、browser-profile/（含 admin 登录态）…… 实测 operator 能读到
        // **所有人的聊天记录**。黑名单永远会漏，所以改成白名单：只挂必需的，其余不可见。
        //
        // 白名单内容（每项都有理由，加东西前先想清楚）：
        //   /usr + 标准软链   运行 node/bash 与动态链接器所必需
        //   /etc 下若干单文件  只挂 DNS/证书/用户库；整个 /etc 不可挂
        //                     （里面有 profile.d/cred.sh、deepseek.sh 等密钥）
        //   scripts + node_modules  供 browser-cli 等脚本运行
        //   chrome 二进制     挂到原路径，browser-cli 的 findBin() 无需改动
        //   自己的沙盒 + shared  唯一可写处；shared 是设计上的协作目录
        //
        // 不挂载即不可见：sessions / logs / state / workspace(除 shared) /
        // config.json / whitelist.json / browser-profile / 其他人的沙盒 / /root 其余内容。
        const bwrap = [
          "bwrap", "--unshare-user-try", "--die-with-parent",
          "--ro-bind", "/usr", "/usr",
          "--symlink", "usr/bin", "/bin",
          "--symlink", "usr/lib", "/lib",
          "--symlink", "usr/sbin", "/sbin",
          "--symlink", "usr/lib64", "/lib64",
          "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
          "--ro-bind", "/etc/hosts", "/etc/hosts",
          "--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
          "--ro-bind", "/etc/passwd", "/etc/passwd",
          "--ro-bind", "/etc/group", "/etc/group",
          "--ro-bind", "/etc/ssl", "/etc/ssl",
          "--ro-bind", "/etc/localtime", "/etc/localtime",
          "--ro-bind", path.join(ROOT, "scripts"), path.join(ROOT, "scripts"),
          "--ro-bind", path.join(ROOT, "node_modules"), path.join(ROOT, "node_modules"),
          "--ro-bind", "/root/.cache/ms-playwright", "/root/.cache/ms-playwright",
          "--bind", sandbox, sandbox,
          "--bind", shared, shared,
          "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
          "bash", "-c", cmd,
        ];
        try {
          const out = execFileSync(bwrap[0], bwrap.slice(1), {
            encoding: "utf8",
            timeout: Math.min(Math.max(Number(p.timeout ?? 15), 3), 120) * 1000,
            shell: false,
          }).trim();
          return { content: [{ type: "text", text: out || "（无输出）" }], details: {} };
        } catch (e) {
          const msg = e?.stdout?.toString?.() || e?.message || "执行失败";
          // bwrap 不可用降级提示
          if (/bwrap.*(not found|No such)/i.test(msg)) {
            return { content: [{ type: "text", text: `沙盒不可用（bwrap 缺失）：${msg}` }], details: {} };
          }
          return { content: [{ type: "text", text: `命令退出：${msg.slice(0, 1500)}` }], details: {} };
        }
      },
    });
    // 沙箱版 edit：精确替换（路径校验，仅沙盒内）——防止 SDK 内置全权 edit 泄漏（逃逸）
    const edit = defineTool({
      name: "edit",
      description: `在沙盒目录 ${sandbox} 内的文本文件做精确替换（路径校验，超出拒绝）。参数：path（沙盒内路径）、edits（[{oldText,newText}]）。`,
      parameters: Type.Object({
        path: Type.String({ description: "要编辑的文件（沙盒内路径）" }),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { description: "精确替换列表" }),
      }),
      execute: async (_id, p) => {
        const fp = path.resolve(String(p.path ?? ""));
        if (!inside(fp)) return { content: [{ type: "text", text: `拒绝：路径超出沙盒 ${sandbox}` }], details: {} };
        try {
          let content = fs.readFileSync(fp, "utf8");
          const list = Array.isArray(p.edits) ? p.edits : [];
          for (const e of list) {
            const oldT = String(e?.oldText ?? "");
            if (!oldT || !content.includes(oldT)) return { content: [{ type: "text", text: `未找到匹配文本: ${oldT.slice(0, 60)}` }], details: {} };
            content = content.split(oldT).join(String(e?.newText ?? ""));
          }
          fs.writeFileSync(fp, content);
          return { content: [{ type: "text", text: `已编辑 ${fp}` }], details: {} };
        } catch (e) { return { content: [{ type: "text", text: `编辑失败: ${e?.message}` }], details: {} }; }
      },
    });
    return [read, write, bash, edit];
  }

  /**
   * 装配当前会话的工具集（委托给 lib/tools/index.mjs 的声明式注册表）。
   *
   * 工具定义按域拆在 lib/tools/*.mjs；权限门禁由 TOOL_PERM 映射统一包装。
   * 这里只负责把 PiAgent 自身作为依赖注入进去。
   * @param {Set<string>} perms 权限 token 集合
   * @param {string} userId 当前用户 QQ 号
   * @returns {Array<any>}
   */
  _buildTools(perms, userId) {
    return buildTools({ me: this, perms, userId });
  }

  /**
   * 命令路由（仅 admin）——消息前缀：
   *   $  执行 Linux Bash（本机，cwd=workspace）
   *   /  内置命令（help/status/memory/perms/whoami）
   *   >  执行 Windows Shell（经 win-agent）
   * @returns {Promise<string|null>} 命令回复；非命令消息返回 null（走正常对话）
   */
  async handleCommand(text, { userId, chatType, targetId }) {
    if (!/^[\$\/>]/.test(text)) return null;
    // /insert：抢占式插入（steer）——交由 handleMessage/_runTurn 处理，不作为内置命令
    if (text.startsWith("/insert")) return null;
    const cmd = String(text).slice(1).trim();
    if (!cmd) return "（命令为空）";
    const perms = this.white.perms(userId);
    if (!perms.has("files:full")) {
      return "该命令前缀仅管理员可用（$ / >）。";
    }
    if (text.startsWith("$")) return this._linuxCmd(cmd);
    if (text.startsWith(">")) return this._winCmd(cmd);
    return this._builtinCmd(cmd, { userId, chatType, targetId });
  }

  async _linuxCmd(cmd) {
    const { spawnSync } = await import("node:child_process");
    try {
      const r = spawnSync("bash", ["-c", "cd " + JSON.stringify(WORKSPACE) + " && " + cmd], {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
      return "$ " + cmd + "\n" + (out || `（完成，exit=${r.status}）`).slice(0, 2000);
    } catch (e) {
      const err = (e?.stdout?.toString?.() || "") + (e?.stderr?.toString?.() || e?.message || "");
      return "$ " + cmd + "\n（执行失败）" + String(err).trim().slice(0, 1500);
    }
  }

  async _winCmd(cmd) {
    const ws = config.winShell;
    if (!ws?.enabled || !ws?.token) return "（win-agent 未配置）";
    try {
      const resp = await winHost.fetch("/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ws.token}` },
        body: JSON.stringify({ command: cmd, shell: "cmd", timeoutMs: 0 }), // > 命令不设超时，自然跑完
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) return `> ${cmd}\n（win-agent HTTP ${resp.status}: ${d?.error ?? ""}）`;
      const out = (d?.stdout ?? "" ) + (d?.stderr ?? "");
      return "> " + cmd + "\n" + (String(out).trim() || `（完成，exit=${d?.exitCode}）`).slice(0, 2000);
    } catch (e) {
      return `> ${cmd}\n（执行失败: ${e?.message}）`;
    }
  }

  _builtinCmd(cmd, { userId, chatType, targetId }) {
    const [name, ...rest] = cmd.split(/\s+/);
    const entry = PiAgent.BUILTIN[name] ?? PiAgent.BUILTIN[PiAgent.ALIASES[name]];
    if (!entry) return `未知内置命令 /${name}，输入 /help 查看。`;
    // 自动帮助注册：任何内置命令带 -h / --help 参数 → 展示用法（无需每个命令自己实现）
    if (rest.some((a) => a === "-h" || a === "--help")) {
      const usage = entry.usage ? ` ${entry.usage}` : (rest.length ? "" : "");
      return [`用法: /${name}${usage}`.trim(), `说明: ${entry.desc}`].join("\n");
    }
    try {
      // 支持异步 run
      return Promise.resolve(entry.run(this, { userId, chatType, targetId }, rest));
    } catch (e) {
      return `命令 /${name} 执行失败: ${e?.message}`;
    }
  }

  /** RED 高风险接口二次确认拦截：回复「确认执行」→ 执行待确认操作，返回结果 */
  _consumeRedConfirm(text, userId) {
    const p = this.pendingRed;
    if (!p) return null;
    if (String(p.uid) !== String(userId)) return null;      // 仅发起者可确认
    if (Date.now() - p.ts > 5 * 60 * 1000) { this.pendingRed = null; return null; } // 过期
    const t = String(text ?? "").trim();
    if (t.length > 20 || !/^(确认|执行|同意|好)/.test(t)) return null; // 必须是简短的确认语
    this.pendingRed = null;
    const { api, params } = p;
    return (async () => {
      try {
        logNapcat.info(`RED ${api} 已确认执行（uid=${userId}）`);
        const r = await this.bridge.api(api, params);
        return `已执行 ${api}：` + (String(JSON.stringify(r)).slice(0, 1200) || "（空返回）");
      } catch (e) {
        return `执行失败: ${e?.message}`;
      }
    })();
  }

  /** 群名（缓存，失败回退群号） */
  _groupNameOf(gid) {
    if (this._groupNameCache.has(gid)) return this._groupNameCache.get(gid);
    const p = (async () => {
      try {
        const r = await this.bridge.api("get_group_info", { group_id: Number(gid) });
        return r?.data?.group_name ?? String(gid);
      } catch {
        return String(gid);
      }
    })();
    this._groupNameCache.set(gid, p);
    return p;
  }

  /**
   * 会话上下文块。
   *
   * 【返回两块，去向不同】（2026-09-12 改）
   *  - `ctxText`  会话上下文（群/用户ID/用户名/时间/权限组）→ **进会话历史**
   *  - `permText` 权限组白名单 → **不进历史**，临时并入当次 system prompt
   *
   * 为什么要把权限白名单拆出去：它原本拼在每条 user 消息头部，写进历史就永久留下。
   * 而它每轮都是同一份内容（同一个人权限不变），几百轮下来纯属白占上下文，
   * 还会在权限调整后留下一堆互相矛盾的历史副本（模型可能引用旧的那份）。
   * 改成每请求临时注入后：历史里只有用户原话，权限始终以“当前这一刻”为准。
   *
   * @returns {Promise<{ctxText:string, permText:string}>}
   */
  async _ctxBlock({ chatType, targetId, userName, userId }) {
    // 当前时间戳（如 2026/9/16 13:21，插入在“权限组”之前）
    const d = new Date();
    const ts = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    let base;
    if (chatType === "group") {
      const gname = await this._groupNameOf(targetId);
      base = pSessionContext({
        CHAT_TYPE: `群聊【${targetId} ${gname}】`,
        USER_ID: userId,
        USER_NAME: userName || "未知",
        TIME: ts,
      });
      // 群成员映射（QQ↔昵称，方便理解 @QQ 与群内形况；最多列最近 15 位）
      const members = this._groupMembers.get(String(targetId));
      if (members && members.size) {
        const lines = [];
        for (const [uid, name] of members) {
          if (String(uid) === String(userId)) lines.unshift(`${uid} = ${name}（当前用户）`);
          else lines.push(`${uid} = ${name}`);
        }
        base = base + "\n\n【群成员映射】QQ号 → 昵称（@数字 请对照此表理解指向谁）：\n- " + lines.slice(0, 15).join("\n- ");
      }
    } else {
      base = pSessionContext({
        CHAT_TYPE: "私聊",
        USER_ID: userId,
        USER_NAME: userName || "未知",
        TIME: ts,
      });
    }
    // 权限组白名单由 _permBlock() 单独给出（去向分私聊/群聊，见该方法注释，不进历史）。
    return { ctxText: base, permText: this._permBlock(userId, { chatType }) };
  }

  /**
   * 权限组白名单块 —— 每请求临时注入 system prompt，**不写进会话历史**。
   * 内容随当前权限实时生成，权限一改下一条消息就生效，历史里不会留下过期副本。
   */
  _permBlock(userId, { chatType = "private" } = {}) {
    // admin 在**私聊**下不显示白名单：他拥有全部权限，逐条列出来只是白占 466 字符。
    // 群聊里仍照常显示（同群里权限各不相同，列表对判断"谁在跟我要东西"仍有价值）。
    if (chatType === "private" && this.white?.presetOf?.(userId) === "admin") return "";
    const wl = this.white.load();
    const groups = this.white.groupsOf(userId);
    if (!wl || !groups.length) return "";
    const lines = [`【权限组白名单】 当前权限组：${this.white.presetOf(userId)}`];
    for (const g of groups) {
      const perms = wl.groups?.[g] ?? [];
      lines.push(`- ${g}: ${perms.join(", ")}`);
    }
    return lines.join("\n");
  }

  /**
   * 命中一个启用的 persona（config.pi.persona，全局生效——不限定 userId）。
   *
   * 统一人设：所有人读同一个 promptFile，不再按权限组选不同文件。
   * （历史：曾按 admin/public 二选一，见 git log 中「统一人设」那次改动。）
   *
   * @returns {{enabled?:boolean, promptFile:string, isAdmin:boolean}|null} 未启用 / 未配置返回 null
   */
  _personaFor(userId) {
    const persona = config.pi?.persona;
    if (!persona) return null;
    const key = Object.keys(persona).find((k) => persona[k]?.enabled);
    if (!key) return null;
    const p = persona[key];
    if (!p?.promptFile) return null;
    return { ...p, promptFile: String(p.promptFile), isAdmin: this.white?.presetOf?.(userId) === "admin" };
  }

  /** 把群消息里的 @纯数字 替换成 @昵称(QQ)（映射命中时；未知名保留原样） */
  _resolveAtNames(text, gid) {
    const m = this._groupMembers.get(String(gid));
    if (!m || !m.size) return text;
    return String(text).replace(/@(\d{5,})/g, (full, qq) => {
      const name = m.get(String(qq));
      return name ? `@${name}(${qq})` : full;
    });
  }

  /** 处理一条 QQ 消息（允许并发：同一会话消息并行提交，SDK followUp 排队）
   * @param {{chatKey:string, text:string, chatType:string, targetId:string, selfId:string, userName:string, userId:string, images?:Array}} opts */
  handleMessage({ chatKey, text, chatType, targetId, selfId, userName, userId, images, skipMemory }) {
    // 群成员 QQ↔昵称 映射维护（增量：首次见过的用户记入，昵称变更覆盖）
    if (chatType === "group" && userId && userName) {
      let m = this._groupMembers.get(String(targetId));
      if (!m) { m = new Map(); this._groupMembers.set(String(targetId), m); }
      m.set(String(userId), String(userName));
      if (m.size > 100) { // 防无限膨胀：超限时移除最旧的（Map 按插入序）
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }
    }
    // RED 二次确认拦截（高风险接口确认语，不进 LLM）
    const redConfirm = this._consumeRedConfirm(text, userId);
    if (redConfirm) return redConfirm;
    const perms = this.white.perms(userId);
    // 非 admin 请求风险评估（工作流硬门禁）：deny 直接拦截，其余放行但注入风险结论
    return this._gateRisk({ chatKey, text, chatType, targetId, selfId, userName, userId, images, perms, skipMemory });
  }

  /** 非 admin 请求风险评估门禁（工作流层，非模型工具）
   * 流程：先本地规则快筛 → 拿不准唤醒只读评审 subagent。
   * deny → 直接拒绝；confirm → 放行但注入"需谨慎/二次确认"结论；allow → 正常放行。 */
  async _gateRisk({ chatKey, text, chatType, targetId, selfId, userName, userId, images, perms, skipMemory }) {
    // admin（files:full）不评审，直接走主 agent
    if (perms.has("files:full")) {
      return this._runTurn({ chatKey, text, chatType, targetId, selfId, userName, userId, images, perms, riskNote: "", skipMemory });
    }
    let verdict = null;
    try {
      verdict = await assessRequest({
        userId,
        chatType,
        targetId,
        userName,
        preset: this.white.presetOf(userId),
        userText: text,
        // 复用会话模型依赖（评审独立 loader 使用）
        modelRuntime: this.modelRuntime,
        model: this.model,
        loader: this.loader,
        agentDir: AGENT_DIR,
      });
    } catch (e) {
      logRisk.error(`风险评审失败（保守放行）: ${e?.message}`);
    }
    const act = verdict?.action ?? "allow";
    if (act === "deny") {
      logRisk.warn(`拦截非 admin ${userId} 请求: ${verdict?.reason ?? "高危"}`);
      return `⚠️ 该操作已被安全策略拦截：${verdict?.reason ?? "存在安全风险"}。需要管理员授权后才能执行。`;
    }
    // allow / confirm：注入风险结论，主 agent 据此执行
    const riskNote = verdict
      ? pRiskNote({
          LEVEL: verdict.level,
          SOURCE: verdict.source,
          REASON: verdict.reason,
          CONFIRM_HINT: act === "confirm" ? "若涉及写/改/执行/外部传输，请先向用户确认目标与影响，再谨慎执行。" : "",
        })
      : "";
    return this._runTurn({ chatKey, text, chatType, targetId, selfId, userName, userId, images, perms, riskNote, skipMemory });
  }

  /** 实际执行一轮（把风险研判注入上下文后交给主 agent）——按会话串行，避免并发 submit 事件错位 */
  async _runTurn({ chatKey, text, chatType, targetId, selfId, userName, userId, images, perms, riskNote, skipMemory }) {
    const entry = await this._getSession(chatKey, userId);
    // /insert 前缀 → 抢占式 steer（用户主动打断/指导正在运行的 agent）。其余普通消息在流式时改为 nextTurn（排队到下一轮，不打断）。
    const insertM = text.match(/^\/insert\s+(.+)/s);
    const insertText = insertM ? insertM[1] : null;
    // /insert 仅管理员可用（占位抢断指令）；非 admin 使用则拒发
    if (insertText != null && !perms?.has("files:full")) {
      logSteer.warn(`${chatKey} 非 admin 尝试 /insert，已拒绝`);
      return "（/insert 仅管理员可用）";
    }
    if (entry.session?.isStreaming) {
      try {
        // 抢注同样建立本轮的 ALS 上下文（工具在被注入的这轮里执行时要能读到正确的"我是谁"）
        const steerCtx = { chatType, targetId, selfId, userName, userId, chatKey, currentSessionKey: entry.key ?? chatKey };
        const injectText = insertText != null ? insertText : text;
        await runWithTurnCtx(steerCtx, () => entry.session.steer(injectText, images));
        logSteer.info(`${chatKey} <${userName}>: ${insertText != null ? "/insert" : "抢注"} 已注入（流式中）: ${injectText.slice(0, 60)}`);
        return ""; // 不单独结算，由 agent 后续/下一轮输出体现
      } catch (e) {
        logSteer.error(`${chatKey} 流式注入失败，回退串行: ${e?.message}`);
      }
    }
    // 同一会话串行处理：接在上一轮尾巴上，确保一次只有一条 submit 在跑
    //
    // 【为什么整轮包在 runWithTurnCtx 里】
    // 上下文原本写在 this.ctx（实例单例）上，并发会话会互相覆盖 ——
    // 后果包括「消息发进别人的会话」「私聊记忆写进群共享」等（详见 lib/turn-context.mjs）。
    // 改用 AsyncLocalStorage 后，上下文随异步链走，与本轮一一对应，与并发无关。
    const turnCtx = { chatType, targetId, selfId, userName, userId, chatKey, currentSessionKey: entry.key ?? chatKey };
    const run = entry.tail.then(() => withTurn(chatKey, () => runWithTurnCtx(turnCtx, async () => {
      const tTurn = Date.now();
      const logTurn = createLogger("turn");
      logTurn.info(`开始 · ${chatType} · ${userName ?? "?"}`);
      // 会话上下文注入：ctxText 进历史；permText（权限白名单）临时注入 system，不进历史
      let ctxText = "";
      let permText = "";
      try {
        const blk = await this._ctxBlock({ chatType, targetId, userName, userId });
        ctxText = blk.ctxText;
        permText = blk.permText;
      } catch (e) {
        logPi.error(`上下文注入失败: ${e?.message}`);
      }
      // 权限白名单 + 风险研判：每请求临时注入，**都不进历史**。
      // 它们原本直接拼在 user 消息头部写进历史 —— 权限白名单每轮重复同一份内容，
      // 风险研判更是「只对当前这一次请求有效」的东西，留在历史里既占空间又会误导后续判断。
      //
      // 【权限白名单的去向按会话类型分派】(2026-09-12)
      //   私聊 → 并入 system prompt。
      //     理由：同一私聊对象的权限在整个会话期间是**稳定**的，system 内容不随轮次变化，
      //     因此不会破坏前缀缓存；放在最前也最符合「这是你当前的身份与权限」的语义。
      //   群聊 → 仍走报文末尾临时注入。
      //     理由：群里每次说话的人可能不同，权限随成员变化；挂末尾可让前缀保持稳定。
      patchTurnCtx({
        permBlockSys: chatType === "group" ? "" : permText,
        permBlockTail: chatType === "group" ? permText : "",
        riskNote: riskNote ?? "",
      });
      // 记忆注入（无感：检索相关记忆拼在用户消息前）
      // 若用户用 /insert 前缀（空闲时）也剥离开，提交真实内容
      let finalText = insertText != null ? insertText : text;
      // 群消息：把 @纯数字 解析成 @昵称(QQ)（便于模型理解 @指向谁）
      if (chatType === "group") finalText = this._resolveAtNames(finalText, targetId);
      if (this.memory && !skipMemory) {
        const stopMem = logTurn.time("记忆注入");
        try {
          // 记忆注入：预计算后存到 this.ctx.memInjection，由扩展 before_agent_start 并入当次 system prompt（不进历史）
          const inj = await this.memory.injectText({ query: text, chatType, userId, targetId, includeGlobals: !entry.globalInjected });
          if (inj.text) patchTurnCtx({ memInjection: inj.text });
          entry.lastInjectedIds = inj.ids ?? [];
          entry.globalInjected = true;
          stopMem(`命中 ${entry.lastInjectedIds?.length ?? 0} 条`);
        } catch (e) {
          stopMem(`失败`);
          logMemory.error(`记忆注入失败: ${e?.message}`);
        }
      }
      // 注意：风险研判 / 权限白名单已改为临时注入 system prompt（见上方 patchTurnCtx），
      // 这里只拼会话上下文 + 用户原话，尽量让历史保持干净。
      finalText = (ctxText ? ctxText + "\n\n" : "") + finalText;

      let reply = "";
      try {
        // 若 compaction 进行中，先等待其完成，避免 pi 拒绝并发提交
        await this._waitCompaction(entry);
        // —— 工具调用文本泄露检测 + 重试 ——
        // 模型偶发把工具调用写成 <tool_calls>/<invoke> 纯文本（而非走正常 toolCall 事件流），
        // 会被 text_delta 收进回复文本，直接漏给用户。这里检测到就不发，注入纠正指令让模型重新生成。
        // 泄露标记可能被模型输出污染成 <ÿÿDSMLÿÿtool_calls> / <｜Μ｜invoke name=…>（全角竖线｜/乱码混入标签名），
        // 正则采用宽松匹配（见 detectToolLeak）：< 到 name= 之间允许任意非 > 字符。
        const hasToolLeak = detectToolLeak;
        const LEAK_MAX = Number(config.pi.leakMaxRetries); // 连续泄露上限（config.pi.leakMaxRetries）
        let leakCount = 0;
        let curText = finalText;
        let curImages = images;
        // 增量流式发送：每个 text_delta 到自然边界即发（不再攒到回合结束）。
        // config.pi.streamReplies === false 可关闭（回到“整段一次性发送”行为）。
        const streamSend = config.pi?.streamReplies === false
          ? null
          : async (part) => {
              const t = String(part ?? "").trim();
              if (!t) return;
              if (chatType === "group") await this.bridge.sendGroupMsg(Number(targetId), t);
              else await this.bridge.sendPrivateMsg(Number(targetId), t);
            };
        for (;;) {
          const stopModel = logTurn.time(leakCount > 0 ? `模型调用(第 ${leakCount + 1} 次·泄露重试)` : "模型调用");
          reply = (await entry.asm.submit(curText, curImages, { send: streamSend })) || "";
          stopModel();
          if (!hasToolLeak(reply)) break; // 无泄露，成功脱离
          leakCount++;
          logLeak.warn(`${chatKey} 第 ${leakCount}/${LEAK_MAX} 次检测到工具调用文本泄露，注入纠正指令重试`);
          if (leakCount >= LEAK_MAX) {
            // 连续多次仍泄露：停止正常输出，改让模型生成一句失败提示
            curText = "你上一条回复把未执行的工具调用写成了 XML 文本（<tool_calls>...</tool_calls>），这是内部格式错误，不能展示给用户。请停止一切技术性输出，只用一句简短中文告知用户：工具调用失败，请稍后重试。不要出现任何 <tool_calls>/<invoke> 标记。";
            curImages = [];
          } else {
            // 未达上限：提示模型走真正的工具通道，或删掉泄露标记只输出用户结果
            curText = "你上一条回复把工具调用写成了 XML 文本而不是通过真正的工具调用执行。请修正：若需调用工具就用真实的工具调用；否则删除这些 <tool_calls>/<invoke> 标记，只输出面向用户的最终结果文本。只输出修正后的最终回复，不要解释过程，也不要出现 <tool_calls>/<invoke> 标记。";
            curImages = [];
          }
        }
        // 奔底：最后一次若仍泄露（模型连失败提示都泄了），用固定兜底文案，避免死循环
        if (hasToolLeak(reply)) reply = "（工具调用失败，请稍后重试）";
      } catch (e) {
        logPi.error(`${chatKey} submit 异常: ${e?.message}`);
      }
      // 清掉本请求的记忆注入（它已随本次 systemPrompt 生效）。
      // ALS 上下文本就随本轮结束而丢弃，这里删一下只是为了 dump 更干净。
      deleteTurnCtxField("memInjection");

      // 自动 compact：会话上下文接近上限时，用 pi 内置压缩精简历史（不阻塞当次回复）
      this._maybeCompact(entry, chatKey);
      // 自动收割（异步、不阻塞回复；仅 harvest 授权者）
      // 流式模式下 reply 常为空串（内容已增量发走）→ 用 lastFullText 作为 botText
      const harvestText = entry.asm.lastFullText || reply;
      if (this.memory && perms.has("memory.harvest") && harvestText) {
        this.memory
          .harvest({ session: chatKey, userId, chatType, targetId, userText: text, botText: harvestText, priorIds: entry.lastInjectedIds })
          .then((r) => {
            if (r && (r.count ?? 0) > 0) logMemory.info(`会话 ${chatKey} 收割 +${r.count}`);
            if (r && (r.used ?? 0) > 0) logMemory.info(`会话 ${chatKey} 使用信号 +${r.used}`);
          })
          .catch(() => {});
      }
      logTurn.info(`完成 · ${Date.now() - tTurn}ms · 回复 ${reply.length} 字`);
      return reply;
    })));
    // 无论成败，收尾更新 tail（清除失败状态，避免卡死后续）
    entry.tail = run.catch((e) => { logPi.error(`${chatKey} turn 失败: ${e?.message}`); return ""; });
    return run;
  }

  /**
   * 取「当前会话」的上下文占用，供 /status 展示。
   *
   * 【为什么要从活跃会话反查】
   * /status 是内置命令，不走 _runTurn，所以 this.ctx 里的 chatKey 还是上一次对话留下的，
   * 直接用可能对不上（尤其刚重启、ctx 尚未被赋值时）。
   * 更稳的做法：在活跃会话表里找一个当前正在流式输出的（就是发命令的这个），
   * 找不到就退化为「取任一活跃会话」，一个都没有则返回空（/status 不显示该行）。
   *
   * 量纲注意事项见 lib/agent/compact-policy.mjs 的 fmtContextUsage。
   *
   * @returns {string[]} 0 或 1 行文本
   */
  /** 由内置命令上下文推出会话键（规则见 lib/agent/chat-key.mjs，与收消息路径共用同一实现） */
  _chatKeyOf(ctx) {
    return chatKeyOf(ctx);
  }

  /**
   * 取「当前会话」的上下文占用，供 /status 展示。
   *
   * 【为什么不能只看 this.sessions】
   * /status 是内置命令，不走 _runTurn，因此它执行时**不一定**存在活跃会话。
   * 最典型的是刚重启完：会话表是空的，用户第一条命令就是 /status ——
   * 此时如果只查 sessions，就什么都显示不出来（线上就踩到了这个）。
   *
   * 所以策略是三级：
   *   1) 会话表里已有该会话 → 直接用
   *   2) 没有 → 按需获取/建立（_getSession 幂等，后续对话会复用它，不算浪费）
   *   3) 仍拿不到 → 返回空数组，/status 少一行而不是报假数
   *
   * 量纲注意事项见 lib/agent/compact-policy.mjs 的 fmtContextUsage。
   *
   * @param {{userId?:string, chatType?:string, targetId?:string}} [ctx]
   * @returns {Promise<string[]>} 0 或 1 行文本
   */
  async _statusContextUsage(ctx) {
    try {
      const key = this._chatKeyOf(ctx);
      let entry = pickSessionEntry(this.sessions, key);
      // 会话表里没有该会话（例如刚重启后第一条命令就是 /status）→ 按需取一个。
      // 这是线上真实踩到的场景：重启后 /status 什么都显示不出来。
      if (!entry && key && ctx?.userId) {
        try {
          entry = await this._getSession(key, String(ctx.userId));
        } catch (e) {
          logPi.warn(`/status 取上下文时会话获取失败: ${e?.message}`);
        }
      }
      if (!entry) return [];
      const cu = entry.session?.getContextUsage?.();
      if (!cu) return [];
      return [CP.fmtContextUsage(cu)];
    } catch (e) {
      return [`上下文 取数异常：${String(e?.message ?? e).slice(0, 40)}`];
    }
  }

  /** 等待 compaction 完成（若正在压缩）。靠 session.isCompacting + entry.compacting 标志 + 超时兑底。 */
  async _waitCompaction(entry) {
    const session = entry?.session;
    if (!session) return;
    // pi 提供 isCompacting；entry.compacting 是我们自己触发的标志
    const isBusy = () => session.isCompacting === true || entry.compacting === true;
    if (!isBusy()) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; session.unsubscribe?.(off); clearTimeout(timer); resolve(); } };
      const off = session.subscribe((ev) => {
        if (ev.type === "compaction_end" || ev.type === "compaction_start") {
          // compaction_start 表示新一轮开始（可能又忙），compaction_end 表示结束
          if (ev.type === "compaction_end") finish();
        }
      });
      // 兜底轮询：若事件未触发，靠轮询 isCompacting
      const timer = setInterval(() => { if (!isBusy()) finish(); }, 500);
      // 超时兑底（防止卡死）：120s 后强制继续
      setTimeout(finish, 120000);
    });
  }

  /** 自动 compact：会话上下文占用超过阈值时，用 pi 内置压缩精简历史（不阻塞当次回复）
   *
   * 量纲契约：pi 的 getContextUsage().percent 是 **0~100 的百分数**，
   * config.pi.compactPercent 必须同量纲（默认 70 = 占用 70%）。
   * 判定逻辑在 lib/agent/compact-policy.mjs（纯函数 + 单测覆盖）。
   * @param {any} entry 会话 entry
   * @param {string} chatKey */
  _maybeCompact(entry, chatKey) {
    const threshold = CP.resolveThreshold(config.pi?.compactPercent, 70);
    const cooldownMs = Number(config.pi.compactCooldownMs);
    try {
      const cu = entry.session?.getContextUsage?.();
      // 单一触发条件：占模型窗口的比例超过阈值。
      // 注意量纲 —— cu.percent 已经是 0~100，阈值同量纲（config.pi.compactPercent）。
      if (cu?.percent == null) return;
      if (!CP.shouldCompact(cu.percent, threshold)) return;

      // 防重入 & 冷却
      if (!CP.canTrigger({ compacting: entry.compacting, lastCompactAt: entry.lastCompact ?? 0, cooldownMs })) return;
      entry.compacting = true;
      const started = Date.now();
      const why = `${CP.fmtPercent(cu.percent)} 达阈值 ${threshold}%`;
      logCompact.info(`${chatKey} 触发压缩（${why}）`);
      entry.session
        .compact()
        .then((r) => {
          entry.lastCompact = Date.now();
          const after = entry.session?.getContextUsage?.();
          logCompact.info(
            `${chatKey} 已压缩 · ${why} → ${after?.tokens != null ? `${after.tokens} token` : "完成"}` +
              ` · ${Date.now() - started}ms`
          );
        })
        .catch((e) => logCompact.warn(`${chatKey} 压缩失败: ${e?.message}`))
        .finally(() => { entry.compacting = false; });
    } catch (e) {
      logCompact.warn(`${chatKey} 检查失败: ${e?.message}`);
    }
  }

  async disposeAll() {
    for (const [, entry] of this.sessions) entry.session.dispose();
    this.sessions.clear();
  }
}

/**
 * 把一段临时文本挂到「报文最后一条消息」的末尾。
 *
 * 之所以挂在最后一条而不是别处：它是缓存分叉点能容忍的最后一个位置 ——
 * 前面所有内容（system + 整段历史）都保持逐字节不变，前缀缓存照常命中。
 *
 * 兼容两种报文形态：
 *  · OpenAI 兼容（omniroute/deepseek 都是）：{ messages: [...] }，content 为字符串或分片数组
 *  · 直接传数组的（个别 provider/SDK 路径）：[...]
 *
 * @param {unknown} payload 请求报文
 * @param {string} text 要附加的文本
 * @returns {boolean} 是否成功附加
 */
export function appendTailBlock(payload, text) {
  const msgs = Array.isArray(payload) ? payload : payload?.messages;
  if (!Array.isArray(msgs) || !msgs.length) return false;
  const last = msgs[msgs.length - 1];
  if (!last || typeof last !== "object") return false;
  // 角色判断必须排在最前：助手消息里出现「本轮临时块」会被模型当成它自己刚说过的话
  if (last.role === "assistant") {
    msgs.push({ role: "user", content: text });
    return true;
  }
  if (typeof last.content === "string") last.content = last.content + "\n\n" + text;
  else if (Array.isArray(last.content)) last.content.push({ type: "text", text });
  else last.content = text;
  return true;
}

export function createPiAgent({ bridge }) {
  return new PiAgent({ bridge });
}