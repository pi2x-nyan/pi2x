/**
 * Windows 工具 —— 经 win-agent 执行命令、传输文件
 *
 * 2026-09 重构：从 lib/piagent.mjs 的 _buildTools 抽出，**逻辑逐字未改**，
 * 只把 4 空格缩进降级为顶层，并改为工厂函数返回工具数组。
 * 权限门禁不在这里做 —— 统一在 lib/tools/index.mjs 的 TOOL_PERM 映射里包一层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pTool } from "../prompts.mjs";
import { config, WORKSPACE } from "../config.mjs";
import { winHost } from "../winhost.mjs";
import fs from "node:fs";
import path from "node:path";

export function createWindowsTools({ me }) {
  const tools = [];

  const winShellStatus = defineTool({
    name: "windows_shell_status",
    ...pTool("windows_shell_status"),
    parameters: Type.Object({}),
    execute: async () => {
      const wsCfg = config.winShell;
      if (!wsCfg?.token) {
        return { content: [{ type: "text", text: "未配置 winShell（config.json 缺少 host/port/token）" }], details: {} };
      }
      try {
        const t0 = Date.now();
        const resp = await winHost.fetch("/ping", {
          headers: { Authorization: `Bearer ${wsCfg.token}` },
          timeoutMs: 5000,
  });
        const ms = Date.now() - t0;
        const used = winHost.candidates.length > 1 ? `${winHost.active()}（首选 ${wsCfg.host}）` : `${wsCfg.host}`;
        if (resp.ok) {
          return { content: [{ type: "text", text: `Windows shell 服务在线 (${used}:${wsCfg.port})，延迟 ${ms}ms` }], details: {} };
        }
        return { content: [{ type: "text", text: `Windows shell 服务响应异常：HTTP ${resp.status}（token 可能不匹配）` }], details: {} };
      } catch (e) {
        const reason = e.name === "AbortError" ? "连接超时" : e.message;
        return {
          content: [{ type: "text", text: `Windows shell 服务离线/不可达 (${winHost.candidates.join(" / ")}，端口 ${wsCfg.port})：${reason}。可能原因：Windows 端服务未启动、EasyTier/LAN 都不通、防火墙拦截。` }],
          details: {},
        };
      }
    },
  });

  const winShell = defineTool({
    name: "windows_shell",
    ...pTool("windows_shell"),
    parameters: Type.Object({
      command: Type.String({ description: "要执行的 Windows 命令，如 Get-Process | Select -First 5 或 tasklist" }),
      timeout: Type.Number({ description: "超时秒数（必填，上限 300）——必须按任务耗时显式指定" }),
    }),
    execute: async (_id, params) => {
      const wsCfg = config.winShell;
      if (!wsCfg?.token) {
        return { content: [{ type: "text", text: "（未配置 winShell，请在 config.json 设置）" }], details: {} };
      }
      try {
        const authHeaders = { Authorization: `Bearer ${wsCfg.token}` };
        if (!params.command) {
          return { content: [{ type: "text", text: "请提供 command" }], details: {} };
        }
        const tMs = Math.min(Math.max(Number(params.timeout || 5), 5), 300) * 1000;
        const resp = await winHost.fetch("/exec", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ command: params.command, timeoutMs: tMs }),
          timeoutMs: tMs + 10000,
  });
        if (!resp.ok) {
          return { content: [{ type: "text", text: `Windows shell 服务返回 ${resp.status}（token 或服务状态异常）` }], details: {} };
        }
        const r = await resp.json();
        const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
        return {
          content: [{ type: "text", text: out ? `${out}\n(exit=${r.exitCode ?? "?"})` : `(无输出, exit=${r.exitCode ?? "?"})` }],
          details: {},
        };
      } catch (e) {
        const reason = e.name === "AbortError" ? "连接超时" : e.message;
        return {
          content: [{
            type: "text",
            text: `调用 Windows shell 失败：${reason}。可先用 windows_shell_status 检查服务是否在线（Windows 端服务/网络/防火墙）。`,
          }],
          details: {},
        };
      }
    },
  });

  const winFileGet = defineTool({
    name: "win_file_get",
    ...pTool("win_file_get"),
    parameters: Type.Object({
      remote: Type.String({ description: "Windows 文件绝对路径" }),
      local: Type.Optional(Type.String({ description: "本机保存路径（可选，默认 workspace/downloads/）" })),
      timeout: Type.Number({ description: "超时秒数（必填，上限 300）——必须显式指定（大文件给大值）" }),
    }),
    execute: async (_id, params) => {
      try {
        const tMs = Math.min(Math.max(Number(params.timeout || 10), 10), 300) * 1000;
        const r = await winHost.fetch("/file/read", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ws.token}` },
          body: JSON.stringify({ remote: params.remote }),
          timeoutMs: tMs,
      });
        const d = await r.json();
        if (!r.ok || !d.data) return { content: [{ type: "text", text: `读取失败(${r.status}): ${d.error ?? ""}` }], details: {} };
        const dlDir = path.join(WORKSPACE, "downloads");
        fs.mkdirSync(dlDir, { recursive: true });
        const target = params.local ? path.resolve(params.local) : path.join(dlDir, d.name || "download.bin");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(d.data, "base64"));
        return {
          content: [{ type: "text", text: `已从 Windows 拉取: ${d.name} (${d.size} 字节) → ${target}` }],
          details: {},
        };
      } catch (e) {
        return { content: [{ type: "text", text: `拉取失败: ${e?.message}` }], details: {} };
      }
    },
  });

  const winFilePut = defineTool({
    name: "win_file_put",
    ...pTool("win_file_put"),
    parameters: Type.Object({
      local: Type.String({ description: "本机（Linux）文件绝对路径" }),
      remote: Type.String({ description: "Windows 目标文件路径" }),
      timeout: Type.Number({ description: "超时秒数（必填，上限 300）——必须显式指定（大文件给大值）" }),
    }),
    execute: async (_id, params) => {
      try {
        if (!fs.existsSync(params.local)) {
          return { content: [{ type: "text", text: `本机文件不存在: ${params.local}` }], details: {} };
        }
        const stat = fs.statSync(params.local);
        if (stat.isDirectory()) {
          return { content: [{ type: "text", text: "是目录，请指定文件" }], details: {} };
        }
        if (stat.size > 60 * 1024 * 1024) {
          return { content: [{ type: "text", text: `文件过大(${stat.size} 字节 > 60MB)` }], details: {} };
        }
        const r = await winHost.fetch("/file/write", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ws.token}` },
          body: JSON.stringify({ remote: params.remote, data: fs.readFileSync(params.local).toString("base64") }),
          timeoutMs: Math.min(Math.max(Number(params.timeout || 10), 10), 300) * 1000,
      });
        const d = await r.json();
        if (!r.ok) return { content: [{ type: "text", text: `推送失败(${r.status}): ${d.error ?? ""}` }], details: {} };
        return { content: [{ type: "text", text: `已推送 ${stat.size} 字节 → ${d.path ?? params.remote}` }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `推送失败: ${e?.message}` }], details: {} };
      }
    },
  });

  tools.push(winShellStatus, winShell, winFileGet, winFilePut);
  return tools;
}

export default createWindowsTools;
