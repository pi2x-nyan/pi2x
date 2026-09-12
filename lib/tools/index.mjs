/**
 * 工具装配总入口 —— 声明式注册表 + 运行时权限门禁
 *
 * 【职责】
 *  1. 按域调用各 createXxxTools() 收集工具；
 *  2. 用 TOOL_PERM 映射给每个工具包一层「运行时权限门禁」：
 *     权限不足时不抛异常，而是把一个「越权」结果交回给模型，让它自己兜底解释。
 *  3. 决定哪些工具在当前部署下可用（如 winShell 未配置就不挂 Windows 工具）。
 *
 * 【设计约定】
 *  · **不做静态裁剪**：工具全量暴露给模型，权限在调用时审查。
 *    理由：静态裁剪会让模型"不知道自己不知道什么"，容易编造能力；运行时拒绝更可解释。
 *  · **新增工具**：在 lib/tools/<域>.mjs 里加定义 → 在下面 ORDER 里登记 → 在 TOOL_PERM 里
 *    声明所需权限 token（null = 所有会话可用）。漏登记会被 test/tools-registry.test.mjs 抓到。
 */
import { createMemoryTools } from "./memory.mjs";
import { createReminderTools } from "./reminders.mjs";
import { createSessionTools } from "./session.mjs";
import { createWindowsTools } from "./windows.mjs";
import { createSubagentTools } from "./subagent.mjs";
import { createCredentialTools } from "./credentials.mjs";
import { createMessagingTools } from "./messaging.mjs";
import { config } from "../config.mjs";
import { createLogger } from "../log.mjs";
import { getTurnCtx } from "../turn-context.mjs";

const logTool = createLogger("tool");

/**
 * 工具 → 所需权限 token（null / 未声明 = 所有会话可用）。
 *
 * 注：表里保留了若干**当前不在本模块定义**的条目（group_history / msg_detail / …）。
 * 那些能力走 qq-cli 脚本的渐进披露路径，不注册为 pi 工具；保留映射是为了：
 *  · 文档意义上标明它们同属"非核心能力"；
 *  · 将来若把它们重新注册为工具，门禁即刻生效，不会忘记加权限。
 */
export const TOOL_PERM = Object.freeze({
  // —— 本模块实际注册的工具 ——
  search_memories: "memory.search",
  save_memory: "memory.save",
  delete_memory: "memory.delete",
  windows_shell_status: "tools.windows_shell",
  windows_shell: "tools.windows_shell",
  win_file_get: "tools.win_file_get",
  win_file_put: "tools.win_file_put",
  qq_send_file: "tools.qq_send_file",
  run_task: "tools.run_task",
  clear_history: "tools.clear_history",
  subagent_send: "tools.subagent_send",
  subagent_result: "tools.subagent_result",
  qq_send_message: null, // 所有会话可用（回复通道）
  set_reminder: null, // 所有会话可用（记忆型功能，不做权限区分）
  list_reminders: null, // 同上
  get_credential: null, // 内部自查 files:full（见 credentials.mjs）
  save_credential: null, // 同上

  // —— 预留：由 qq-cli 脚本渐进披露，暂不注册为 pi 工具 ——
  group_history: "tools.group_history",
  msg_detail: "tools.get_msg",
  friend_list: "tools.friend_list",
  group_list: "tools.group_list",
  ocr_image: "tools.ocr",
  group_file_url: "tools.group_file",
  download_file: "tools.download",
  delete_msg: "tools.delete_msg",
  napcat_call: "tools.napcat",
  op: "tools.op",
  deop: "tools.op",
});

/**
 * 工具在提示词中的暴露顺序（保持重构前的原顺序：回复通道在前，运维类在后）。
 * 每个 createXxxTools() 产出的工具必须出现在这里，否则会被静默丢弃 ——
 * test/tools-registry.test.mjs 会据此报错。
 */
