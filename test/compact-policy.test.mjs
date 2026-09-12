import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldCompact,
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
