import test from "node:test";
import assert from "node:assert/strict";

import {
  cosineSim,
  detectToolLeak,
  clip,
  fmtMs,
  INJECT_BEGIN,
  INJECT_END,
  wrapInjected,
  hasInjectedBlock,
  stripWrappedInjected,
} from "../lib/text.mjs";

test("cosineSim：完全相同 → 1，完全不同 → 0", () => {
  assert.equal(cosineSim("你好世界", "你好世界"), 1);
  assert.equal(cosineSim("你好世界", "abcd"), 0);
  assert.equal(cosineSim("", "abc"), 0);
  assert.equal(cosineSim(null, "abc"), 0);
  assert.equal(cosineSim("abc", undefined), 0);
});

test("cosineSim：近似文本落在 0~1 之间且单调", () => {
  const base = "今天的天气很不错，适合出门散步，顺便买杯咖啡。";
  const near = "今天的天气很不错，适合出门散步，顺便买杯咖啡";
  const far = "明天要下暴雨，记得带伞，路上小心。";
  const sNear = cosineSim(base, near);
  const sFar = cosineSim(base, far);
  assert.ok(sNear > 0.9, `近似文本相似度应很高，实测 ${sNear}`);
  assert.ok(sFar < sNear, "不相关文本相似度应更低");
  assert.ok(sNear <= 1 && sFar >= 0);
});

test("cosineSim：用于去重阈值判定（阈值 0.45）", () => {
  const sent = "CC 号池一共 3 个账号，用量 in 86.53M、out 651.0K，命中率 92.6%。";
  const dup = "CC 号池一共 3 个账号，用量 in 86.53M、out 651.0K，命中率 92.6%";
  assert.ok(cosineSim(sent, dup) >= 0.45, "几乎同文应判为重复");
  const notDup = "设置一个明早八点的提醒去抢课，别忘了。";
  assert.ok(cosineSim(sent, notDup) < 0.45, "无关内容不该判为重复");
});

test("detectToolLeak：识别工具调用 XML 泄漏", () => {
  assert.equal(detectToolLeak('<invoke name="qq_send_message">'), true);
  assert.equal(detectToolLeak('<invoke name="x"><parameter name="y">'), true);
  assert.equal(detectToolLeak("some <tool_calls> content <invoke name="), true);
  assert.equal(detectToolLeak("正常的回复文本，不包含任何标签"), false);
  assert.equal(detectToolLeak(""), false);
  assert.equal(detectToolLeak(null), false);
});

test("detectToolLeak：容忍全角/污染标签名（宽松匹配）", () => {
  assert.equal(detectToolLeak("<｜｜｜DSML｜｜▁invoke name="), true, "全角竖线污染也要命中");
  assert.equal(detectToolLeak("<DSML｜invoke name="), true);
});

test("clip / fmtMs：边界与格式", () => {
  assert.equal(clip("abcdef", 3), "abc…");
  assert.equal(clip("abc", 3), "abc");
  assert.equal(clip(null, 3), "");
  assert.equal(fmtMs(500), "500ms");
  assert.equal(fmtMs(1500), "1.5s");
  assert.equal(fmtMs(65_000), "1m5s");
  assert.equal(fmtMs("x"), "?");
});

// ── 注入块边界（让模型分清「自己说的」与「系统注入的」）────────────────

test("wrapInjected：包上首尾机器边界", () => {
  const w = wrapInjected("【记忆】\n- [fact] x");
  assert.ok(w.startsWith(INJECT_BEGIN), "必须以起始标记开头");
  assert.ok(w.endsWith(INJECT_END), "必须以结束标记结尾");
  assert.ok(w.includes("【记忆】"), "正文应保留");
});

test("wrapInjected：空内容返回空串（调用方据此跳过注入）", () => {
  assert.equal(wrapInjected(""), "");
  assert.equal(wrapInjected("   "), "");
  assert.equal(wrapInjected(null), "");
});

test("stripWrappedInjected：剥掉注入块，保留用户原话", () => {
  const t = `主人，帮我看看\n\n${wrapInjected("【记忆】\n- [fact · 3天前] 某事实")}`;
  assert.equal(stripWrappedInjected(t), "主人，帮我看看");
});

test("stripWrappedInjected：多次注入都能剥净", () => {
  const t = `A\n\n${wrapInjected("X")}\n\nB\n\n${wrapInjected("Y")}\n\nC`;
  const out = stripWrappedInjected(t);
  assert.ok(!out.includes("X") && !out.includes("Y"), "两块都该剥掉");
  assert.ok(out.includes("A") && out.includes("B") && out.includes("C"), "正文须完整保留");
});

test("stripWrappedInjected：未闭合时保守丢到起点（不吞后面的正文）", () => {
  const t = "用户原话\n\n" + INJECT_BEGIN + "\n没闭合";
  assert.equal(stripWrappedInjected(t), "用户原话");
});

test("stripWrappedInjected：无注入块时原样返回（幂等）", () => {
  const t = "就是一段普通文本，没有注入";
  assert.equal(stripWrappedInjected(t), t);
  assert.equal(stripWrappedInjected(t), stripWrappedInjected(stripWrappedInjected(t)));
});

test("hasInjectedBlock：能识别边界（供校验/断言用）", () => {
  assert.equal(hasInjectedBlock(wrapInjected("x")), true);
  assert.equal(hasInjectedBlock("普通文本"), false);
  assert.equal(hasInjectedBlock(""), false);
});

test("边界标记是纯 ASCII（不与正文的中文方括号混淆）", () => {
  for (const m of [INJECT_BEGIN, INJECT_END]) {
    // eslint-disable-next-line no-control-regex
    assert.match(m, /^<<<[A-Z:]+>>>$/, `标记应为纯 ASCII 尖括号包裹，实际: ${m}`);
  }
});
