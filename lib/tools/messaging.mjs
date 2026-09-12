/**
 * 文件发送工具 —— 向当前 QQ 会话发送文件
 *
 * 2026-09 重构：从 lib/piagent.mjs 的 _buildTools 抽出，**逻辑逐字未改**，
 * 只把 4 空格缩进降级为顶层，并改为工厂函数返回工具数组。
 * 权限门禁不在这里做 —— 统一在 lib/tools/index.mjs 的 TOOL_PERM 映射里包一层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pTool } from "../prompts.mjs";
import { WORKSPACE } from "../config.mjs";
import fs from "node:fs";
import path from "node:path";

export function createMessagingTools({ me, getCtx }) {
  const tools = [];

  const qqSendFile = defineTool({
    name: "qq_send_file",
    ...pTool("qq_send_file"),
    parameters: Type.Object({
      path: Type.String({ description: "要发送的文件绝对路径" }),
      filename: Type.Optional(Type.String({ description: "发送时显示的文件名（可选）" })),
    }),
    execute: async (_id, params) => {
      const ctx = getCtx();
      try {
        if (!fs.existsSync(params.path)) {
          return { content: [{ type: "text", text: `文件不存在: ${params.path}（可先用 ls/read 确认路径）` }], details: {} };
        }
        // 非 admin（operator 等）：仅能发送沙盒/shared 内文件（防越权发系统文件）；admin 任意
        const uid = getCtx()?.userId ?? "";
        if (!me.white.perms(uid).has("files:full")) {
          const pms = me.white.perms(uid);
          const sbx = path.resolve(me._sessionCwd(uid, pms));
          const shr = path.resolve(path.join(WORKSPACE, "shared"));
          const rp = path.resolve(String(params.path));
          const inDir = (base) => rp === base || rp.startsWith(base + path.sep);
          if (!inDir(sbx) && !inDir(shr)) {
            return { content: [{ type: "text", text: "拒绝：仅能发送沙盒或 shared 目录内的文件。" }], details: { unauthorized: true } };
          }
        }
        const stat = fs.statSync(params.path);
        if (stat.isDirectory()) {
          return { content: [{ type: "text", text: "该路径是目录，请指定文件" }], details: {} };
        }
        const name = params.filename || path.basename(params.path);
        if (!ctx.chatType) {
          return { content: [{ type: "text", text: "（当前无对话上下文，无法发送）" }], details: {} };
        }
        if (ctx.chatType === "group") {
          await me.bridge.uploadGroupFile(Number(ctx.targetId), params.path, name);
        } else {
          await me.bridge.uploadPrivateFile(Number(ctx.targetId), params.path, name);
        }
        return { content: [{ type: "text", text: `文件已发送：${name}（${stat.size} 字节）` }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `发送失败: ${e?.message}` }], details: {} };
      }
    },
      });

  tools.push(qqSendFile);
  return tools;
}

export default createMessagingTools;
