import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, makeMandate, revalidate, MODES } from "../lib/superagent/policy.mjs";
import { SlotManager, withDeadline } from "../lib/superagent/slots.mjs";
import {
  createTicket, createAssignment, startAssignment, endAssignment, makeReport,
  ticketStage, setAttention, addInput, endTicket, ticketView,
} from "../lib/superagent/model.mjs";

const trg = (over = {}) => ({
  id: "t1", source: "qq", threadKey: "qq:private:1",
  channel: { chatType: "private", chatId: "1" },
  actor: { id: "1", name: "李彦希", bot: false }, human: true,
  addressed: "direct", at: new Date().toISOString(), text: "帮我跑一下", ...over,
});

test("gate: 私聊直发，off 模式也放行，explicit", () => {
  const v = gate(trg(), { mode: "off" });
  assert.equal(v.admissible, true);
  assert.equal(v.strength, "explicit");
});

test("gate: 群里没 @ 且没放开 → 不接", () => {
  const v = gate(trg({ addressed: undefined, threadKey: "qq:group:9", channel: { chatType: "group", chatId: "9" } }), { mode: "auto" });
  assert.equal(v.admissible, false);
  assert.equal(v.reason, "not_addressed");
});

test("gate: 群里没 @ 但放开了，observe 只记影子，auto 才真接", () => {
  const t = trg({ addressed: undefined, threadKey: "qq:group:9", channel: { chatType: "group", chatId: "9" } });
  const obs = gate(t, { mode: "observe", listenAllChats: ["qq:group:9"] });
  assert.equal(obs.admissible, true);
  assert.equal(obs.shadow, true);
  const auto = gate(t, { mode: "auto", listenAllChats: ["qq:group:9"] });
  assert.equal(auto.admissible, true);
  assert.equal(auto.shadow, undefined);
});

test("gate: 机器人消息默认不接", () => {
  const v = gate(trg({ actor: { id: "bot", bot: true }, human: false }), { mode: "auto" });
  assert.equal(v.admissible, false);
  assert.equal(v.reason, "bot");
});

test("gate: 暂停时一律不接", () => {
  assert.equal(gate(trg(), { mode: "auto", paused: true }).admissible, false);
});

test("mandate 不可变，且 revalidate 能收回授权", () => {
  const m = makeMandate(trg(), gate(trg(), { mode: "off" }), { mode: "off" });
  assert.throws(() => { "use strict"; m.strength = "none"; });
  assert.equal(revalidate(m, { mode: "off" }), true);
  assert.equal(revalidate(m, { paused: true }), false);
  assert.equal(revalidate(m, { allowedUsers: ["999"] }), false);
});

test("stage: 新工单是 queued", () => {
  const t = createTicket({ title: "x", chatKey: "private:1", threadKey: "qq:private:1", mandate: {} });
  assert.deepEqual(ticketStage(t), { stage: "working", action: "queued" });
});

test("stage: 跑起来是 working，汇报 ready 变成等人验收", () => {
  const t = createTicket({ title: "x", chatKey: "private:1", threadKey: "qq:private:1", mandate: {} });
  const a = createAssignment({});
  t.assignments.push(a);
  startAssignment(a, 1);
  assert.deepEqual(ticketStage(t), { stage: "working" });
  endAssignment(a, "done", makeReport({ state: "ready", summary: "改完了", needs: "等我验收" }));
  endAssignment(a, "done");
  assert.deepEqual(ticketStage(t), { stage: "person", action: "review" });
});

test("stage: blocked 之后，真人再说话就算被接手", () => {
  const t = createTicket({ title: "x", chatKey: "private:1", threadKey: "qq:private:1", mandate: {} });
  const a = createAssignment({});
  t.assignments.push(a);
  startAssignment(a, 1);
  endAssignment(a, "timeout", makeReport({ state: "blocked", summary: "卡住", needs: "要不要重派" }));
  assert.equal(ticketStage(t).action, "blocked");
  addInput(t, { human: true, text: "重派一次" });
  assert.notEqual(ticketStage(t).stage, "person");
});

test("attention: 提出问题后是 person/answer，结束后清空", () => {
  const t = createTicket({ title: "x", chatKey: "private:1", threadKey: "qq:private:1", mandate: {} });
  const a = createAssignment({}); t.assignments.push(a); startAssignment(a, 1);
  setAttention(t, "要不要删掉旧接口");
  assert.deepEqual(ticketStage(t), { stage: "person", action: "answer" });
  endTicket(t, { by: "executor", outcome: "completed" });
  assert.deepEqual(ticketStage(t), { stage: "ended" });
  assert.equal(t.attention, null);
});

test("slots: 上限内直接拿，满了排队，释放后自动补位", async () => {
  const s = new SlotManager({ limit: 2 });
  assert.equal(s.tryAcquire("a"), 1);
  assert.equal(s.tryAcquire("b"), 2);
  assert.equal(s.tryAcquire("c"), null);
  const p = s.enqueue("c", () => {});
  assert.equal(s.queued, 1);
  s.release("a");
  const slot = await p;
  assert.equal(slot, 3);
  assert.equal(s.busy, 2);
});

test("withDeadline: 超时会 reject 并触发回调", async () => {
  let called = false;
  await assert.rejects(
    withDeadline(() => new Promise((r) => setTimeout(r, 200)), 20, () => { called = true; }),
    /超时/,
  );
  assert.equal(called, true);
});

test("ticketView: 给模型看的字段齐全", () => {
  const t = createTicket({ title: "跑测试", chatKey: "private:1", threadKey: "qq:private:1", mandate: {} });
  const v = ticketView(t);
  for (const k of ["id", "title", "stage", "action", "report", "needs", "inputs"]) assert.ok(k in v);
});
