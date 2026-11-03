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
import { markPendingSub } from "../restart-resume.mjs";
import { buildTrigger } from "../trigger.mjs";
import { SESSIONS_DIR } from "../config.mjs";

export function createSubagentTools({ me, perms, getCtx }) {
  const tools = [];

  const runTask = defineTool({
    name: "run_task",
    ...pTool("run_task"),
    parameters: Type.Object({
      task: Type.String({ description: "要交给子 agent 完成的任务描述（明确目标与输出要求）" }),
      timeout: Type.Number({ description: "超时秒数（必填）——必须显式指定；上限由 config.pi.subagentMaxTimeoutSec 控制（默认 1800 秒）" }),
    }),
    execute: async (_id, params) => {
      // 纯异步：启动子任务后**立即返回 taskId 并结束本回合**。
      //
      // 【为什么不需要（也不应该）轮询】
      // 子任务结束时由 lib/piagent.mjs 的 _wakeSubDone() 主动把结果作为一轮新消息
      // 唤醒主 agent（空闲→开新回合，忙碌→steer 注入当前回合并被感知）。
      // 因此本工具的语义是「派发即离开」，主 agent 不必（也不该）用 subagent_result 反复查。
      const tid = "sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      me._subAbort = new AbortController();
      const sig = me._subAbort.signal;
      // 记录发起者权限：决定子代理能否走 Windows / 是否用 Linux 沙箱（防逃逸）
      const ownerId = getCtx()?.userId ?? "";
      // 唤醒用上下文：本回合的会话信息。**必须在派发时快照**——
      // 子任务结束时早已脱离本回合的 ALS 作用域，那时再取 getCtx() 只会拿到 null。
      const c0 = getCtx() ?? {};
      const wakeCtx = {
        chatKey: c0.chatKey ?? null,
        chatType: c0.chatType ?? "private",
        targetId: c0.targetId ?? null,
        selfId: c0.selfId ?? null,
        userName: c0.userName ?? null,
        userId: ownerId,
      };
      const task = {
        id: tid, status: "pending", reply: "", error: "", startedAt: Date.now(),
        session: null, unsub: null, sig, mainSession: null,
        ownerPerms: me.white.perms(ownerId), ownerUserId: ownerId,
        wakeCtx,          // 完成唤醒用的会话上下文快照
        woken: false,     // 幂等标记：保证一个子任务只唤醒一次
        timeoutSec: Number(params.timeout || 30),
        winTimer: null,
      };
      // 记录发起任务的主 agent 会话（供 subagent 主动汇报时注入主 agent 上下文）
      const mainEntry = me.sessions?.get(c0.currentSessionKey ?? c0.chatKey);
      task.mainSession = mainEntry?.session ?? null;
      me._subTasks.set(tid, task);
      // 【重启可恢复】把 pending 记录落盘。
      // _subTasks 是纯内存 Map，进程一重启就全丢 —— 于是「子任务跑到一半遇到重启」
      // 会变成静默中断：主 agent 永远等不到通知，一直干等。
      // 启动时读这个文件，剩下的就是被重启打断的，会主动通知发起会话。
      try {
        markPendingSub(SESSIONS_DIR, {
          taskId: tid,
          chatKey: wakeCtx.chatKey,
          chatType: wakeCtx.chatType,
          targetId: wakeCtx.targetId,
          selfId: wakeCtx.selfId,
          userName: wakeCtx.userName,
          userId: ownerId,
          snippet: String(params.task).slice(0, 200),
        });
      } catch { /* 落盘失败不影响派发 */ }
      // 【工单化】派发前先过闸门、建工单、拿槽位（借鉴 dsh-superagent 的
      // Ticket / Assignment / worker slot）。工单落盘后，重启也能知道「跑到哪了」，
      // 而不是只剩一个内存里的 taskId。
      let ticketNote = "";
      let queued = false;
      const rt = me.tickets;
      if (rt) {
        const trg = buildTrigger({
          id: `qq-task-${tid}`,
          chatType: wakeCtx.chatType,
          chatId: wakeCtx.targetId,
          userId: ownerId,
          userName: wakeCtx.userName,
          text: String(params.task),
          mentionsMe: true,          // run_task 是人当面点的活，等于明确请求
        });
        const acc = rt.acceptFromTrigger(trg, { title: String(params.task).slice(0, 60) });
        if (!acc.accepted) {
          return { content: [{ type: "text", text: `派发被授权闸门拒绝：${acc.verdict.reason}（模式 ${rt.policy.mode}）` }], details: {} };
        }
        if (acc.shadow) {
          return { content: [{ type: "text", text: `已记为影子工单 ${acc.ticket.id}（observe 模式：只记录，不执行）` }], details: {} };
        }
        task.ticketId = acc.ticket.id;
        // 记进本轮的 Router 决策上下文：这一轮被判定为「接单并派活」
        try {
          const tr = me._turnRouter?.get(wakeCtx.chatKey);
          if (tr) { tr.tickets.push(acc.ticket.id); tr.action = "accept"; tr.reason = "dispatch"; }
        } catch { /* 记账失败不影响派发 */ }
        const st = rt.start(acc.ticket.id, () => me._startSubAsync(task, String(params.task), Number(params.timeout || 30)));
        queued = st.queued;
        ticketNote = queued
          ? `\n工单 ${acc.ticket.id} 已排队（前面还有 ${st.ahead} 个），空出槽位会自动开跑。`
          : `\n工单 ${acc.ticket.id} 已建档，占用一个工作槽。`;
      } else {
        me._startSubAsync(task, String(params.task), Number(params.timeout || 30));
      }
      return {
        content: [{
          type: "text",
          text: `【子任务已启动】taskId=${tid}${ticketNote}\n子任务在后台运行；**完成/失败/超时/中止时会自动通知你并唤醒你继续处理，无需轮询**。\n现在可以结束本回合。若需要中途补充指令用 subagent_send；确需查看中间输出才用 subagent_result。`,
        }],
        details: {},
      };
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

  // 工单查询：让模型能看见"现在有哪些活在跑、卡在谁那儿"
  const ticketList = defineTool({
    name: "ticket_list",
    description: "列出当前工单（= 每次 run_task 的生命周期）：阶段、是否需要人处理、最近一次汇报。live=true 只看未结束的。",
    parameters: Type.Object({
      live: Type.Optional(Type.Boolean({ description: "只看未结束的工单（默认 false = 全部）" })),
    }),
    execute: async (_id, params) => {
      const rt = me.tickets;
      if (!rt) return { content: [{ type: "text", text: "工单运行时未启用。" }], details: {} };
      const rows = rt.list({ live: !!params.live });
      if (!rows.length) return { content: [{ type: "text", text: "没有工单。" }], details: {} };
      const lines = rows.slice(-20).map((r) => {
        const st = r.stage === "person" ? `待处理·${r.action}` : (r.action === "queued" ? "排队中" : r.stage);
        const need = r.needs ? ` | 需要：${r.needs}` : "";
        return `· ${r.id} 【${r.title}】${st}${r.shadow ? "（影子）" : ""}${need}`;
      });
      const sn = rt.slots.snapshot();
      return {
        content: [{ type: "text", text: `工单 ${rows.length} 条（槽位 ${sn.holders.length}/${sn.limit}，排队 ${sn.queued}）：\n${lines.join("\n")}` }],
        details: {},
      };
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
      const live = status === "pending" || status === "running";
      const tip = live ? `\n\n（子任务仍在运行；**无需反复查询**——完成/失败后会自动唤醒你。）` : "";
      if (status === "failed" && t.error) return { content: [{ type: "text", text: `子任务 ${params.taskId} 失败：${t.error}\n部分输出：${out || "（无）"}${tip}` }], details: { status } };
      return { content: [{ type: "text", text: `【子任务 ${params.taskId} · ${status}】\n${out || "（暂无输出）"}${tip}` }], details: { status } };
    },
  });

  tools.push(runTask, subagentSend, subagentResult);
  tools.push(ticketList);
  return tools;
}

export default createSubagentTools;
