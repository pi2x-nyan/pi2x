/**
 * 安全模式（safe mode）—— 出问题后仍能通过 QQ 自救的最小框架
 *
 * ┌─ 设计目标 ─────────────────────────────────────────────────────────────┐
 * │ 当正常模式（bridge.mjs + lib/piagent.mjs + 记忆 + 工具注册表 + 浏览器…）    │
 * │ 起不来时，仍然要让「我」能通过 QQ 收到你的话、并动手修。                  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 【依赖闭包 —— 这是整个设计的命门】
 * 本模块只允许依赖：
 *     node:* 内置  ·  ws（经 lib/qqbridge.mjs）  ·  lib/log.mjs  ·  lib/config.mjs
 *     ·  pi SDK（含 4 个基础工具工厂）
 * 明确**不**依赖：memory.mjs、tools/、piagent.mjs、prompts/、browser、subagent、winShell…
 *
 * 理由：那些模块正是最可能被我改坏的部分。安全模式若也依赖它们，
 * 就会「一起坏」，失去救援意义。这与 Windows 安全模式的思路一致：
 * 保留的是一小撮冻结的、极少改动的组件。
 * 这条闭包由 test/safe-closure.test.mjs 机械锁死 —— 一旦有人加了越界依赖，测试立刻变红。
 *
 * 【agent 能力（刻意保留）】
 * 只挂 pi 自带的四个基础工具：read / write / edit / bash。
 * 这四个刚好覆盖自救所需：看日志、改代码、跑测试、执行 git 回滚。
 * 系统提示直接写在本文件里（不去读 prompt/ 目录）—— 避免提示词文件本身坏掉起不来。
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  createAgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  defineTool,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";
import { ROOT, SESSIONS_DIR, config } from "../config.mjs";
import { createLogger } from "../log.mjs";
import { QQBridge } from "../qqbridge.mjs";
import { createModelRuntime, resolveModel } from "../model-config.mjs";
import { readMode, writeMode, touchHeartbeat, DEFAULTS } from "../mode.mjs";
import { makeSettingsManager } from "../agent/settings.mjs";
import { GIVEUP_TOKEN, detectGiveup, GIVEUP_TOOL_SPEC, triggerRollback } from "./giveup.mjs";

const logSafe = createLogger("safe");

/** 安全模式的系统提示 —— 硬编码在代码里（不读 prompt/ 目录，避免提示词文件坏掉）
 *  内容只讲清三件事：你现在是残血状态、你有哪些工具、先诊断别乱改。 */
export const SAFE_SYSTEM_PROMPT = `你是 PI2X 的「安全模式」——正常模式因为代码或依赖出问题而起不来，你被自动拉起做急救。

当前状态：
- 你只有四个基础工具：read（读文件）、write（写文件）、edit（改文件）、bash（执行命令）。
- 你的记忆库、工具注册表、浏览器、子代理、Windows 远程能力**全部没有加载**。
- 因此你无法查记忆、无法跑复杂任务，也不该假装自己有那些能力。

你的任务优先级：
1. 先诊断：看 logs/bridge.log 末尾、跑 node scripts/preflight.mjs，弄清正常模式为什么起不来。
2. 再修复：改代码 / git 回滚（git log、git revert、git reset）。
3. 修完必须验证：node scripts/preflight.mjs 通过后，才能用
   node scripts/mode.mjs normal 切回正常模式。**不要跳过验证**。
4. 不确定就如实说，不要编造。你现在的价值是「能动手 + 说实话」，不是「看起来正常」。

4. 如果你**确实修不了**（试过至少一种方案仍失败），调用 declare_unfixable 工具请求回退，
   并在 reason 里写清你试过什么、卡在哪里。系统会回退到上一个已验证可用的版本。
   如果工具调用不了，就在回复里单独一行输出 ${GIVEUP_TOKEN}（系统同样会识别）。
   **不要轻易放弃** —— 回退会丢弃当前改动；但也**不要硬撑**，修不动就说清楚。

沟通要求：简洁中文，先说结论，再说你做了什么。`;

