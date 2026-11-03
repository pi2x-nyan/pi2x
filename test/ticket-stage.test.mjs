import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStage, buildReport, shouldNotify, stageLabel } from "../lib/ticket-stage.mjs";

test("还在跑：working，不该打扰", () => {
  const st = classifyStage({ status: "running" });
  assert.equal(st.stage, "working");
  assert.equal(st.waitsForPerson, false);
  assert.equal(shouldNotify(st), false);
});

test("排队：working/queued", () => {
  const st = classifyStage({ status: "pending" });
  assert.equal(st.stage, "working");
  assert.equal(st.action, "queued");
});

test("正常完成：person/review（等人验收）", () => {
  const st = classifyStage({ status: "done", reply: "改好了" });
  assert.equal(st.stage, "person");
  assert.equal(st.action, "review");
  assert.equal(shouldNotify(st), true);
  assert.equal(stageLabel(st), "待处理·等你验收");
});

test("带问题结束：person/answer 优先于 review", () => {
  const st = classifyStage({ status: "done", reply: "做完一半", question: "要不要顺手删掉旧接口？" });
  assert.equal(st.action, "answer");
  const r = buildReport({ status: "done", reply: "做完一半", question: "要不要顺手删掉旧接口？" });
  assert.equal(r.state, "waiting");
  assert.equal(r.needs, "要不要顺手删掉旧接口？");
});

test("超时：person/blocked，且 needs 说清是超时", () => {
  const r = buildReport({ status: "failed", timedOut: true });
  assert.equal(r.state, "blocked");
  assert.match(r.needs, /超时/);
});

test("失败：person/failed，错误透传", () => {
  const r = buildReport({ status: "failed", error: "HTTP 502" });
  assert.equal(r.state, "failed");
  assert.match(r.needs, /HTTP 502/);
});

test("中止：算 failed 一档，但语义是已中止", () => {
  const r = buildReport({ status: "aborted" });
  assert.equal(r.state, "failed");
  assert.match(r.needs, /中止/);
});

test("空正文但有工具调用：报告里要写清做了几次，不能装作什么都没发生", () => {
  const r = buildReport({ status: "done", reply: "", toolLog: ["a", "b", "c"] });
  assert.match(r.summary, /3 次工具调用/);
});

test("空正文且没工具：明确说连第一步都没动", () => {
  const r = buildReport({ status: "done", reply: "", toolLog: [] });
  assert.match(r.summary, /没有任何工具调用/);
});
