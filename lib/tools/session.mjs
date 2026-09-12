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
      // 2) 内存 entry dispose + 移除（该用户才会话）
      let mem = 0;
      for (const [k, entry] of [...me.sessions]) {
        const key = String(k);
        const own = key === `private:${uid}` || (key.startsWith("group:") && key.endsWith(`:${uid}`));
        if (own) {
          try { entry.session?.dispose?.(); } catch {}
          me.sessions.delete(k);
          mem++;
        }
      }
      // 3) 删文件
      let removed = 0;
      for (const f of files) {
        try { fs.rmSync(path.join(SESSIONS_DIR, f), { force: true }); removed++; } catch {}
      }
      return { content: [{ type: "text", text: `已清除你的聊天历史：删除 ${removed} 个会话文件，重置 ${mem} 个内存会话。之后将从全新会话开始。` }], details: {} };
    },
  });

  const qqSend = defineTool({
    name: "qq_send_message",
    ...pTool("qq_send_message"),
    parameters: Type.Object({
      message: Type.String({ description: "要发送的消息内容" }),
    }),
    execute: async (_id, params) => {
      const ctx = getCtx();
      if (!ctx.chatType) {
        return { content: [{ type: "text", text: "（当前无对话上下文，无法发送）" }], details: {} };
      }
      // 旁路防护：工具直接发送的消息也检查工具调用 XML 泄漏（防绕过 submit 层检测）
      if (detectToolLeak(String(params.message || ""))) {
        return { content: [{ type: "text", text: "拒绝发送：消息里含工具调用 XML 文本（<…invoke/tool_calls…>），请改写成面向用户的正常文本后再发。" }], details: {} };
      }
      if (ctx.chatType === "group") {
        await me.bridge.sendGroupMsg(Number(ctx.targetId), params.message);
      } else {
        await me.bridge.sendPrivateMsg(Number(ctx.targetId), params.message);
      }
      // 记录本轮已通过工具发送的内容（供 TurnAssembler 余弦去重判定）
      markSent(params.message);
      return { content: [{ type: "text", text: "消息已发送。" }], details: {} };
    },
  });

  tools.push(qqSend, clearHistory);
  return tools;
}

export default createSessionTools;
