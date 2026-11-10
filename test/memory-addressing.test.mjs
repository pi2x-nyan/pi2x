import test from "node:test";
import assert from "node:assert/strict";

import { addressForUser, harvestSystemPrompt } from "../lib/memory.mjs";

test("addressForUser：命中映射返回 qq/name", () => {
  assert.deepEqual(addressForUser("10001", { "10001": "主人" }), { qq: "10001", name: "主人" });
});

test("addressForUser：数字 key 也能命中（配置里可能写成数字）", () => {
  assert.deepEqual(addressForUser(10001, { "10001": "主人" }), { qq: "10001", name: "主人" });
});

test("addressForUser：未配置 / 空值 / 空白 一律返回 null", () => {
  assert.equal(addressForUser("10001", {}), null);
  assert.equal(addressForUser("10001", { "10001": "  " }), null);
  assert.equal(addressForUser("", { "": "主人" }), null);
  assert.equal(addressForUser(null, { "10001": "主人" }), null);
  assert.equal(addressForUser("10001", null), null);
});

test("harvestSystemPrompt：无称呼时逐字返回原提示词", () => {
  const base = "你是记忆提取器。";
  assert.equal(harvestSystemPrompt(base, null), base);
  assert.equal(harvestSystemPrompt(base, { qq: "1", name: "" }), base);
});

test("harvestSystemPrompt：带称呼时追加规则，且不改动原提示词", () => {
  const base = "你是记忆提取器。";
  const out = harvestSystemPrompt(base, { qq: "10001", name: "主人" });
  assert.ok(out.startsWith(base), "原提示词必须原样保留在最前面");
  assert.ok(out.includes("## 称呼"));
  assert.ok(out.includes("10001"));
  assert.ok(out.includes("「主人」"));
  assert.ok(out.includes("不要写其昵称、真名或「用户」"));
});