/** 安全模式要拒绝的越界能力（万一将来有人误加，这里显式兜底） */
export const FORBIDDEN_TOOLS = Object.freeze(["run_task", "subagent_send", "subagent_result", "qq_send_file"]);

/**
 * 构建安全模式的最小 agent 会话。
 * 单独抽出便于测试（用一个假 resourceLoader 就能离线验证）。
 *
 * @param {object} p
 * @param {any} p.modelRuntime
 * @param {any} p.model
 * @param {string} p.chatKey
 * @returns {Promise<any>} session
 */
export async function createSafeSession({ modelRuntime, model, chatKey, cwd = ROOT, onGiveup }) {
  const file = path.join(SESSIONS_DIR, `safe-${String(chatKey).replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: path.join(ROOT, "agent-dir"),
    noExtensions: true, // 不加载任何扩展
    noSkills: true, // 不加载 skills
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true, // 不读 AGENTS.md 之类
    systemPrompt: SAFE_SYSTEM_PROMPT, // 提示词硬编码，不读 prompt/
  });

  const tools = [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
  ].filter((t) => t && !FORBIDDEN_TOOLS.includes(t.name));

  // 「修不好，请回退」工具 —— 由 agent 在局内判断，比外部数次数准得多（见 giveup.mjs 说明）
  if (typeof onGiveup === "function") {
    tools.push(
      defineTool({
        name: GIVEUP_TOOL_SPEC.name,
        label: "声明无法修复并请求回退",
        description: GIVEUP_TOOL_SPEC.description,
        parameters: Type.Object({
          reason: Type.String({ description: GIVEUP_TOOL_SPEC.parameters.reason }),
          suggestion: Type.Optional(Type.String({ description: GIVEUP_TOOL_SPEC.parameters.suggestion })),
        }),
        execute: async (_id, params) => {
          const r = await onGiveup({ reason: String(params?.reason ?? ""), suggestion: String(params?.suggestion ?? "") });
          return {
            content: [{ type: "text", text: r?.text ?? "已请求回退。" }],
            details: { giveup: true },
          };
        },
      })
    );
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir: path.join(ROOT, "agent-dir"),
    resourceLoader: loader,
    sessionManager: SessionManager.open(file),
    settingsManager: makeSettingsManager(),
    modelRuntime,
    model,
    customTools: tools,
  });
  return session;
}

/**
 * 安全模式服务主体。
 *
 * 与正常模式的关键差异：
 *  - 只处理私聊，且**只允许管理员 QQ**（安全模式下不应该对公众开放）
 *  - 串行处理：一次只跑一条消息，不搞并发装配
 *  - 定期 touch 心跳，让看门狗知道「安全模式还活着」
 */
export class SafeSentry {
  /**
   * @param {object} opts
   * @param {string} [opts.stateDir]
   * @param {string[]} [opts.adminIds] 允许在安全模式下对话的 QQ 号
   */
  constructor({ stateDir, adminIds = [] } = {}) {
    this.stateDir = stateDir ?? path.join(ROOT, "state");
    this.adminIds = new Set(adminIds.map(String));
    this.bridge = null;
    this.sessions = new Map();
    this.modelRuntime = null;
    this.model = undefined;
    this._hb = null;
    this.busy = Promise.resolve();
  }

  get adminQQ() {
    return String(config.napcat?.qqAccount ?? "");
  }

  /**
   * 从白名单里挑出 admin —— 安全模式也需要知道「谁可以指挥我」。
   *
   * 【为什么要双重来源】
   * whitelist.mjs 只有 106 行、零依赖、纯 JSON 解析，属于「极小且稳定」，
   * 所以允许它进入安全模式的依赖闭包（见 test/safe-closure.test.mjs 的白名单及说明）。
   * 但它仍是白名单解析链路上的一个文件 —— 万一它也坏了，安全模式就会因为
   * 「不知道谁能指挥我」而变成哑巴，那太脆弱了。
   * 因此加一层配置兜底：config.lifecycle.safeAdminIds。
   *   优先用 whitelist（自动跟随权限变更）；
   *   白名单读取失败或其结果为空时，回落到配置里写死的管理员列表。
   */
  static async resolveAdmins() {
    const fromConfig = (config.lifecycle?.safeAdminIds ?? []).map(String).filter(Boolean);
    const out = [];
    try {
      const fs = await import("node:fs");
      const { Whitelist } = await import("../whitelist.mjs");
      const wl = new Whitelist(path.join(ROOT, "whitelist.json"));
      const wlFile = JSON.parse(fs.readFileSync(path.join(ROOT, "whitelist.json"), "utf8"));
      for (const uid of Object.keys(wlFile.users ?? {})) {
        try {
          if (String(wl.presetOf(uid)) === "admin") out.push(String(uid));
        } catch {
          /* 单个用户判定失败不影响其他 */
        }
      }
      if (out.length) return out;
      logSafe.warn("白名单里没有 admin 用户，回落到 config.lifecycle.safeAdminIds");
    } catch (e) {
      logSafe.warn(`读取管理员列表失败（回落到 config.lifecycle.safeAdminIds）: ${e?.message}`);
    }
    return fromConfig;
  }

  async start() {
    // 1) 模型
    this.modelRuntime = await createModelRuntime({ logger: logSafe });
    this.model = resolveModel(this.modelRuntime, { logger: logSafe });
    logSafe.info(`模型: ${this.model?.id ?? "（SDK 自选）"}`);

    // 2) 连接 NapCat（不负责拉起 NapCat —— 它是外部托管的独立进程）
    const nb = config.napcat?.onebot ?? {};
    this.bridge = new QQBridge({ host: nb.wsHost, port: nb.wsPort, token: nb.token });
    await this.bridge.connect();
    logSafe.info("已连接 NapCat");

    // 3) 心跳（证明安全模式本身还活着）
    const interval = Number(config.lifecycle?.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs);
    touchHeartbeat(this.stateDir);
    this._hb = setInterval(() => touchHeartbeat(this.stateDir), interval);
    this._hb.unref?.();

    // 4) 消息处理：只接私聊、只认管理员
    this.bridge.on("message", (ev) => {
      this._onMessage(ev).catch((e) => logSafe.error(`处理消息异常: ${e?.message}`));
    });

    logSafe.info(`安全模式就绪 · 允许的管理员: ${[...this.adminIds].join(", ") || "（未配置，将拒绝所有对话）"}`);
    return this;
  }

  /** 是否允许该用户指挥安全模式 */
  allowed(userId) {
    return this.adminIds.has(String(userId));
  }

  async _onMessage(ev) {
    if (ev?.post_type !== "message") return;
    if (ev.message_type !== "private") return; // 安全模式只接私聊
    const userId = String(ev.user_id);
    if (!this.allowed(userId)) {
      logSafe.warn(`拒绝非管理员 ${userId} 的消息（安全模式仅限管理员）`);
      return;
    }
    const text = QQBridge.extractText(ev.message);
    if (!text?.trim()) return;
    logSafe.info(`<- ${userId}: ${text.slice(0, 80)}`);

    // 串行：安全模式下不搞并发
    this.busy = this.busy.then(() => this._handle(userId, text.trim(), ev)).catch(() => {});
    return this.busy;
  }

  async _handle(userId, text, ev) {
    let session = this.sessions.get(userId);
    try {
      if (!session) {
        session = await createSafeSession({
          modelRuntime: this.modelRuntime,
          model: this.model,
          chatKey: `private-${userId}`,
          onGiveup: (p) => this._giveup(p),
        });
        this.sessions.set(userId, session);
      }
      const t0 = Date.now();
      await session.prompt(text, { streamingBehavior: "followUp" });
      const reply = SafeSentry.lastText(session) || "（安全模式无输出）";
      await this.bridge.sendPrivateMsg(Number(userId), reply);
      logSafe.info(`-> ${userId}: ${reply.slice(0, 80)} · ${Date.now() - t0}ms`);

      // 文本令牌兜底：万一模型没能调用 declare_unfixable 工具，但回复里带出了约定令牌
      const g = detectGiveup(reply);
      if (g.hit) {
        logSafe.warn(`检测到放弃令牌（${g.matched}），触发回退`);
        await this._giveup({ reason: g.reason || "（agent 以文本令牌声明无法修复）", suggestion: "" });
      }
    } catch (e) {
      logSafe.error(`处理失败: ${e?.message}`);
      try {
        await this.bridge.sendPrivateMsg(Number(userId), `（安全模式处理失败：${e?.message}）`);
      } catch {
        /* 连回话都失败就只能记日志了 */
      }
    }
  }

  /**
   * agent 声明「修不好」→ 触发回退。
   * 先记状态与留档（便于事后复盘），再调用纯回退脚本。
   * 幂等：重复调用只执行一次。
   */
  async _giveup({ reason = "", suggestion = "" } = {}) {
    if (this._gaveUp) return { text: "回退已在进行中，无需重复请求。" };
    this._gaveUp = true;
    logSafe.warn(`agent 声明无法修复 → 回退。原因：${reason}`);
    try {
      writeMode(this.stateDir, {
        reason: `安全模式 agent 声明无法修复：${reason}`.slice(0, 300),
        updatedBy: "safe-agent",
      });
      fs.writeFileSync(
        path.join(this.stateDir, "giveup.json"),
        JSON.stringify({ at: new Date().toISOString(), reason, suggestion }, null, 2),
        "utf8"
      );
    } catch (e) {
      logSafe.warn(`记录放弃原因失败: ${e?.message}`);
    }
    if (this.onGiveup) {
      // 测试/嵌入时可注入
      const r = await this.onGiveup({ reason, suggestion });
      return { text: r?.text ?? "已请求回退。" };
    }
    // 先回一条消息，让用户知道正在做什么（回退会把当前进程带走）
    try {
      for (const uid of this.adminIds) {
        await this.bridge?.sendPrivateMsg(Number(uid), `检测到无法修复，正在回退到上一个可用版本…\n原因：${reason.slice(0, 200)}`);
      }
    } catch {
      /* ignore */
    }
    try {
      triggerRollback({ reason });
    } catch (e) {
      logSafe.error(`触发回退失败: ${e?.message}`);
    }
    return { text: "已请求回退到上一个可用版本。" };
  }

  /** 从 session 里取最后一条助手文本 */
  static lastText(session) {
    try {
      const msgs = session?.agent?.state?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== "assistant") continue;
        const content = Array.isArray(m.content) ? m.content : [];
        const t = content
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
        if (t) return t;
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  async stop() {
    if (this._hb) clearInterval(this._hb);
    for (const [, s] of this.sessions) {
      try {
        s.dispose?.();
      } catch {
        /* ignore */
      }
    }
    try {
      this.bridge?.close?.();
    } catch {
      /* ignore */
    }
    // 清掉模式标记的 attempts（安全模式成功运行过，重置计数）
    try {
      writeMode(this.stateDir, { resetAttempts: true });
    } catch {
      /* ignore */
    }
  }
}

/** 安全模式下禁止自伤：拦住会杀掉自己的动作（例如直接 pkill bridge-safe） */
export const SELF_GUARD_NOTE = `注意：安全模式下不要执行 pkill -f bridge-safe —— 那会杀掉你自己。`;

export default { SafeSentry, createSafeSession, SAFE_SYSTEM_PROMPT, FORBIDDEN_TOOLS };
