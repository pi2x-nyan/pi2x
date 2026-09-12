/**
 * 统一人设（single persona）回归测试。
 *
 * 【被锁定的设计决策】
 * 人设曾拆成 2x-base.md（公共基座）+ 2x-diff-admin.md / 2x-diff-public.md
 * （按权限组二选一），代码里做两层拼接。现已合并为 prompt/context/2x.md 一个文件，
 * 所有人读同一份，人设内部的差异（如对管理员称呼「主人」）由人设自己的一句话表达。
 *
 * 为什么收敛成一份：
 *  · 改一句话要判断「该动 base 还是 diff」，容易在两边各写一遍然后跑偏；
 *  · base 与 diff 的语气会互相覆盖，最终效果取决于拼接顺序，难以推理；
 *  · 拼接产物在每轮请求里都要读两个文件，且新增 diff 维度会引发组合爆炸。
 *
 * 本测试同时守住一个**隐私边界**：export-public 必须仍然剥离人设文件。
 * 统一后文件名为 2x.md，若过滤规则还写成 /^prompt\/context\/2x-/ 就会漏掉它，
 * 把作者的私人人设导出到公开仓库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONTEXT_DIR = path.join(ROOT, "prompt/context");
const PIAGENT = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const EXPORT_PUBLIC = fs.readFileSync(path.join(ROOT, "scripts/export-public.mjs"), "utf8");

// ── 配置形态 ──────────────────────────────────────────────────────────

test("config.pi.persona 只声明单一 promptFile，不再有 admin/public 之分", () => {
  const p = CONFIG.pi.persona["2x"];
  assert.equal(p.enabled, true);
  assert.equal(typeof p.promptFile, "string");
  assert.ok(p.promptFile.length > 0);
  assert.equal(p.adminPromptFile, undefined, "又出现了 adminPromptFile（分叉回来了）");
  assert.equal(p.publicPromptFile, undefined, "又出现了 publicPromptFile（分叉回来了）");
});

test("prompt/context 下只应存在一个人设文件", () => {
  const personas = fs.readdirSync(CONTEXT_DIR).filter((f) => /^2x.*\.md$/.test(f));
  assert.deepEqual(personas, ["2x.md"], `人设文件不止一个：${personas.join(", ")}`);
  // 会话上下文模板是另一回事，不属于人设
  assert.ok(fs.existsSync(path.join(CONTEXT_DIR, "session.md")));
});

test("人设文件内容自洽：含身份、口吻、保密底线", () => {
  const t = fs.readFileSync(path.join(CONTEXT_DIR, "2x.md"), "utf8");
  assert.match(t, /2X/);
  assert.match(t, /猫娘/);
  assert.match(t, /保密/);
  assert.match(t, /能力.*保留|能力完全保留/);
});

// ── 行为：不同权限组拿到同一文件 ──────────────────────────────────────

test("_personaFor：admin / operator / dialog 都必须指向同一个 promptFile", async () => {
  // PiAgent 类未导出，这里临时生成一份带 export 的副本（测试后删除）。
  // 副本必须放在 lib/ 下，否则文件内的相对 import（./qqbridge.mjs）会解析失败。
  const tmpMod = path.join(ROOT, "lib", "__piagent_persona_test.mjs");
  fs.writeFileSync(tmpMod, PIAGENT.replace(/^class PiAgent/m, "export class PiAgent"));
  try {
    const { PiAgent } = await import(tmpMod);
    const fake = (preset) => {
      const o = Object.create(PiAgent.prototype);
      o.white = { presetOf: () => preset };
      return o;
    };
    const expect = CONFIG.pi.persona["2x"].promptFile;
    for (const preset of ["admin", "operator", "friend", "dialog"]) {
      const p = fake(preset)._personaFor("10001");
      assert.ok(p, `${preset} 取不到 persona`);
      assert.equal(p.promptFile, expect, `${preset} 拿到的不是统一人设文件`);
    }
  } finally {
    try { fs.unlinkSync(tmpMod); } catch { /* 已删或未生成 */ }
  }
});

