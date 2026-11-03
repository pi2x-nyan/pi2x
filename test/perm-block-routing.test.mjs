/**
 * 权限白名单去向的回归测试。
 *
 * 【被锁定的规则】(2026-09-12 定)
 *
 *   私聊（非 admin） → 并入 system prompt
 *     理由：同一私聊对象的权限在整个会话期间稳定，system 内容不随轮次变化，
 *     因此不破坏前缀缓存；放 system 也最符合「这是你当前的身份与权限」的语义。
 *
 *   私聊（admin）    → 不显示
 *     理由：admin 拥有全部权限，逐条列出来只是白占字符（实测 466 字符/轮）。
 *
 *   群聊             → 仍走报文末尾临时注入（保持原状况，不因私聊调整而改变）
 *     理由：群里每次说话的人可能不同，权限随成员变化；挂末尾可让前缀保持稳定。
 *
 * 无论哪种，白名单都**不得写进会话历史**。
 */
import test from "node:test";
import { WHITELIST_PATH } from "../lib/config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PIAGENT = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");

// 测试不该写死真实 QQ 号（会进公开仓库）。这里从白名单按**角色**推导，
// 既避免泄露号码，也让用例在换号后依然成立。
const WL = JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"));
const userOf = (preset) => Object.entries(WL.users ?? {}).find(([, v]) => v === preset)?.[0] ?? "";
const ADMIN_QQ = userOf("admin");
const OPERATOR_QQ = userOf("operator");

/** 造一个只带 white 存根的 PiAgent（避免真初始化子系统的开销） */
async function makeAgent(preset) {
  const tmpMod = path.join(ROOT, "lib", "__piagent_perm_test.mjs");
  fs.writeFileSync(tmpMod, PIAGENT.replace(/^class PiAgent/m, "export class PiAgent"));
  const { PiAgent } = await import(tmpMod);
  const o = Object.create(PiAgent.prototype);
  const wl = JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf8"));
  const groupsOf = (uid) => {
    const v = wl.users?.[String(uid)];
    if (!v) return ["dialog"];
    return Array.isArray(v) ? v : [v];
  };
  // 复刻 whitelist.perms 的递归展开（预设/组 → 权限串）
  const expand = (term, out, depth = 0) => {
    if (depth > 4 || term == null) return;
    if (Array.isArray(wl.groups?.[term])) { wl.groups[term].forEach((x) => expand(x, out, depth + 1)); return; }
    if (Array.isArray(wl.presets?.[term])) { wl.presets[term].forEach((x) => expand(x, out, depth + 1)); return; }
    out.add(term);
  };
  const perms = (uid) => {
    const out = new Set();
    const v = wl.users?.[String(uid)];
    if (!v) return out; // dialog：最低权限（空集）
    (Array.isArray(v) ? v : [v]).forEach((x) => expand(x, out));
    return out;
  };
  o.white = {
    presetOf: () => preset,
    groupsOf,
    perms,
    load: () => wl,
  };
  return { agent: o, cleanup: () => { try { fs.unlinkSync(tmpMod); } catch { /* 已删 */ } } };
}

test("私聊 + admin：不显示可用工具块", async () => {
  const { agent, cleanup } = await makeAgent("admin");
  try {
    assert.equal(agent._permBlock(ADMIN_QQ, { chatType: "private" }), "", "admin 私聊仍生成了能力块");
    assert.equal(agent._permBlock(ADMIN_QQ), "", "默认（私聊）也应不显示");
  } finally { cleanup(); }
});

test("私聊 + 非 admin：生成可用工具清单（将并入 system prompt）", async () => {
  const { agent, cleanup } = await makeAgent("operator");
  try {
    const t = agent._permBlock(OPERATOR_QQ, { chatType: "private" });
    assert.ok(t.length > 0, "非 admin 私聊应生成能力块");
    assert.match(t, /【可用工具】/);
    assert.match(t, /权限组：operator/);
    // operator 有 memory 权限 → 必须点名 search_memories（这是空回复 bug 的直接修复点）
    assert.match(t, /search_memories/, "operator 的能力块应列出 search_memories");
    assert.match(t, /run_task/, "operator 的能力块应列出 run_task");
  } finally { cleanup(); }
});

test("群聊：admin 也照常显示能力块（保持原状况）", async () => {
  const { agent, cleanup } = await makeAgent("admin");
  try {
    const t = agent._permBlock(ADMIN_QQ, { chatType: "group" });
    assert.ok(t.length > 0, "群聊下 admin 的能力块也被跳过了 —— 改动范围超出了私聊");
    assert.match(t, /【可用工具】/);
    assert.match(t, /权限组：admin/);
    // admin 有 files:full → 内置文件工具与命令都应出现
    assert.match(t, /bash/);
    assert.match(t, /\$ …（Linux）/);
    // 凭据工具 admin 真的能用，不得被列为不可用
    assert.doesNotMatch(t, /不可用：[^\n]*get_credential/, "admin 的凭据工具被误列为不可用");
  } finally { cleanup(); }
});

