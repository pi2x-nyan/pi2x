/**
 * 提醒工具 —— 定时提醒落库，由 cron 投递（不依赖对话进程存活）
 *
 * 2026-09 重构：从 lib/piagent.mjs 的 _buildTools 抽出，**逻辑逐字未改**，
 * 只把 4 空格缩进降级为顶层，并改为工厂函数返回工具数组。
 * 权限门禁不在这里做 —— 统一在 lib/tools/index.mjs 的 TOOL_PERM 映射里包一层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pTool } from "../prompts.mjs";
import { addReminder, listReminders as listRems, cancelReminder, fmtTime } from "../reminders.mjs";

export function createReminderTools({ me, getCtx, isFullSource }) {
  const tools = [];

  const setReminder = defineTool({
    name: "set_reminder",
    ...pTool("set_reminder"),
    parameters: Type.Object({
      text: Type.String({ description: "提醒正文（到点要发给用户的那句话，写清楚要做什么）" }),
      at: Type.Optional(Type.String({ description: "触发时间：\"2026-09-14 16:00\"（本地）/\"+90m\" / \"+2h\" / \"+3d\" / ISO" })),
      inMinutes: Type.Optional(Type.Number({ description: "相对分钟数（与 at 二选一）" })),
      repeatMinutes: Type.Optional(Type.Number({ description: "周期提醒间隔分钟（每天=1440）" })),
      until: Type.Optional(Type.String({ description: "周期提醒截止时间，格式同 at" })),
      chat: Type.Optional(Type.String({ description: "private 私聊（默认）/ group 群聊" })),
      target: Type.Optional(Type.String({ description: "发送对象 QQ 号/群号；默认当前会话" })),
    }),
    execute: async (_id, params) => {
      const ctx = getCtx();
      if (!ctx.chatType && !params.target) {
        return { content: [{ type: "text", text: "（当前无对话上下文，且未指定 target）" }], details: {} };
      }
      // 越权防护：非 admin 只能把提醒发回当前会话（不得指定任意他人）
      let target = params.target;
      let chat = params.chat === "group" ? "group" : "private";
      if (!isFullSource) {
        chat = ctx.chatType === "group" ? "group" : "private";
        target = String(ctx.targetId ?? "");
      }
      if (!target) target = String(ctx.targetId ?? "");
      if (params.at === undefined && params.inMinutes === undefined) {
        return { content: [{ type: "text", text: "请给出触发时间（at 或 inMinutes）。" }], details: {} };
      }
      try {
        const it = addReminder({
          text: params.text,
          at: params.at,
          inMinutes: params.inMinutes,
          repeatMinutes: params.repeatMinutes,
          until: params.until,
          target,
          chat,
          source: `${ctx.chatType ?? "private"}:${ctx.userId ?? ""}`,
        });
        const rep = it.repeatMinutes ? `，每 ${it.repeatMinutes >= 1440 ? `${it.repeatMinutes / 1440} 天` : `${it.repeatMinutes} 分钟`}重复` : "";
        const end = it.until ? `（截止 ${fmtTime(it.until)}）` : "";
        return {
          content: [{ type: "text", text: `已设置提醒 ${it.id}：${fmtTime(it.fireAt)}${rep}${end} → ${chat === "group" ? "群" : "私聊"} ${target}\n内容：${it.text}` }],
          details: { id: it.id, fireAt: it.fireAt },
        };
      } catch (e) {
        return { content: [{ type: "text", text: `设置提醒失败: ${e?.message}` }], details: {} };
      }
    },
  });

  const listReminders = defineTool({
    name: "list_reminders",
    ...pTool("list_reminders"),
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "list 待触发（默认）/ list_all 含已完成 / cancel 取消" })),
      id: Type.Optional(Type.String({ description: "cancel 时的提醒 id（或前缀；all 表示全部）" })),
    }),
    execute: async (_id, params) => {
      const ctx = getCtx();
      const action = String(params.action ?? "list").toLowerCase();
      try {
        if (action === "cancel" || action === "rm") {
          if (!params.id) return { content: [{ type: "text", text: "请给出要取消的提醒 id（或用 list 先查看）。" }], details: {} };
          const r = cancelReminder(String(params.id));
          return { content: [{ type: "text", text: r.removed ? `已取消 ${r.removed} 条提醒。` : "未找到匹配的提醒。" }], details: {} };
        }
        const all = action === "list_all" || action === "all";
        let items = listRems({ all });
        // 非 admin 只看自己会话相关的提醒
        if (!isFullSource) {
          const me0 = String(ctx.targetId ?? "");
          items = items.filter((r) => String(r.target) === me0);
        }
        if (!items.length) return { content: [{ type: "text", text: all ? "（当前没有任何提醒）" : "（当前没有待触发的提醒）" }], details: {} };
        const lines = items.map((r) => {
          const rep = r.repeatMinutes ? `｜每 ${r.repeatMinutes >= 1440 ? `${r.repeatMinutes / 1440} 天` : `${r.repeatMinutes} 分钟`}` : "";
          const end = r.until ? `｜截止 ${fmtTime(r.until)}` : "";
          return `${r.done ? "[已完成]" : "[待触发]"} ${r.id}｜${fmtTime(r.fireAt)}${rep}${end}｜${r.chat === "group" ? "群" : "私聊"} ${r.target}\n    ${r.text}`;
        });
        return { content: [{ type: "text", text: `共 ${items.length} 条：\n` + lines.join("\n") }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `操作失败: ${e?.message}` }], details: {} };
      }
    },
  });

  tools.push(setReminder, listReminders);
  return tools;
}

export default createReminderTools;
