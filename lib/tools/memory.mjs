/**
 * 记忆工具 —— 保存 / 删除 / 检索长期记忆
 *
 * 2026-09 重构：从 lib/piagent.mjs 的 _buildTools 抽出，**逻辑逐字未改**，
 * 只把 4 空格缩进降级为顶层，并改为工厂函数返回工具数组。
 * 权限门禁不在这里做 —— 统一在 lib/tools/index.mjs 的 TOOL_PERM 映射里包一层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pTool } from "../prompts.mjs";
import { config } from "../config.mjs";
import { memorySourceOf } from "../memory-source.mjs";

export function createMemoryTools({ me, perms, getCtx, isFullSource }) {
  const tools = [];

  const saveMemory = defineTool({
    name: "save_memory",
    ...pTool("save_memory"),
    parameters: Type.Object({
      content: Type.String({ description: "要永久记住的内容（事实/偏好/承诺等）" }),
      type: Type.Optional(Type.String({ description: "类型：fact(事实)|pref(偏好)|promise(承诺)|event(事件)，默认 fact" })),
      global: Type.Optional(Type.Boolean({ description: "是否设为全局常驻记忆（仅管理员；每次会话都会注入）" })),
    }),
    execute: async (_id, params) => {
      if (!me.memory) return { content: [{ type: "text", text: "（记忆系统未启用）" }], details: {} };
      const uid = getCtx()?.userId ?? "";
      if (params.global && !me.white.perms(uid).has("files:full")) {
        return { content: [{ type: "text", text: "全局常驻记忆仅管理员可设置。" }], details: {} };
      }
      const source = memorySourceOf(getCtx()) ?? `private:${uid}`;
      const r = await me.memory.remember({
        content: String(params.content ?? ""),
        type: params.type,
        source,
        pinned: true,
        global: !!params.global,
      });
      if (r.ok) {
        return { content: [{ type: "text", text: `已永久记住${r.global ? "（全局常驻）" : "（pinned 不淘汰）"}：${String(params.content).slice(0, 120)}` }], details: {} };
      }
      return { content: [{ type: "text", text: `记忆保存失败：${r.error ?? "未知"}` }], details: {} };
    },
  });

  const deleteMemory = defineTool({
    name: "delete_memory",
    ...pTool("delete_memory"),
    parameters: Type.Object({
      id: Type.String({ description: "要删除的记忆条目 id（search_memories 返回的 id）" }),
    }),
    execute: async (_id, params) => {
      if (!me.memory) return { content: [{ type: "text", text: "（记忆系统未启用）" }], details: {} };
      const uid = getCtx()?.userId ?? "";
      const isAdmin = me.white.perms(uid).has("files:full");
      // 非 admin：只能删除自己来源（私聊本人 / 当前群）的记忆
      const source = isAdmin ? null : (memorySourceOf(getCtx()) ?? `private:${uid}`);
      const n = me.memory.deleteById(String(params.id ?? ""), source);
      if (n === -1) return { content: [{ type: "text", text: "无权删除：该记忆不属于当前用户/群。" }], details: { unauthorized: true } };
      return { content: [{ type: "text", text: n ? `已删除记忆 ${params.id}` : `未找到记忆 ${params.id}` }], details: {} };
    },
  });

  const searchMemories = defineTool({
    name: "search_memories",
    ...pTool("search_memories"),
    parameters: Type.Object({
      keyword: Type.Optional(Type.String({ description: "关键词（语义+字面匹配），如：咖啡" })),
      timeFrom: Type.Optional(Type.String({ description: "起始时间（ISO 或 YYYY-MM-DD），如 2026-08-01" })),
      timeTo: Type.Optional(Type.String({ description: "结束时间（ISO 或 YYYY-MM-DD）" })),
      source: Type.Optional(Type.String({ description: "来源过滤，如 private:1000000001 / group: / seed" })),
      type: Type.Optional(Type.String({ description: "类型过滤：pref|fact|promise|event" })),
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 10，上限 30" })),
    }),
    execute: async (_id, params) => {
      if (!me.memory) return { content: [{ type: "text", text: "（记忆系统未启用）" }], details: {} };
      const ctx = getCtx();
      // 越权防护：非 admin（无 files:full）只能查自己的记忆，强制 source = chatType:userId
      let source = params.source;
      if (!isFullSource) {
        source = `${ctx.chatType ?? "private"}:${ctx.userId}`;
      }
      try {
        const rows = await me.memory.search({
          keyword: params.keyword,
          timeFrom: params.timeFrom,
          timeTo: params.timeTo,
          source,
          type: params.type,
          limit: params.limit ?? config.tools.searchLimitDefault,
          chatType: ctx.chatType ?? "private",
          markUsed: true,
  });
        if (!rows.length) {
          return { content: [{ type: "text", text: "（没有找到匹配的记忆）" }], details: {} };
        }
        const lines = rows.map((r) => {
          const t = new Date(r.ts).toISOString().slice(0, 16).replace("T", " ");
          const src = isFullSource ? ` [${r.source}]` : "";
          return `- [${r.type} · ${t}]${src} ${r.content}`;
        });
        return { content: [{ type: "text", text: `找到 ${rows.length} 条：\n` + lines.join("\n") }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `查询失败: ${e?.message}` }], details: {} };
      }
    },
  });

  tools.push(saveMemory, deleteMemory, searchMemories);
  return tools;
}

export default createMemoryTools;
