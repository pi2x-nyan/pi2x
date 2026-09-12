import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTools, TOOL_PERM, ORDER } from "../lib/tools/index.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROMPTS = path.join(ROOT, "prompt", "tools");

const ADMIN_PERMS = new Set([
  "memory.search",
  "memory.save",
  "memory.delete",
  "memory.harvest",
  "files:full",
  "tools.run_task",
  "tools.windows_shell",
  "tools.win_file_get",
  "tools.win_file_put",
  "tools.qq_send_file",
  "tools.clear_history",
  "tools.subagent_send",
  "tools.subagent_result",
]);

function fakeMe() {
  return {
    ctx: { chatType: "private", userId: "1000000001", targetId: "1000000001" },
    memory: null,
    white: { perms: () => new Set(), presetOf: () => "admin" },
    sessions: new Map(),
    bridge: null,
    _sessionCwd: () => "/opt/pi2x/workspace",
  };
}

const build = (perms) => buildTools({ me: fakeMe(), perms, userId: "1000000001" });

test("admin 拿到全部 17 个工具，且顺序与重构前一致", () => {
  const names = build(ADMIN_PERMS).map((t) => t.name);
  assert.equal(names.length, 17, `工具数应为 17，实测 ${names.length}`);
  assert.deepEqual(
    names,
    [
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
    ],
    "工具暴露顺序必须稳定（顺序变化会影响上游缓存前缀与模型行为）"
  );
});

test("非 admin 不拿到凭据工具（files:full 才挂载）", () => {
  const names = build(new Set(["memory.search", "tools.run_task"])).map((t) => t.name);
  assert.ok(!names.includes("get_credential"));
  assert.ok(!names.includes("save_credential"));
});

test("ORDER 必须覆盖所有产出工具（防止新增工具被静默丢弃）", () => {
  const names = build(ADMIN_PERMS).map((t) => t.name);
  const missing = names.filter((n) => !ORDER.includes(n));
  assert.deepEqual(missing, [], `这些工具没登记进 ORDER：${missing.join(", ")}`);
  // 反向：ORDER 里不该有本模块永远不产出、且不在预留清单里的名字
  const produced = new Set(names);
  const never = ORDER.filter((n) => !produced.has(n));
  assert.deepEqual(never, [], `ORDER 里有永远产不出的名字：${never.join(", ")}`);
});

test("TOOL_PERM 覆盖所有产出工具（null 表示所有会话可用）", () => {
  for (const n of build(ADMIN_PERMS).map((t) => t.name)) {
    assert.ok(Object.prototype.hasOwnProperty.call(TOOL_PERM, n), `工具 ${n} 没在 TOOL_PERM 声明权限`);
  }
});

test("每个工具都有非空 description，且提示词文件存在", () => {
  for (const t of build(ADMIN_PERMS)) {
    assert.ok(t.description && t.description.length > 10, `工具 ${t.name} 的 description 缺失或过短`);
    assert.ok(fs.existsSync(path.join(PROMPTS, `${t.name}.md`)), `缺少 prompt/tools/${t.name}.md`);
  }
});

test("qq_send_message 不做权限门禁（所有会话可用的回复通道）", async () => {
  const tools = build(new Set()); // 无任何权限
  const qq = tools.find((t) => t.name === "qq_send_message");
  assert.ok(qq, "无权限用户也必须能回复");
  assert.equal(TOOL_PERM.qq_send_message, null);
});

test("权限不足时工具返回「越权」结果而非抛异常", async () => {
  const tools = build(new Set(["tools.windows_shell"])); // 有 win 权限但没有 run_task
  const runTask = tools.find((t) => t.name === "run_task");
  assert.ok(runTask, "工具仍应挂载（运行时门禁而非静态裁剪）");
  const r = await runTask.execute("id", {}, {}, {});
  const text = r.content.map((c) => c.text).join("");
  assert.match(text, /权限不足/);
  assert.match(text, /tools\.run_task/);
  assert.equal(r.details.unauthorized, true);
});

test("有权限时门禁放行（透传到真实实现）", async () => {
  const tools = build(new Set(["memory.search"]));
  const search = tools.find((t) => t.name === "search_memories");
  // memory 未启用时真实实现返回「未启用」，而不是被门禁拦下
  const r = await search.execute("id", {}, {}, {});
  const text = r.content.map((c) => c.text).join("");
  assert.match(text, /记忆系统未启用/);
  assert.doesNotMatch(text, /权限不足/);
});

test("无权限时同一工具被门禁拦下", async () => {
  const tools = build(new Set()); // 无 memory.search
  const search = tools.find((t) => t.name === "search_memories");
  const r = await search.execute("id", {}, {}, {});
  const text = r.content.map((c) => c.text).join("");
  assert.match(text, /权限不足/);
  assert.match(text, /memory\.search/);
});

test("winShell 未配置（缺 token）时不挂 Windows 工具", async () => {
  // 之前这个用例名说的是「未配置不挂」，断言写的却是「已配置要挂」—— 名实不符，
  // 而且根本没测到分支。这里真的把 config.winShell 临时改掉再验。
  const { config } = await import("../lib/config.mjs");
  const saved = { ...config.winShell };
  try {
    config.winShell = { ...saved, token: "" };
    const names = build(ADMIN_PERMS).map((t) => t.name);
    assert.ok(!names.includes("windows_shell"), "无 token 时不该挂 windows_shell");
    assert.ok(!names.includes("windows_shell_status"), "无 token 时不该挂 windows_shell_status");
    assert.ok(!names.includes("win_file_get"), "无 token 时不该挂 win_file_get");
    assert.ok(!names.includes("qq_send_file"), "无 token 时不该挂 qq_send_file（同属 winShell 分支）");
    assert.ok(names.includes("qq_send_message"), "基础工具不受影响");

    config.winShell = { ...saved, enabled: false };
    const names2 = build(ADMIN_PERMS).map((t) => t.name);
    assert.ok(!names2.includes("windows_shell"), "enabled=false 时也不挂");
  } finally {
    config.winShell = saved;
  }
});

test("当前部署已配置 winShell → Windows 工具已挂载", () => {
  const names = build(ADMIN_PERMS).map((t) => t.name);
  assert.ok(names.includes("windows_shell"));
  assert.ok(names.includes("win_file_get"));
  assert.ok(names.includes("qq_send_file"));
});
