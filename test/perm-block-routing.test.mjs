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
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PIAGENT = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");

/** 造一个只带 white 存根的 PiAgent（避免真初始化子系统的开销） */
async function makeAgent(preset) {
  const tmpMod = path.join(ROOT, "lib", "__piagent_perm_test.mjs");
  fs.writeFileSync(tmpMod, PIAGENT.replace(/^class PiAgent/m, "export class PiAgent"));
  const { PiAgent } = await import(tmpMod);
  const o = Object.create(PiAgent.prototype);
  const wl = JSON.parse(fs.readFileSync(path.join(ROOT, "whitelist.json"), "utf8"));
  const groupsOf = (uid) => {
    const v = wl.users?.[String(uid)];
    if (!v) return ["dialog"];
    return Array.isArray(v) ? v : [v];
  };
  o.white = {
    presetOf: () => preset,
    groupsOf,
    load: () => wl,
  };
  return { agent: o, cleanup: () => { try { fs.unlinkSync(tmpMod); } catch { /* 已删 */ } } };
}

test("私聊 + admin：不显示权限白名单", async () => {
  const { agent, cleanup } = await makeAgent("admin");
  try {
    assert.equal(agent._permBlock("3573297011", { chatType: "private" }), "", "admin 私聊仍生成了白名单");
    assert.equal(agent._permBlock("3573297011"), "", "默认（私聊）也应不显示");
  } finally { cleanup(); }
});

test("私聊 + 非 admin：生成白名单（将并入 system prompt）", async () => {
  const { agent, cleanup } = await makeAgent("operator");
  try {
    const t = agent._permBlock("1570515219", { chatType: "private" });
    assert.ok(t.length > 0, "非 admin 私聊应生成白名单");
    assert.match(t, /【权限组白名单】/);
    assert.match(t, /当前权限组：operator/);
    assert.match(t, /- operator: /, "应列出权限组条目");
  } finally { cleanup(); }
});

test("群聊：admin 也照常显示白名单（保持原状况）", async () => {
  const { agent, cleanup } = await makeAgent("admin");
  try {
    const t = agent._permBlock("3573297011", { chatType: "group" });
    assert.ok(t.length > 0, "群聊下 admin 的白名单也被跳过了 —— 改动范围超出了私聊");
    assert.match(t, /【权限组白名单】/);
    assert.match(t, /当前权限组：admin/);
  } finally { cleanup(); }
});

test("未知用户回落 dialog 分组，仍给出白名单（不漏注入）", async () => {
  const { agent, cleanup } = await makeAgent("dialog");
  try {
    const t = agent._permBlock("999999", { chatType: "private" });
    assert.ok(t.length > 0);
    assert.match(t, /当前权限组：dialog/);
  } finally { cleanup(); }
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
