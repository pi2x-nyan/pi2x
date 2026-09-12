import test from "node:test";
import assert from "node:assert/strict";

import { GIVEUP_TOKEN, detectGiveup, GIVEUP_TOOL_SPEC } from "../lib/safe/giveup.mjs";

test("推荐令牌 [[PI2X:GIVEUP]] 被识别", () => {
  const r = detectGiveup(`我试了三种方案都不行。\n${GIVEUP_TOKEN} 代码损坏太深`);
  assert.equal(r.hit, true);
  assert.equal(r.matched, GIVEUP_TOKEN);
});

test("令牌大小写与空格宽容", () => {
  for (const s of ["[[pi2x:giveup]]", "[[ PI2X : GIVEUP ]]", "[[PI2X:GIVEUP]]"]) {
    assert.equal(detectGiveup(s).hit, true, `应识别: ${s}`);
  }
});

test("JSON 风格 status:XXXFAILED 被识别（用户建议的形式）", () => {
  assert.equal(detectGiveup('{"status":"XXXFAILED"}').hit, true);
  assert.equal(detectGiveup('{"status": "pi2x_failed", "reason":"x"}').hit, true);
  assert.equal(detectGiveup('{"status":"OK"}').hit, false, "成功状态不该被判为放弃");
});

test("XML 风格 <pi2x>GIVEUP</pi2x> 被识别", () => {
  assert.equal(detectGiveup("<pi2x>GIVEUP</pi2x>").hit, true);
  assert.equal(detectGiveup("< pi2x > giveup < / pi2x >").hit, true);
});

test("单独成行的 PI2X_GIVEUP 被识别", () => {
  assert.equal(detectGiveup("诊断完了\nPI2X_GIVEUP\n修不动").hit, true);
});

test("日常对话不会被误判（这是最关键的一条）", () => {
  const normal = [
    "我修好了，重启正常模式吧。",
    "这个 bug 是量纲写错了，已修复。",
    "giveup 这个词我先不用。",
    "任务失败了，但我换个思路再试。",
    "ERROR: 文件不存在",
    "status=200",
    "",
    null,
    undefined,
  ];
  for (const s of normal) {
    assert.equal(detectGiveup(s).hit, false, `不该误判: ${JSON.stringify(s)}`);
  }
});

test("reason 会被抽取出来（用于告警与留档）", () => {
  const r = detectGiveup(`${GIVEUP_TOKEN}\nwhitelist 模块被删了，无法恢复`);
  assert.equal(r.hit, true);
  assert.match(r.reason, /whitelist/);
});

test("没有原因时 reason 为空串而不是 undefined", () => {
  const r = detectGiveup(GIVEUP_TOKEN);
  assert.equal(typeof r.reason, "string");
});

test("工具规格齐备（安全模式据此注册）", () => {
  assert.equal(GIVEUP_TOOL_SPEC.name, "declare_unfixable");
  assert.ok(GIVEUP_TOOL_SPEC.description.length > 50);
  assert.match(GIVEUP_TOOL_SPEC.description, /回退/, "描述里要说清后果");
  assert.ok(GIVEUP_TOOL_SPEC.parameters.reason, "必须有 reason 参数");
});

test("超长文本不拖垮匹配（性能兜底）", () => {
  const big = `${"填充".repeat(200_000)}\n${GIVEUP_TOKEN}`;
  const t0 = Date.now();
  assert.equal(detectGiveup(big).hit, true);
  assert.ok(Date.now() - t0 < 2000, "匹配不应过慢");
});