test("_personaFor：未启用 / 缺 promptFile 时返回 null（不静默注入空人设）", async () => {
  const tmpMod = path.join(ROOT, "lib", "__piagent_persona_test2.mjs");
  fs.writeFileSync(tmpMod, PIAGENT.replace(/^class PiAgent/m, "export class PiAgent"));
  try {
    const { PiAgent } = await import(tmpMod);
    const mod = await import("../lib/config.mjs");
    const saved = mod.config.pi.persona;
    const fake = Object.create(PiAgent.prototype);
    fake.white = { presetOf: () => "dialog" };
    try {
      mod.config.pi.persona = { "2x": { enabled: false, promptFile: "2x.md" } };
      assert.equal(fake._personaFor("1"), null, "未启用时不应返回 persona");
      mod.config.pi.persona = { "2x": { enabled: true } };
      assert.equal(fake._personaFor("1"), null, "缺 promptFile 时应返回 null 而非空串");
      mod.config.pi.persona = undefined;
      assert.equal(fake._personaFor("1"), null);
    } finally {
      mod.config.pi.persona = saved;
    }
  } finally {
    try { fs.unlinkSync(tmpMod); } catch { /* 已删或未生成 */ }
  }
});

// ── 源码契约 ──────────────────────────────────────────────────────────

test("源码里不再按权限组挑人设文件", () => {
  // 只检查**代码**，不检查注释：注释里写明历史文件名（2x-base.md 等）是好事，
  // 能解释「为什么曾经是两层、后来为什么合并」，不该被判为违规。
  const code = PIAGENT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /adminPromptFile|publicPromptFile/, "代码里仍有 admin/public 人设分叉");
  assert.doesNotMatch(code, /2x-base\.md|2x-diff-/, "代码里仍引用旧的两层人设文件");
});

test("人设只在 before_agent_start 注入一次（不重复读、不写进历史）", () => {
  const hits = PIAGENT.match(/loadPrompt\("context",\s*persona\??\.promptFile\)/g) ?? [];
  assert.equal(hits.length, 1, `人设读取点应恰好一处，实际 ${hits.length} 处`);
  // 注入产生的是 systemPrompt 增量，不能拼进 user 正文
  const f = PIAGENT.match(/finalText = \([^;]*?;/);
  assert.ok(f && !/persona/i.test(f[0]), "人设被拼进了 user 消息正文（会持久化）");
});

// ── 隐私边界（这条最重要）────────────────────────────────────────────

test("export-public 必须剥离 2x.md 人设文件（统一改名后易漏）", async () => {
  // 从导出脚本里取出「以 ^prompt 开头的路径过滤正则」。
  //
  // 提取时注意 \/ 是转义斜杠：若模式写成 [^/]+ 会在 \/ 处被截断，
  // 导致 /^prompt\/context\/2x/ 被解析成半截而抛 "Invalid flags"。
  // 这里用 (?:\\.|[^/\\\n])+ 允许「反斜杠 + 任意字符」整体通过。
  const literals = [...EXPORT_PUBLIC.matchAll(/\/\^prompt(?:\\.|[^/\\\n])*\/[a-z]*/g)].map((m) => m[0]);
  const parsed = literals.map((l) => {
    const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(l);
    return m ? new RegExp(m[1], m[2]) : null;
  }).filter(Boolean);
  assert.ok(parsed.length > 0, "没能从 export-public.mjs 提取到任何路径过滤正则（脚本结构可能变了）");
  const stripped = (p) => parsed.some((re) => re.test(p));
  assert.ok(stripped("prompt/context/2x.md"), "人设文件 2x.md 未被剥离 —— 会把私人人设导出到公开仓库！");
  assert.ok(stripped("prompt/context/2x-base.md"), "旧人设名也应保持被剥离（防止归档回滚后泄露）");
  assert.ok(!stripped("prompt/context/session.md"), "会话模板不该被剥离");
});
