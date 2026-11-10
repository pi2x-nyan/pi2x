import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCard, assembleSystemPrompt } from "../lib/persona-card.mjs";
import { applyPersona, loadPrompt } from "../lib/prompts.mjs";
import { DEFAULTS } from "../lib/config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi2x-persona-"));
let seq = 0;

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 往临时目录写一张卡，返回路径 */
function tempCard(content) {
  const file = path.join(TMP, `card-${seq++}.json`);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return file;
}

const strip = (s) => String(s).replace(/\s+/g, "");

test("loadCard：文件不存在必须抛错，不能静默返回空卡", () => {
  const missing = path.join(TMP, "does-not-exist.json");
  assert.throws(() => loadCard(missing), /读取角色卡失败/);
  try {
    loadCard(missing);
  } catch (err) {
    assert.match(err.message, /ENOENT/);
  }
});

test("loadCard：JSON 语法坏必须抛错", () => {
  const file = tempCard("{ this is not json }");
  assert.throws(() => loadCard(file), /JSON 解析失败/);
});

test("loadCard：已知字段类型不对必须抛错", () => {
  assert.throws(() => loadCard(tempCard({ personality: 42 })), /personality 类型错误/);
  assert.throws(() => loadCard(tempCard({ description: ["x"] })), /description 类型错误/);
  assert.throws(() => loadCard(tempCard({ name: null })), /name 类型错误/);
  assert.throws(() => loadCard(tempCard([1, 2, 3])), /根节点必须是对象/);
});

test("loadCard：字段全部可选，未知字段收进 extensions 不报错", () => {
  assert.deepEqual(loadCard(tempCard({})).extensions, {});

  const card = loadCard(
    tempCard({
      name: "2X",
      description: "角色描述",
      spec: "chara_card_v2",
      custom: { keep: true },
    }),
  );
  assert.equal(card.name, "2X");
  assert.equal(card.description, "角色描述");
  assert.equal(card.personality, "");
  assert.equal(card.mes_example, "");
  assert.deepEqual(card.extensions, { spec: "chara_card_v2", custom: { keep: true } });
});

test("assembleSystemPrompt：{{char}} / {{user}} 替换，userName 默认「用户」", () => {
  const card = { name: "2X", description: "{{char}} 对 {{user}} 打招呼" };
  assert.match(assembleSystemPrompt({ base: "", card }), /^2X 对 用户 打招呼$/);
  assert.match(assembleSystemPrompt({ base: "", card, userName: "阿明" }), /^2X 对 阿明 打招呼$/);
  assert.equal(
    assembleSystemPrompt({ card: { description: "{{char}}/{{user}}" }, userName: "" }),
    "/用户",
  );
});

test("assembleSystemPrompt：固定拼装顺序，first_mes 不参与", () => {
  const out = assembleSystemPrompt({
    base: "BASE",
    card: {
      name: "2X",
      first_mes: "FIRST-MES",
      system_prompt: "SYS",
      description: "DESC",
      personality: "PERS",
      scenario: "SCEN",
      mes_example: "EX",
      post_history_instructions: "POST",
    },
    userName: "阿明",
  });

  const marks = ["SYS", "DESC", "PERS", "SCEN", "[Example]", "EX", "[/Example]", "POST", "BASE"];
  let last = -1;
  for (const mark of marks) {
    const at = out.indexOf(mark);
    assert.ok(at > last, `${mark} 的位置不符合顺序：\n${out}`);
    last = at;
  }
  assert.ok(!out.includes("FIRST-MES"), "first_mes 不应进入 system prompt 拼装");
});

test("assembleSystemPrompt：空字段跳过，不多出空行", () => {
  const out = assembleSystemPrompt({
    base: "BASE",
    card: {
      system_prompt: "SYS",
      description: "",
      personality: "PERS",
      scenario: "   ",
      mes_example: "\n\t ",
      post_history_instructions: "",
    },
  });
  assert.equal(out, "SYS\n\nPERS\n\nBASE");
  assert.ok(!out.includes("\n\n\n"), "不应出现连续空行");
});

test("assembleSystemPrompt：没有可拼内容时原样返回 base（含尾随空白）", () => {
  const base = "# 干活的样子\n\n规则……\n";
  assert.equal(assembleSystemPrompt({ base, card: {} }), base);
  assert.equal(assembleSystemPrompt({ base, card: { name: "2X" } }), base);
});

test("applyPersona：enabled=false 时与 base 一字不差（即使卡路径不存在）", () => {
  const base = loadPrompt("agent", "system.md");
  assert.equal(applyPersona(base, { enabled: false, cardFile: "/no/such/card.json" }), base);
  // 不依赖 private/config.json 的实时值：显式传空对象走「未启用」分支
  assert.equal(applyPersona(base, {}), base);
});

test("applyPersona：enabled=true 时读卡并按顺序叠加到 base 上", () => {
  const cardFile = tempCard({ name: "2X", system_prompt: "CARD-SYS", description: "CARD-DESC" });
  const out = applyPersona("BASE", { enabled: true, cardFile });
  assert.equal(out, "CARD-SYS\n\nCARD-DESC\n\nBASE");
});

test("配置：默认关闭，示例配置与 DEFAULTS 一致", () => {
  assert.deepEqual(DEFAULTS.pi.persona, {
    enabled: false,
    cardFile: "./private/persona/card.json",
  });
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  assert.deepEqual(example.pi.persona, DEFAULTS.pi.persona);
});

test("迁移：人设只存在卡里，system.md 只剩运维规则", () => {
  const cardFile = path.join(ROOT, "private", "persona", "card.json");
  const card = loadCard(cardFile);
  const desc = strip(card.description);
  assert.ok(desc.length > 200, "卡里的 description 不能为空");
  assert.equal((card.description.match(/^\d+\./gm) ?? []).length, 10, "description 应保留 10 条编号");

  // 其余字段清空后，拼装结果就是卡里的正文（人设不丢字）
  const only = { ...card, personality: "", scenario: "", first_mes: "", mes_example: "", system_prompt: "", post_history_instructions: "" };
  assert.equal(strip(assembleSystemPrompt({ base: "", card: only })), desc);

  // system.md 只留运维规则，不重复人设
  const systemMd = loadPrompt("agent", "system.md");
  assert.ok(!strip(systemMd).includes(desc.slice(0, 40)), "system.md 不应重复保留人设原文");
});

test("迁移：system.md 从「干活的样子」开始，不含角色扮演段", () => {
  const systemMd = loadPrompt("agent", "system.md");
  const firstLine = systemMd.trimStart().split("\n")[0];
  assert.equal(firstLine, "# 干活的样子");
});
