/**
 * 收割重写回归测试。
 *
 * 【被锁定的设计决策】
 * 收割原本在**每轮结束**跑一次 + 10 分钟节流。两个问题：
 *   · 每轮都跑 → 每轮多一次 LLM 调用，且同一批内容在它被压缩前会被反复扫描；
 *   · 节流会漏 → 关键信息若落在被节流掉的那一轮，可能再没机会被记下。
 * 现在收敛到**压缩之前的那一次**：那是这段历史最后一次可见的时刻，
 * 且输入是**完整上下文**（不是单轮文本），装得下真正需要抢救的内容。
 *
 * 另外守住两件容易出事的事：
 *   · 注入块（【记忆】/【全局】）若被当新事实回抽 → 自我吞噬，条目越滚越多；
 *   · 工具输出体积巨大、对"提取长期事实"价值极低，不得塞进抽取请求。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { MemoryStore } from "../lib/memory.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PIAGENT = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");
const MEMORY_SRC = fs.readFileSync(path.join(ROOT, "lib/memory.mjs"), "utf8");

// ── stripInjectedBlocks ───────────────────────────────────────────────

test("剥掉末尾的注入块（【记忆】/【全局】）", () => {
  const t = "帮我看看这个 bug\n\n【记忆】\n- [fact · 3天前] 用户喜欢猫\n- [fact · 1天前] 项目在 <PI2X_ROOT>";
  const out = MemoryStore.stripInjectedBlocks(t);
  assert.equal(out, "帮我看看这个 bug", "注入块整段不应留下");
});

test("全局块同样剥掉", () => {
  const t = "问题描述\n\n【全局】\n- PI2X 运行于 Linux\n- 管理员 QQ 123";
  assert.equal(MemoryStore.stripInjectedBlocks(t), "问题描述");
});

test("两块连在一起也要都剥掉", () => {
  const t = "正文\n\n【全局】\n- A\n\n【记忆】\n- B\n- C";
  assert.equal(MemoryStore.stripInjectedBlocks(t), "正文");
});

test("没有注入块时原样返回（不误删正文）", () => {
  const t = "就是一句普通的话，提到【记忆】两个字但不独占一行";
  const out = MemoryStore.stripInjectedBlocks(t);
  assert.ok(out.includes("就是一句普通的话"), "正文必须保留");
});

// ── renderDialogs ─────────────────────────────────────────────────────

test("renderDialogs：多轮对话都保留（不是只留最后一轮）", () => {
  const msgs = [
    { role: "user", content: "第一轮问题" },
    { role: "assistant", content: "第一轮回答" },
    { role: "user", content: "第二轮问题" },
    { role: "assistant", content: "第二轮回答" },
  ];
  const out = MemoryStore.renderDialogs(msgs);
  for (const s of ["第一轮问题", "第一轮回答", "第二轮问题", "第二轮回答"]) {
    assert.ok(out.includes(s), `应包含：${s}`);
  }
});

test("renderDialogs：默认丢弃工具输出（体积大、价值低）", () => {
  const msgs = [
    { role: "user", content: "跑个命令" },
    { role: "toolResult", content: "x".repeat(5000) },
    { role: "assistant", content: "结果如下" },
  ];
  const out = MemoryStore.renderDialogs(msgs);
  assert.ok(out.includes("跑个命令") && out.includes("结果如下"));
  assert.ok(!out.includes("x".repeat(500)), "工具输出默认不得进入抽取输入");
});

test("renderDialogs：剥掉挂在消息尾部的注入块", () => {
  const msgs = [
    { role: "user", content: "真实问题\n\n【记忆】\n- [fact] 用户喜欢猫" },
    { role: "assistant", content: "回答" },
  ];
  const out = MemoryStore.renderDialogs(msgs);
  assert.ok(out.includes("真实问题"));
  assert.ok(!out.includes("用户喜欢猫"), "注入的记忆不得再次进入抽取（防自我吞噬）");
});

test("renderDialogs：超预算时保留靠后（较新）的内容", () => {
  const msgs = [];
  for (let i = 0; i < 200; i++) msgs.push({ role: "user", content: `第${i}条内容-${"填充".repeat(20)}` });
  const out = MemoryStore.renderDialogs(msgs, { budgetChars: 2000 });
  assert.ok(out.length < 2600, "应受预算约束");
  assert.ok(out.includes("第199条内容"), "最新内容必须保留");
  assert.ok(out.startsWith("（前文已省略）"), "应标明前文被省略");
});

test("renderDialogs：图片/工具调用占位不丢，也不编造", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "看这张图" }, { type: "image", data: "xxx" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
  ];
  const out = MemoryStore.renderDialogs(msgs);
  assert.ok(out.includes("〔图片〕"));
  assert.ok(out.includes("bash"));
});

// ── 接线 ──────────────────────────────────────────────────────────────

test("收割时机：压缩之前（不是每轮结束）", () => {
  // 轮末不得再有 harvest 调用
  const turnEndSeg = PIAGENT.slice(PIAGENT.indexOf("_maybeCompact(entry, chatKey)"), PIAGENT.indexOf("_maybeCompact(entry, chatKey)") + 500);
  assert.doesNotMatch(turnEndSeg, /\.harvest\(/, "轮末不应再收割");
  // 压缩路径必须收割，且在 compact 之前
  const ci = PIAGENT.indexOf("_harvestBeforeCompact(entry, chatKey)");
  const compactCall = PIAGENT.indexOf("entry.session\n      .compact()");
  assert.ok(ci > 0, "压缩路径必须调用 _harvestBeforeCompact");
  assert.ok(compactCall > 0, "找不到 compact 调用");
  assert.ok(ci < compactCall, "收割必须在 compact 之前（否则读到的已是摘要，原文丢失）");
});

test("收割前取的是消息快照（压缩会替换上下文，不能等收割时再读）", () => {
  const i = PIAGENT.indexOf("_harvestBeforeCompact(entry, chatKey) {");
  assert.ok(i > 0);
  const seg = PIAGENT.slice(i, i + 1800);
  assert.match(seg, /buildSessionContext/, "应取 compact-aware 的当前上下文");
  assert.match(seg, /structuredClone|JSON\.parse/, "必须深拷贝快照");
});

test("节流可关（harvestIntervalMs<=0 不节流）", () => {
  const i = MEMORY_SRC.indexOf("this.harvestIntervalMs > 0 && row && now - row.ts");
  assert.ok(i > 0, "节流判定必须显式排除 <= 0 的情形（否则 0 会被当成永远节流）");
});

test("抽取请求里带已知事实清单（第二道防重复）", () => {
  const i = MEMORY_SRC.indexOf("async _extract(");
  const seg = MEMORY_SRC.slice(i, i + 700);
  assert.match(seg, /knownFacts/, "应接收已知事实清单");
  const j = MEMORY_SRC.indexOf("库里已有的事实");
  assert.ok(j > 0, "提示里必须明确要求不要重复这些");
});

test("harvest 提示词：说明输入是多轮、并禁止重复已有事实", () => {
  const p = fs.readFileSync(path.join(ROOT, "prompt/memory/harvest.md"), "utf8");
  assert.match(p, /多轮|一整段对话/, "要说明输入是整段对话而非一轮");
  assert.match(p, /不要重复已有事实|不得与其中任何一条重复/, "必须禁止重复");
  assert.match(p, /宁可返回空/, "允许返回空（防止为凑数而重复）");
  assert.match(p, /他人言论|第三方/, "应提醒不要把转发的他人言论当成本人偏好");
});