test("未知用户回落 dialog：只开放联网搜索与回复/提醒，其余明示不可用", async () => {
  const { agent, cleanup } = await makeAgent("dialog");
  try {
    const t = agent._permBlock("999999", { chatType: "private" });
    assert.ok(t.length > 0);
    assert.match(t, /权限组：dialog/);
    // 联网搜索对所有用户开放（用户要求），必须点名
    assert.match(t, /web_search/, "dialog 用户应当知道能用 web_search");
    assert.match(t, /fetch_content/, "dialog 用户应当知道能用 fetch_content");
    // null 权限的回复/提醒工具也应真实可用
    assert.match(t, /qq_send_message/);
    // 但绝不能把无权限的工具列成可用
    assert.doesNotMatch(t, /search_memories|save_memory|run_task|bash/);
    // 必须明确写出「其余不可用」的边界
    assert.match(t, /其余全部不可用/);
  } finally { cleanup(); }
});

test("能力块按 TOOL_PERM 生成，工具名与权限表一致", () => {
  // 源码契约：必须引用 TOOL_PERM，否则新增工具不会自动进入清单
  assert.match(PIAGENT, /import \{[^}]*TOOL_PERM[^}]*\} from "\.\/tools\/index\.mjs"/);
  assert.match(PIAGENT, /Object\.entries\(TOOL_PERM\)/);
  // 旧格式必须彻底消失
  assert.doesNotMatch(PIAGENT, /【权限组白名单】/);
});

// ── 源码契约：去向分派 ────────────────────────────────────────────────

test("_runTurn：私聊走 permBlockSys，群聊走 permBlockTail", () => {
  const m = PIAGENT.match(/patchTurnCtx\(\{\s*permBlockSys:[\s\S]{0,200}?\}\);/);
  assert.ok(m, "没找到权限白名单的去向分派语句");
  assert.match(m[0], /chatType === "group" \? "" : permText/, "私聊应进 permBlockSys");
  assert.match(m[0], /chatType === "group" \? permText : ""/, "群聊应进 permBlockTail");
});

test("before_agent_start 把 permBlockSys 并入 system prompt", () => {
  const i = PIAGENT.indexOf('pi.on("before_agent_start"');
  assert.ok(i > 0);
  const seg = PIAGENT.slice(i, i + 2000);
  assert.match(seg, /tc0\.permBlockSys[\s\S]{0,60}add \+=/, "私聊白名单没有并入 system prompt");
});

test("before_provider_request 只注入 permBlockTail（群聊）", () => {
  const i = PIAGENT.indexOf('pi.on("before_provider_request"');
  assert.ok(i > 0);
  const seg = PIAGENT.slice(i, i + 1500);
  assert.match(seg, /tc\.permBlockTail/, "报文注入应使用 permBlockTail");
  assert.doesNotMatch(seg, /\btc\.permBlock\b(?!Sys|Tail)/, "仍在读旧的 permBlock 字段");
});

test("白名单不进会话历史（不得出现在 user 正文里）", () => {
  const f = PIAGENT.match(/finalText = \([^;]*?;/);
  assert.ok(f, "没找到 finalText 拼接语句");
  assert.doesNotMatch(f[0], /perm/i, "白名单被拼进 user 消息正文（会持久化）");
});

// ── 注入边界：只在最新一轮、且不改写会话记录 ────────────────────────────

test("appendTailBlock：换对象而非原地改，原消息不被污染（不进入对话记录）", async () => {
  const { appendTailBlock } = await import("../lib/piagent.mjs");
  // 模拟 pi 传进来的报文：messages 数组里的对象可能与会话存储共享
  const stored = { role: "user", content: "用户原话" };
  const payload = { messages: [stored] };
  const ok = appendTailBlock(payload, "【临时块】");
  assert.equal(ok, true, "附加应成功");
  assert.equal(stored.content, "用户原话", "原消息对象被原地改写了 —— 注入会漏进会话记录");
  assert.match(payload.messages[0].content, /用户原话[\s\S]*【临时块】/, "新对象应含原话 + 临时块");
  assert.notEqual(payload.messages[0], stored, "应替换为新对象");
});

test("appendTailBlock：content 为数组时也不得原地 push", async () => {
  const { appendTailBlock } = await import("../lib/piagent.mjs");
  const parts = [{ type: "text", text: "用户原话" }];
  const stored = { role: "user", content: parts };
  const payload = { messages: [stored] };
  appendTailBlock(payload, "【临时块】");
  assert.equal(parts.length, 1, "原 content 数组被原地 push 了 —— 注入会漏进会话记录");
  assert.equal(payload.messages[0].content.length, 2, "新数组应含两块");
});

test("permBlockTail 只在用户轮注入（工具轮不重复塞）", () => {
  const i = PIAGENT.indexOf('pi.on("before_provider_request"');
  assert.ok(i > 0);
  const seg = PIAGENT.slice(i, i + 2500);
  assert.match(seg, /isUserTurn \? tc\.permBlockTail : ""/, "permBlockTail 没有按 isUserTurn 门控");
});
