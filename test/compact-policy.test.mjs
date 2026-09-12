import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldCompact,
  shouldCompactOnIdle,
  canTrigger,
  resolveThreshold,
  fmtPercent,
  fmtTokenCount,
  fmtContextUsage,
} from "../lib/agent/compact-policy.mjs";

test("shouldCompact：量纲必须是 0~100 的百分数", () => {
  // 回归用例：线上曾把阈值写成 0.70（误以为量纲是 0~1），
  // 结果「上下文超过 0.7% 就压缩」，几乎每轮都白跑一次压缩调用。
  assert.equal(shouldCompact(11.03, 70), false, "11% 占用不该触发 70% 阈值");
  assert.equal(shouldCompact(69.9, 70), false);
  assert.equal(shouldCompact(70, 70), true, "达到阈值即触发");
  assert.equal(shouldCompact(85, 70), true);
});

test("shouldCompact：非法输入一律不触发（宁可不压缩，不要乱压缩）", () => {
  assert.equal(shouldCompact(null, 70), false);
  assert.equal(shouldCompact(undefined, 70), false);
  assert.equal(shouldCompact(NaN, 70), false);
  assert.equal(shouldCompact(90, 0), false);
  assert.equal(shouldCompact(90, -1), false);
  assert.equal(shouldCompact(90, NaN), false);
});

test("shouldCompact：旧错误阈值 0.70 会把正常对话全部误判为需要压缩", () => {
  // 这正是那个 bug 的写照：11% 的占用 > 0.70
  assert.equal(shouldCompact(11.03, 0.7), true, "0.70 量纲错误 → 误触发");
});

test("canTrigger：压缩中 / 冷却期内不再触发", () => {
  const now = 1_000_000;
  assert.equal(canTrigger({ compacting: true, now }), false);
  assert.equal(canTrigger({ compacting: false, lastCompactAt: now - 1000, now, cooldownMs: 60000 }), false);
  assert.equal(canTrigger({ compacting: false, lastCompactAt: now - 61000, now, cooldownMs: 60000 }), true);
  assert.equal(canTrigger({ compacting: false, lastCompactAt: 0, now }), true, "从未压缩过应可触发");
});

test("resolveThreshold：非法配置回落默认", () => {
  assert.equal(resolveThreshold(undefined), 70);
  assert.equal(resolveThreshold(null), 70);
  assert.equal(resolveThreshold("abc"), 70);
  assert.equal(resolveThreshold(0), 70);
  assert.equal(resolveThreshold(-5), 70);
  assert.equal(resolveThreshold(60), 60);
  assert.equal(resolveThreshold("55"), 55, "字符串数字应被接受");
});

test("fmtPercent：不再二次乘 100", () => {
  assert.equal(fmtPercent(11.03), "11.03%");
  assert.equal(fmtPercent(70), "70.00%");
  assert.equal(fmtPercent(NaN), "?%");
  // 回归：旧代码 Math.round(percent * 100) 会把 11.03 打成 1103%
  assert.notEqual(fmtPercent(11.03), "1103%");
});

// ── 上下文占用展示（/status 用）────────────────────────────────────────────

test("fmtTokenCount：1000 进制、移动端友好", () => {
  assert.equal(fmtTokenCount(0), "0");
  assert.equal(fmtTokenCount(999), "999");
  assert.equal(fmtTokenCount(1500), "1.5K");
  assert.equal(fmtTokenCount(9999), "10K");
  assert.equal(fmtTokenCount(112000), "112K");
  assert.equal(fmtTokenCount(1000000), "1M");
  assert.equal(fmtTokenCount(1500000), "1.5M");
  assert.equal(fmtTokenCount(NaN), "?");
  assert.equal(fmtTokenCount(-1), "?");
});

test("fmtContextUsage：正常情况给出 占用率 + token 数", () => {
  const r = fmtContextUsage({ percent: 11.03, tokens: 112000, contextWindow: 1000000 });
  assert.equal(r, "上下文 11.0% · 112K/1M");
});

