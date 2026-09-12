import test from "node:test";
import assert from "node:assert/strict";

import { cosineSim, detectToolLeak, clip, fmtMs } from "../lib/text.mjs";

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