export const ORDER = Object.freeze([
  "qq_send_message",
  "save_memory",
  "delete_memory",
  "search_memories",
  "set_reminder",
  "list_reminders",
  "clear_history",
  "run_task",
  "subagent_send",
  "subagent_result",
  "get_credential",
  "save_credential",
  "win_file_get",
  "win_file_put",
  "windows_shell_status",
  "windows_shell",
  "qq_send_file",
]);

/** 工具耗时超过该值才记日志（避免高频小工具刷屏；可用 config.pi.slowToolMs 调整） */
// 默认值见 lib/config.mjs 的 DEFAULTS.pi.slowToolMs（单一数据源，此处不再重复写死）

/** 包装：给单个工具装上运行时权限门禁 + 慢调用计时 */
function withGuard(tool, required, guard) {
  const orig = tool.execute;
  const slowMs = Number(config.pi.slowToolMs);
  return {
    ...tool,
    execute: async (id, params, ctx, raw) => {
      if (required != null) {
        const denied = guard(required, tool.name);
        if (denied) return denied;
      }
      const t0 = Date.now();
      try {
        return await orig(id, params, ctx, raw);
      } finally {
        // 只记慢调用：正常快工具不刷屏，慢工具一眼可见（排查「为什么这轮这么久」的关键）
        const ms = Date.now() - t0;
        if (Number.isFinite(slowMs) && ms >= slowMs) logTool.info(`${tool.name} 用时 ${ms}ms`);
      }
    },
  };
}

/**
 * 装配当前用户/会话的工具集。
 *
 * @param {object} p
 * @param {any} p.me        PiAgent 实例（工具内部需要访问 memory/bridge/sessions 等）
 * @param {Set<string>} p.perms 权限 token 集合
 * @param {string} p.userId 当前用户 QQ 号
 * @returns {Array<any>} 工具数组
 */
export function buildTools({ me, perms, userId }) {
  /**
   * 取当前回合上下文。
   *
   * **优先 AsyncLocalStorage**（本轮的准确上下文），`me.ctx` 仅作回合外兜底。
   * 原因见 lib/turn-context.mjs：me.ctx 是实例单例，并发会话会互相覆盖，
   * 曾导致「消息发进别人的会话 / 私聊记忆写进群共享」这类隐私问题。
   */
  const getCtx = () => getTurnCtx() ?? me.ctx;
  const isFullSource = perms.has("files:full"); // 全权（admin）才显示来源明细

  /** 运行时权限门禁：模型调用工具时审查权限，不足则返回「越权」给 agent 自行兜底
   * @param {string} perm 所需权限 token
   * @param {string} label 工具名
   * @returns {{content:Array}|null} null=通过；否则返回越权结果 */
  const guard = (perm, label) => {
    if (perms.has(perm)) return null;
    return {
      content: [{ type: "text", text: `权限不足：${label} 需要「${perm}」，你当前没有该权限，已拒绝。可提示联系管理员开通。` }],
      details: { unauthorized: true, required: perm },
    };
  };

  const deps = { me, perms, userId, getCtx, isFullSource, guard };
  const collected = [];

  collected.push(...createSessionTools(deps));
  collected.push(...createMemoryTools(deps));
  collected.push(...createReminderTools(deps));
  collected.push(...createSubagentTools(deps));

  if (perms.has("files:full")) collected.push(...createCredentialTools(deps)); // 凭据解密/保存：仅 admin

  const ws = config.winShell ?? {};
  const wsOk = !!(ws.enabled && ws.host && ws.port && ws.token);
  if (wsOk) {
    collected.push(...createWindowsTools(deps));
    collected.push(...createMessagingTools(deps));
  }

  const byName = new Map(collected.map((t) => [t.name, t]));
  const tools = ORDER.filter((n) => byName.has(n)).map((n) => byName.get(n));

  return tools.map((t) => withGuard(t, TOOL_PERM[t.name], guard));
}

export default buildTools;
