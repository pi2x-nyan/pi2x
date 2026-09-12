/**
 * 子代理工具 —— 把复杂任务委派给独立子代理异步执行
 *
 * 2026-09 重构：从 lib/piagent.mjs 的 _buildTools 抽出，**逻辑逐字未改**，
 * 只把 4 空格缩进降级为顶层，并改为工厂函数返回工具数组。
 * 权限门禁不在这里做 —— 统一在 lib/tools/index.mjs 的 TOOL_PERM 映射里包一层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pTool } from "../prompts.mjs";
import { config } from "../config.mjs";

export function createSubagentTools({ me, perms, getCtx }) {
  const tools = [];

  const runTask = defineTool({
    name: "run_task",
    ...pTool("run_task"),
    parameters: Type.Object({
      task: Type.String({ description: "要交给子 agent 完成的任务描述（明确目标与输出要求）" }),
      timeout: Type.Number({ description: "超时秒数（必填，上限 600）——必须显式指定" }),
    }),
    execute: async (_id, params) => {
      // 纯异步：启动子任务后立即返回 taskId。主 agent 可继续其他工作，随时用 subagent_send 插话、subagent_result 取结果。
      const tid = "sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      me._subAbort = new AbortController();
      const sig = me._subAbort.signal;
      // 记录发起者权限：决定子代理能否走 Windows / 是否用 Linux 沙箱（防逃逸）
      const ownerId = getCtx()?.userId ?? "";
      const task = { id: tid, status: "pending", reply: "", error: "", startedAt: Date.now(), session: null, unsub: null, sig, mainSession: null, ownerPerms: me.white.perms(ownerId), ownerUserId: ownerId };
      // 记录发起任务的主 agent 会话（供 subagent 主动汇报时注入主 agent 上下文）
      const mainEntry = me.sessions?.get(getCtx()?.currentSessionKey ?? getCtx()?.chatKey);
      task.mainSession = mainEntry?.session ?? null;
      me._subTasks.set(tid, task);
      me._startSubAsync(task, String(params.task), Number(params.timeout || 30));
      return { content: [{ type: "text", text: `【子任务已启动】taskId=${tid}\n可用 subagent_send 给此任务插话、subagent_result 取结果/状态。` }], details: {} };
    },
  });

  const subagentSend = defineTool({
    name: "subagent_send",
    ...pTool("subagent_send"),
    parameters: Type.Object({
      taskId: Type.String({ description: "run_task 返回的 taskId" }),
      message: Type.String({ description: "要插话/补充的指令或消息" }),
    }),
    execute: async (_id, params) => {
      const t = me._subTasks.get(String(params.taskId));
      if (!t) return { content: [{ type: "text", text: `子任务 ${params.taskId} 不存在或已结束。` }], details: {} };
      if (t.status !== "pending" && t.status !== "running") return { content: [{ type: "text", text: `子任务 ${params.taskId} 已结束（${t.status}），无法插话。` }], details: {} };
      try {
        await me._subSteer(t, String(params.message));
        return { content: [{ type: "text", text: `已向 ${params.taskId} 插话。` }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `插话失败: ${e?.message}` }], details: {} };
      }
    },
  });

  const subagentResult = defineTool({
    name: "subagent_result",
    ...pTool("subagent_result"),
    parameters: Type.Object({
      taskId: Type.String({ description: "run_task 返回的 taskId" }),
      limit: Type.Optional(Type.Number({ description: "返回文本上限，默认 3000" })),
    }),
    execute: async (_id, params) => {
      const t = me._subTasks.get(String(params.taskId));
      if (!t) return { content: [{ type: "text", text: `子任务 ${params.taskId} 不存在。` }], details: {} };
      const cap = Math.min(Math.max(Number(params.limit ?? config.tools.resultDefaultChars), config.tools.resultMinChars), config.tools.resultMaxChars);
      const out = String(t.reply || "").slice(0, cap);
      const status = t.status;
      if (status === "failed" && t.error) return { content: [{ type: "text", text: `子任务 ${params.taskId} 失败：${t.error}\n部分输出：${out || "（无）"}` }], details: { status } };
      return { content: [{ type: "text", text: `【子任务 ${params.taskId} · ${status}】\n${out || "（暂无输出）"}` }], details: { status } };
    },
  });

  tools.push(runTask, subagentSend, subagentResult);
  return tools;
}

export default createSubagentTools;
