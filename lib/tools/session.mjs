/**
 * 会话工具 —— 消息发送与聊天历史清理
 *
 * 2026-09 重构：从 lib/piagent.mjs 的 _buildTools 抽出，**逻辑逐字未改**，
 * 只把 4 空格缩进降级为顶层，并改为工厂函数返回工具数组。
 * 权限门禁不在这里做 —— 统一在 lib/tools/index.mjs 的 TOOL_PERM 映射里包一层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pTool } from "../prompts.mjs";
import { levelOf as opLevelOf } from "../op-policy.mjs";
import { SESSIONS_DIR } from "../config.mjs";
import { detectToolLeak } from "../text.mjs";
import { markSent } from "../agent/sent-log.mjs";
import fs from "node:fs";
import path from "node:path";

export function createSessionTools({ me, getCtx }) {
  const tools = [];

  const clearHistory = defineTool({
    name: "clear_history",
    ...pTool("clear_history"),
    parameters: Type.Object({}),
    execute: async (_id, params) => {
      const ctx = getCtx();
      const uid = String(ctx?.userId ?? "");
      if (!uid) return { content: [{ type: "text", text: "（无当前会话上下文）" }], details: {} };
      const lv = opLevelOf(me.white.presetOf(uid));
      if (lv < 2) return { content: [{ type: "text", text: "仅 operator 及以上可清除自己的历史。" }], details: {} };
      // 1) 收集该用户会话文件（private_uid、group_*_uid；不含群共享 group_<gid>.jsonl）
      const files = [];
      try {
        for (const f of fs.readdirSync(SESSIONS_DIR)) {
          if (f === `private_${uid}.jsonl` || (f.startsWith("group_") && f.endsWith(`_${uid}.jsonl`))) files.push(f);
        }
      } catch { /* 目录不存在忽略 */ }
      // 2) 本轮不能立刻 dispose —— 当前这一轮正跑在这个会话上，dispose 会打断生成，
      //    用户收到的就是「模型返回了空内容」（2026-11-05 实测两次）。
      //    改为本轮结束后再拆：先记下要动的会话，8 秒后 dispose + 删文件 + 从内存表摘掉。
      const targets = [];
      for (const [k, entry] of [...me.sessions]) {
        const key = String(k);
        const own = key === `private:${uid}` || (key.startsWith("group:") && key.endsWith(`:${uid}`));
        if (own) targets.push([k, entry]);
      }
      const removed = files.length;
      if (targets.length || removed) {
        const timer = setTimeout(() => {
          for (const [k, entry] of targets) {
            try { entry.session?.dispose?.(); } catch {}
            me.sessions.delete(k);
          }
          for (const f of files) {
            try { fs.rmSync(path.join(SESSIONS_DIR, f), { force: true }); } catch {}
          }
        }, 8000);
        timer.unref?.();
      }
      return { content: [{ type: "text", text: `已安排清除你的聊天历史：本轮结束后约 8 秒删除 ${removed} 个会话文件、重置 ${targets.length} 个内存会话。` }], details: {} };
    },
  });

  const qqSend = defineTool({
    name: "qq_send_message",
    ...pTool("qq_send_message"),
    parameters: Type.Object({
      message: Type.String({ description: "要发送的消息内容" }),
      target: Type.Optional(Type.String({ description: "目标群号或 QQ 号；省略则发当前对话" })),
      chatType: Type.Optional(Type.String({ description: "group（群聊）或 private（私聊）；省略时自动判断" })),
    }),
    execute: async (_id, params) => {
      const ctx = getCtx();
      const msg = String(params.message ?? "");
      if (!msg.trim()) {
        return { content: [{ type: "text", text: "（消息为空，未发送）" }], details: {} };
      }
      // 旁路防护：工具直接发送的消息也检查工具调用 XML 泄漏（防绕过 submit 层检测）
      if (detectToolLeak(msg)) {
        return { content: [{ type: "text", text: "拒绝发送：消息里含工具调用 XML 文本（<…invoke/tool_calls…>），请改写成面向用户的正常文本后再发。" }], details: {} };
      }

      const rawTarget = String(params.target ?? "").trim();
      // 省略 target：仍发当前对话（兼容旧用法，但默认回复走正文，不该再靠它）
      if (!rawTarget) {
        if (!ctx.chatType) {
          return { content: [{ type: "text", text: "（当前无对话上下文，无法发送）" }], details: {} };
        }
        if (ctx.chatType === "group") {
          await me.bridge.sendGroupMsg(Number(ctx.targetId), msg);
        } else {
          await me.bridge.sendPrivateMsg(Number(ctx.targetId), msg);
        }
        // 记录本轮已通过工具发送的内容（供 TurnAssembler 余弦去重判定）
        markSent(msg);
        return { content: [{ type: "text", text: "消息已发送。" }], details: {} };
      }

      // 跨会话发送：仅管理员（否则任何访客都能拿 bot 当骚扰工具）
      const lv = opLevelOf(me.white.presetOf(String(ctx?.userId ?? "")));
      if (lv < 3) {
        return { content: [{ type: "text", text: "仅管理员能往别的群/会话发消息。" }], details: {} };
      }
      const num = rawTarget.replace(/^(group|private|qq|g)\s*[:：]?\s*/i, "");
      if (!/^\d{5,12}$/.test(num)) {
        return { content: [{ type: "text", text: `目标无效：「${rawTarget}」应为群号或 QQ 号` }], details: {} };
      }
      let kind = String(params.chatType ?? "").trim().toLowerCase();
      if (kind !== "group" && kind !== "private") {
        // 自动判断：在群列表里就是群，否则按 QQ 号发私聊
        try {
          const groups = await me.bridge.getGroupList();
          kind = (Array.isArray(groups) ? groups : []).some((g) => String(g?.group_id) === num) ? "group" : "private";
        } catch {
          kind = "private";
        }
      }
      try {
        if (kind === "group") await me.bridge.sendGroupMsg(Number(num), msg);
        else await me.bridge.sendPrivateMsg(Number(num), msg);
      } catch (e) {
        return { content: [{ type: "text", text: `发送失败：${e?.message ?? e}` }], details: {} };
      }
      return { content: [{ type: "text", text: `已发送到${kind === "group" ? "群" : "私聊"} ${num}。` }], details: {} };
    },
  });

  tools.push(qqSend, clearHistory);
  return tools;
}

export default createSessionTools;
