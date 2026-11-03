import { test } from "node:test";
import assert from "node:assert/strict";
import { isControlWordOnly, shouldTreatAsEmpty, normalizeStyle } from "../lib/reply-guard.mjs";

test("控制词整段：拦", () => {
  for (const t of ["SKIP", "skip", "  SKIP  ", "`SKIP`", "跳过", "跳过。", "跳过…", "略过", "算了", "无", "（跳过）", "省略"]) {
    assert.equal(isControlWordOnly(t), true, `应拦下：${JSON.stringify(t)}`);
  }
});

test("带内容的话：放行", () => {
  for (const t of [
    "跳过这一步，直接看第二页",
    "这个我先不做了，PLD 那边你说过放弃",
    "无",
    "",
    "算了我说清楚：不是这个意思",
    "SKIP 是控制码，不该当正文发",
  ]) {
    const ok = t === "无" ? false : true; // 「无」是控制词本身
    if (!ok) continue;
    assert.equal(isControlWordOnly(t), false, `应放行：${JSON.stringify(t)}`);
  }
});

test("长文本不当控制词", () => {
  const long = "跳过跳过跳过跳过跳过跳过跳过跳过跳过跳过跳过跳过跳过";
  assert.equal(isControlWordOnly(long), false);
});

test("主动轮 SKIP：静默，不算空回复（2026-11-01 事故回归）", () => {
  const base = { bufText: "", ctrlOnly: true, toolSent: false, streamedOk: false };
  assert.equal(shouldTreatAsEmpty({ ...base, controlWordSilent: false }), true);  // 普通轮 → 重试
  assert.equal(shouldTreatAsEmpty({ ...base, controlWordSilent: true }), false);  // 主动轮 → 静默
  assert.equal(shouldTreatAsEmpty({ ...base, bufText: "好的", ctrlOnly: false, controlWordSilent: false }), false);
});

test("normalizeStyle：句号换行，且不碰半角点", () => {
  assert.equal(normalizeStyle("甲。乙。"), "甲\n乙\n".trimEnd());
  assert.equal(normalizeStyle("版本 1.5 没问题"), "版本 1.5 没问题");
  assert.equal(normalizeStyle("a.com。真的"), "a.com\n真的");
  assert.equal(normalizeStyle("没有句号"), "没有句号");
});