test("fmtContextUsage：percent=null 必须显示「待统计」，不能显示 0%（那是在撒谎）", () => {
  // Number(null) === 0 是个经典陷阱：pi 在压缩后首轮返回 {tokens:null,percent:null}，
  // 若直接 Number() 就会渲染成 0.0%，看起来像「上下文是空的」
  const r = fmtContextUsage({ percent: null, tokens: null, contextWindow: 1000000 });
  assert.match(r, /待统计/);
  assert.doesNotMatch(r, /0\.0%/);
  assert.equal(fmtContextUsage({}).includes("待统计"), true);
  assert.equal(fmtContextUsage().includes("待统计"), true);
  assert.equal(fmtContextUsage({ percent: undefined }).includes("待统计"), true);
});

test("fmtContextUsage：不做二次乘 100（回归：曾把 11% 打成 1103%）", () => {
  const r = fmtContextUsage({ percent: 11.03, tokens: 112000, contextWindow: 1000000 });
  assert.doesNotMatch(r, /1103/);
  assert.match(r, /11\.0%/);
});

test("fmtContextUsage：缺 token/window 时只显示百分比，不显示 NaN", () => {
  assert.equal(fmtContextUsage({ percent: 42 }), "上下文 42.0%");
  const r = fmtContextUsage({ percent: 42, tokens: 1000, contextWindow: null });
  assert.doesNotMatch(r, /NaN/);
  assert.doesNotMatch(r, /\//);
});

test("fmtContextUsage：输出宽度适配移动端（≤25 半角）", () => {
  const cases = [
    { percent: 0, tokens: 0, contextWindow: 1000000 },
    { percent: 11.03, tokens: 112000, contextWindow: 1000000 },
    { percent: 99.9, tokens: 999000, contextWindow: 1000000 },
    { percent: null },
  ];
  for (const c of cases) {
    const r = fmtContextUsage(c);
    assert.ok(r.length <= 25, `过长（${r.length}）: ${r}`);
  }
});

// ── 闲置压缩（整轮结束后 23 小时、且上下文 > 20%）────────────────────────

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test("shouldCompactOnIdle：整轮结束满 23 小时且上下文 > 20% → 触发", () => {
  assert.equal(shouldCompactOnIdle({ percent: 30, idleMs: 23 * HOUR }), true);
  assert.equal(shouldCompactOnIdle({ percent: 21, idleMs: 24 * HOUR }), true);
  assert.equal(shouldCompactOnIdle({ percent: 80, idleMs: 48 * HOUR }), true);
});

test("shouldCompactOnIdle：不满 23 小时不触发（哪怕上下文很高）", () => {
  assert.equal(shouldCompactOnIdle({ percent: 90, idleMs: 22 * HOUR }), false);
  assert.equal(shouldCompactOnIdle({ percent: 90, idleMs: 23 * HOUR - 1 }), false);
  assert.equal(shouldCompactOnIdle({ percent: 39, idleMs: 0 }), false);
});

test("shouldCompactOnIdle：上下文不大于 20% 不触发（太小压了不划算）", () => {
  // 闲置时长统一用「远超阈值」的值（24h > 23h），确保失败原因是 percent 而非时间
  assert.equal(shouldCompactOnIdle({ percent: 20, idleMs: 24 * HOUR }), false, "恰好 20% 不该触发（要求「大于」）");
  assert.equal(shouldCompactOnIdle({ percent: 5, idleMs: 24 * HOUR }), false);
  assert.equal(shouldCompactOnIdle({ percent: 20.1, idleMs: 24 * HOUR }), true, "刚过 20% 应触发");
});

test("shouldCompactOnIdle：两个条件必须同时满足", () => {
  // 各缺一个条件
  assert.equal(shouldCompactOnIdle({ percent: 10, idleMs: 1 * MIN }), false, "两个都不满足");
  assert.equal(shouldCompactOnIdle({ percent: 50, idleMs: 1 * MIN }), false, "只有上下文够");
  assert.equal(shouldCompactOnIdle({ percent: 10, idleMs: 24 * HOUR }), false, "只有时间够");
});

test("shouldCompactOnIdle：阈值可覆盖（便于配置调整）", () => {
  assert.equal(shouldCompactOnIdle({ percent: 30, idleMs: 5 * MIN, idleThresholdMs: 5 * MIN }), true);
  assert.equal(shouldCompactOnIdle({ percent: 30, idleMs: 5 * MIN, percentFloor: 50 }), false);
});

test("shouldCompactOnIdle：非法输入一律不触发（宁可不压，不要乱压）", () => {
  for (const bad of [
    {}, null, undefined,
    { percent: null, idleMs: 24 * HOUR },
    { percent: "abc", idleMs: 24 * HOUR },
    { percent: 50, idleMs: NaN },
    { percent: 50, idleMs: 24 * HOUR, idleThresholdMs: 0 },
    { percent: 50, idleMs: 24 * HOUR, percentFloor: -1 },
    { percent: 50, idleMs: 24 * HOUR, idleThresholdMs: NaN },
  ]) {
    assert.equal(shouldCompactOnIdle(bad), false, `输入 ${JSON.stringify(bad)} 不该触发`);
  }
});

test("shouldCompactOnIdle：默认阈值就是需求写的那两个数（23 小时 / 20%）", () => {
  assert.equal(shouldCompactOnIdle({ percent: 20.5, idleMs: 23 * HOUR }), true);
  assert.equal(shouldCompactOnIdle({ percent: 20.5, idleMs: 22 * HOUR }), false);
});

// ── 接线检查（防「变量名写错被 warn 吞掉」）──────────────────────────────

test("bridge.mjs 用正确的变量名调起闲置巡检（曾写成 agent，导致静默未启动）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const src = fs.readFileSync(path.join(root, "bridge.mjs"), "utf8");

  // 找到 createPiAgent 的接收变量
  const m = /const\s+(\w+)\s*=\s*createPiAgent\s*\(/.exec(src);
  assert.ok(m, "没找到 createPiAgent 的接收变量");
  const varName = m[1];

  // 调起巡检时必须用这个变量名
  assert.match(
    src,
    new RegExp(`\\b${varName}\\._startIdleCompact\\?\\.\\(\\)`),
    `调起闲置巡检时应用 ${varName}，而不是别的名字`,
  );
  // 明确禁止曾经错过的写法
  assert.doesNotMatch(src, /\bagent\._startIdleCompact/, "又写成了 agent（应为 createPiAgent 的接收变量名）");
});


test("轮次结束时的阈值检查必须放行（否则 40% 主路径被永久取消）", async () => {
  // 【这条来自真实故障】_maybeCompact 在轮内调用（早于 turnRunning 清除），
  // 若 _compactNow 一律以 turnRunning 为由取消，则 40% 阈值路径永远不会生效 ——
  // 实际表现就是「上下文 41.5% 却一直不压缩」。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../lib/piagent.mjs"), "utf8");

  // 阈值调用点必须带 fromTurnEnd=true
  const thresholdCall = /this\._compactNow\(entry,\s*chatKey,\s*`\$\{CP\.fmtPercent\(cu\.percent\)\} 达阈值[^`]*`,\s*true\)/.exec(src);
  assert.ok(thresholdCall, "阈值路径调用 _compactNow 时必须传 fromTurnEnd=true");

  // 闲置路径不得传 fromTurnEnd（保持「轮次进行中即取消」的保护）
  const idleCall = /this\._compactNow\(entry,\s*chatKey,\s*`闲置[^`]*`\)/.exec(src);
  assert.ok(idleCall, "闲置路径应保持不传 fromTurnEnd 的调用形式");

  // 取消条件必须受 fromTurnEnd 约束
  assert.match(src, /if \(!fromTurnEnd && entry\.turnRunning\)/, "取消条件必须排除 fromTurnEnd 情形");
});
