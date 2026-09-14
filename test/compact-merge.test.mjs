/**
 * 合并压缩（摘要 + 事实，一次调用）的解析与回退测试。
 *
 * 【为什么这两件事必须一起测】合并的风险全在"输出变多"上：
 * pi 的规则是摘要若被 token 上限截断（stopReason==="length"）就**放弃整次压缩**，
 * 历史一条不少、外部看只是"压缩没反应"。所以解析器必须做到：
 *   · 事实部分坏了 → 只丢事实，摘要照旧交付；
 *   · 摘要坏了/被截断 → 不接管，让 pi 走标准摘要（不能赔上整次压缩）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  splitCompactOutput,
  summaryRejection,
  mergeEnabled,
  FACTS_DELIMITER,
} from "../lib/agent/compact-merge.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

// ── splitCompactOutput ────────────────────────────────────────────────

test("摘要 + 分隔线 + JSON：正常切分", () => {
  const text = `## Goal\n做点事\n\n## Next Steps\n1. 继续\n\n${FACTS_DELIMITER}\n{"facts":[{"type":"pref","content":"用户喜欢猫","importance":6}],"used_ids":["abc"]}`;
  const r = splitCompactOutput(text);
  assert.ok(r.summary.includes("## Goal"));
  assert.ok(!r.summary.includes(FACTS_DELIMITER), "摘要里不该残留分隔线");
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].content, "用户喜欢猫");
  assert.deepEqual(r.usedIds, ["abc"]);
});

test("没有分隔线 → 全是摘要（不算失败）", () => {
  const r = splitCompactOutput("## Goal\n只有摘要，模型没给事实");
  assert.ok(r.summary.includes("## Goal"));
  assert.equal(r.facts.length, 0);
  assert.equal(r.parseError, null);
});

test("JSON 带 markdown 围栏 → 剥掉再解析", () => {
  const text = `摘要正文\n${FACTS_DELIMITER}\n\`\`\`json\n{"facts":[{"content":"事实A"}]}\n\`\`\``;
  const r = splitCompactOutput(text);
  assert.equal(r.summary, "摘要正文");
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].content, "事实A");
});

test("JSON 前后有多余文字 → 截取花括号区间", () => {
  const text = `摘要\n${FACTS_DELIMITER}\n好的，这是事实：{"facts":[{"content":"X"}]} 完毕`;
  const r = splitCompactOutput(text);
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].content, "X");
});

test("JSON 完全解析不了 → 只丢事实，摘要仍然可用", () => {
  const text = `## Goal\n重要摘要\n${FACTS_DELIMITER}\n{这不是合法 JSON`;
  const r = splitCompactOutput(text);
  assert.ok(r.summary.includes("重要摘要"), "摘要必须保住");
  assert.equal(r.facts.length, 0);
  assert.ok(r.parseError, "应记录解析失败原因");
});

test("facts 里混入非法元素 → 过滤掉，保留可用的", () => {
  const text = `摘要\n${FACTS_DELIMITER}\n{"facts":[null,{"content":"好的"},{"content":"  "},{"nocontent":1},{"content":"也好"}]}`;
  const r = splitCompactOutput(text);
  assert.deepEqual(r.facts.map((f) => f.content), ["好的", "也好"]);
});

test("facts 超过 10 条 → 截到 10 条（防输出膨胀）", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ content: `f${i}` }));
  const r = splitCompactOutput(`摘要\n${FACTS_DELIMITER}\n{"facts":${JSON.stringify(many)}}`);
  assert.equal(r.facts.length, 10);
});

// ── summaryRejection ──────────────────────────────────────────────────

test("摘要为空 → 拒收", () => {
  assert.ok(summaryRejection({ summary: "", stopReason: "stop" }));
  assert.ok(summaryRejection({ summary: "   ", stopReason: "stop" }));
});

test("被 token 上限截断 → 拒收（pi 的硬规则：截断摘要会导致整次压缩作废）", () => {
  const r = summaryRejection({ summary: "写了一半的摘要", stopReason: "length" });
  assert.ok(r, "必须拒收");
  assert.match(r, /截断/);
});

test("正常摘要 → 可用", () => {
  assert.equal(summaryRejection({ summary: "## Goal\n干活", stopReason: "stop" }), null);
});

// ── 开关与提示词 ──────────────────────────────────────────────────────

test("合并默认开启，只有显式 false 才关闭", () => {
  assert.equal(mergeEnabled({ memory: {} }), true);
  assert.equal(mergeEnabled({ memory: { mergeHarvestIntoCompact: true } }), true);
  assert.equal(mergeEnabled({ memory: { mergeHarvestIntoCompact: false } }), false);
});

test("合并提示词：以「追加指令」形式给出（摘要骨架仍由 pi 提供）", () => {
  // 【为什么是追加指令而不是完整提示词】pi 的 generateSummary 会把 customInstructions
  // 以 "Additional focus: ..." 附加到它自己的标准摘要提示词之后。标准提示词里已经有
  // 完整的章节骨架（## Goal / ## Progress / ## Next Steps ...），我们只补「事实抽取」
  // 那部分 —— 若把骨架再抄一遍，一是重复占 token，二是两边可能漂移、以哪份为准都说不清。
  const p = fs.readFileSync(path.join(ROOT, "prompt/memory/compact-merged.md"), "utf8");
  assert.ok(p.includes(FACTS_DELIMITER), "必须约定分隔线");
  assert.match(p, /NEVER extract accounts|绝不提取/, "必须禁止抽凭据");
  assert.match(p, /已知事实|already listed/, "必须要求跳过已有事实");
  assert.match(p, /\{"facts":\[\]\}/, "允许返回空（防凑数）");
  assert.match(p, /used_ids/, "说明可选的使用信号");
  // 不得自己再规定一套骨架（会与 pi 的标准格式冲突）
  assert.doesNotMatch(p, /^## Goal$/m, "不应重复定义摘要骨架章节");
});

test("合并提示词描述的分隔线与解析器用的常量一致", () => {
  const p = fs.readFileSync(path.join(ROOT, "prompt/memory/compact-merged.md"), "utf8");
  // 提示词里写的分隔线必须与代码常量一致，否则模型输出我们切不开
  assert.ok(p.includes(FACTS_DELIMITER), `提示词里的分隔线必须等于 ${FACTS_DELIMITER}`);
});

// ── 接线 ──────────────────────────────────────────────────────────────

test("piagent 注册了 session_before_compact 钩子，且失败一律回退 pi 标准摘要", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");
  assert.match(src, /pi\.on\("session_before_compact"/, "必须注册钩子");
  const i = src.indexOf('pi.on("session_before_compact"');
  const seg = src.slice(i, i + 900);
  assert.match(seg, /catch/, "钩子必须捕获异常");
  assert.match(seg, /return undefined/, "异常时必须返回 undefined（不接管）");
});

test("piagent 只接管时返回 compaction 三要素（summary/firstKeptEntryId/tokensBefore）", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");
  const i = src.indexOf("_buildMergedCompaction({ prep, ctx, event, entry: entryIn }) {");
  assert.ok(i > 0, "找不到实现");
  const end = src.indexOf("  /**", i + 100);
  const seg = src.slice(i, end > i ? end : i + 12000);
  for (const k of ["summary", "firstKeptEntryId", "tokensBefore"]) {
    assert.ok(seg.includes(k), `接管的 compaction 必须带 ${k}`);
  }
  assert.match(seg, /summaryRejection/, "交付摘要前必须走拒收检查（空/截断）");
  assert.match(seg, /computeFileLists|formatFileOperations/, "接管后要自己补文件清单（pi 不会再加）");
});

test("合并模式开启时，不再另跑一遍 harvest（避免同一批内容抽两次）", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");
  // 锚定 _compactNow 内部的那处（文件前面还有一处 mergeEnabled 在钩子里，
  // 两者位置不同、语义也不同：那处决定"要不要接管压缩"）
  const ci = src.indexOf("_compactNow(entry, chatKey, why, fromTurnEnd = false) {");
  assert.ok(ci > 0, "找不到 _compactNow");
  const seg = src.slice(ci, ci + 2200);
  const mi = seg.indexOf("if (!mergeEnabled())");
  assert.ok(mi > 0, "压缩前收割必须受 mergeEnabled 约束");
  assert.match(seg.slice(mi, mi + 300), /_harvestBeforeCompact/, "非合并模式才走单独收割");
});

test("memory 暴露 writeFacts 公开入口（合并路径与 harvest 共用去重规则）", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/memory.mjs"), "utf8");
  assert.match(src, /async writeFacts\(\{/, "应有 writeFacts 公开方法");
  const i = src.indexOf("async writeFacts({");
  const seg = src.slice(i, i + 900);
  assert.match(seg, /_upsertFact/, "必须复用 _upsertFact（否则两条写入路径规则漂移）");
  assert.match(seg, /memorySourceOf/, "来源键必须走同一套构造规则");
});

test("凭证取用遵循 pi 内部约定（含 baseUrl 覆盖）", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");
  const i = src.indexOf("modelRegistry?.getAuth");
  assert.ok(i > 0, "应通过 ctx.modelRegistry.getAuth 取凭证");
  const seg = src.slice(i, i + 500);
  assert.match(seg, /baseUrl/, "必须处理 auth 对 baseUrl 的覆盖（漏掉会发到旧地址）");
});

test("闲置压缩也拿得到 userId（不能只依赖轮次上下文）", () => {
  // 【坑】压缩有两条触发路径：轮末阈值、闲置巡检（每分钟一次）。
  // 闲置巡检**不在任何轮次上下文里**，getTurnCtx() 返回 null。
  // 若记忆写入只从轮次上下文取 userId，闲置压缩抽出的事实会全部丢失
  // （而闲置压缩恰恰是最常见的那条：没人说话时安静地压）。
  // 正确做法：优先取 entry 上的三要素（会话创建时就记下了，两条路径都拿得到）。
  const src = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");
  const i = src.indexOf("async _writeMergedFacts({");
  assert.ok(i > 0, "找不到 _writeMergedFacts");
  const end = src.indexOf("  /**", i + 100);
  const seg = src.slice(i, end > i ? end : i + 2000);
  assert.match(seg, /entry\?\.userId/, "必须优先取 entry.userId");
  assert.match(seg, /entry\?\.chatType/, "来源键的 chatType 也要取 entry");
  assert.match(seg, /entry\?\.targetId/, "来源键的 targetId 也要取 entry");
  assert.match(seg, /拿不到 userId/, "拿不到时应留日志，而不是静默丢事实");
});

test("压缩时把 entry 传给钩子（钩子事件里没有我们的 entry）", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/piagent.mjs"), "utf8");
  assert.match(src, /this\._compactEntryHint = entry/, "压缩前应记下 entry 供钩子取用");
  const i = src.indexOf('pi.on("session_before_compact"');
  const seg = src.slice(i, i + 1200);
  assert.match(seg, /_compactEntryHint/, "钩子应从提示里取 entry");
  assert.match(seg, /entry/, "并把它传给 _buildMergedCompaction");
});
