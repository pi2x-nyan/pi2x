/**
 * 凭据工具 —— 加密存取网站账号密码 / API token（仅管理员）
 *
 * 2026-09 重构：从 lib/piagent.mjs 的 _buildTools 抽出，**逻辑逐字未改**，
 * 只把 4 空格缩进降级为顶层，并改为工厂函数返回工具数组。
 * 权限门禁不在这里做 —— 统一在 lib/tools/index.mjs 的 TOOL_PERM 映射里包一层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pTool } from "../prompts.mjs";

export function createCredentialTools({ perms }) {
  const tools = [];

  const getCredential = defineTool({
    name: "get_credential",
    ...pTool("get_credential"),
    parameters: Type.Object({
      domain: Type.String({ description: "凭据所属服务/网页域名，如 example.com" }),
    }),
    execute: async (_id, params) => {
      if (!perms.has("files:full")) {
        return { content: [{ type: "text", text: "越权：get_credential 仅系统管理员可用。已拒绝。" }], details: {} };
      }
      try {
        const { createCredentialStore } = await import("../credentials.mjs");
        const cs = createCredentialStore();
        const r = cs.get(String(params.domain));
        cs.close();
        if (!r.ok) return { content: [{ type: "text", text: r.text }], details: {} };
        const parts = [];
        if (r.username) parts.push(`用户名:${r.username}`);
        if (r.password) parts.push(`密码:${r.password}`);
        if (r.token) parts.push(`token:${r.token}`);
        return {
          content: [{ type: "text", text: `【凭据 ${r.domain}】${parts.join(" | ")}` }],
          details: {},
        };
      } catch (e) {
        return { content: [{ type: "text", text: `取凭据失败: ${e?.message}` }], details: {} };
      }
    },
  });

  const saveCredential = defineTool({
    name: "save_credential",
    ...pTool("save_credential"),
    parameters: Type.Object({
      domain: Type.String({ description: "凭据所属服务/网页域名，如 example.com" }),
      username: Type.Optional(Type.String({ description: "用户名（可省略）" })),
      password: Type.Optional(Type.String({ description: "密码（可省略）" })),
      token: Type.Optional(Type.String({ description: "访问令牌 token（可省略）" })),
    }),
    execute: async (_id, params) => {
      if (!perms.has("files:full")) {
        return { content: [{ type: "text", text: "越权：save_credential 仅系统管理员可用。已拒绝。" }], details: {} };
      }
      try {
        const { createCredentialStore } = await import("../credentials.mjs");
        const cs = createCredentialStore();
        const r = cs.set({
          domain: String(params.domain),
          username: String(params.username ?? ""),
          password: String(params.password ?? ""),
          token: String(params.token ?? ""),
        });
        cs.close();
        return { content: [{ type: "text", text: r.text }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `保存凭据失败: ${e?.message}` }], details: {} };
      }
    },
  });

  tools.push(getCredential, saveCredential);
  return tools;
}

export default createCredentialTools;
