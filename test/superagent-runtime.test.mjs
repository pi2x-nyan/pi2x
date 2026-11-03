import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketRuntime } from "../lib/superagent/runtime.mjs";

const tmpfile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sa-")), "tickets.json");

const trg = (over = {}) => ({
  id: "t1", source: "qq", threadKey: "qq:private:1",
  channel: { chatType: "private", chatId: "1" },
  actor: { id: "1", name: "x", bot: false }, human: true,
  addressed: "direct", at: new Date().toISOString(), text: "跑一遍测试", ...over,
});

test("接单：建工单、入输入、排队状态", () => {
  const rt = new TicketRuntime({ file: tmpfile(), policy: { mode: "off" } });
  const r = rt.acceptFromTrigger(trg());
  assert.equal(r.accepted, true);
  assert.equal(r.ticket.inputs.length, 1);
  assert.equal(rt.view(r.ticket.id).stage, "working");
});

test("闸门拒了就不建工单", () => {
  const rt = new TicketRuntime({ file: tmpfile(), policy: { mode: "off", paused: true } });
  const r = rt.acceptFromTrigger(trg());
  assert.equal(r.accepted, false);
  assert.equal(rt.list().length, 0);
});

test("observe 模式：影子工单，不执行但留痕", () => {
  const rt = new TicketRuntime({ file: tmpfile(), policy: { mode: "observe", listenAllChats: ["qq:group:9"] } });
  const r = rt.acceptFromTrigger(trg({ addressed: undefined, threadKey: "qq:group:9", channel: { chatType: "group", chatId: "9" } }));
  assert.equal(r.accepted, true);
  assert.equal(r.shadow, true);
  assert.equal(rt.view(r.ticket.id).shadow, true);
});

test("执行→ready：释放槽位，通知只发一次", async () => {
  const rt = new TicketRuntime({ file: tmpfile(), policy: { mode: "off" }, slotLimit: 1 });
  const { ticket } = rt.acceptFromTrigger(trg());
  await rt.begin(ticket.id);
  assert.equal(rt.slots.busy, 1);
  const r1 = rt.report(ticket.id, { state: "ready", summary: "过了", needs: "等你验收" });
  assert.equal(r1.stage.action, "review");
  assert.equal(rt.slots.busy, 0);
  assert.ok(r1.notice?.text.includes("等你验收"));
  // 同一阶段重复汇报不再打扰
  const r2 = rt.report(ticket.id, { state: "ready", summary: "还是过了" });
  assert.equal(r2.notice, null);
});

test("blocked：置 attention，人补一句就回到工作流", async () => {
  const rt = new TicketRuntime({ file: tmpfile(), policy: { mode: "off" } });
  const { ticket } = rt.acceptFromTrigger(trg());
  await rt.begin(ticket.id);
  const r = rt.report(ticket.id, { state: "blocked", summary: "卡住了", needs: "要不要重派" });
  assert.equal(r.stage.action, "blocked");
  assert.equal(rt.view(ticket.id).needs, "要不要重派");
  rt.attachInput(ticket.id, { human: true, text: "重派" });
  assert.notEqual(rt.view(ticket.id).stage, "person");
});

test("落盘：新实例能读回工单", async () => {
  const f = tmpfile();
  const rt1 = new TicketRuntime({ file: f, policy: { mode: "off" } });
  const { ticket } = rt1.acceptFromTrigger(trg());
  await rt1.begin(ticket.id);
  rt1.report(ticket.id, { state: "ready", summary: "ok" });
  const rt2 = new TicketRuntime({ file: f, policy: { mode: "off" } });
  assert.equal(rt2.list().length, 1);
  assert.equal(rt2.view(ticket.id).report, "ready");
});

test("槽位满了排队：第二个工单 begin 会等第一个释放", async () => {
  const rt = new TicketRuntime({ file: tmpfile(), policy: { mode: "off" }, slotLimit: 1 });
  const a = rt.acceptFromTrigger(trg({ id: "t1" }));
  const b = rt.acceptFromTrigger(trg({ id: "t2" }));
  await rt.begin(a.ticket.id);
  let bStarted = false;
  const pending = rt.begin(b.ticket.id).then(() => { bStarted = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bStarted, false);
  rt.report(a.ticket.id, { state: "ready", summary: "done" });
  await pending;
  assert.equal(bStarted, true);
});

test("stillAuthorized：人被移出白名单后授权不再成立", () => {
  const rt = new TicketRuntime({ file: tmpfile(), policy: { mode: "off", allowedUsers: ["1"] } });
  const { ticket } = rt.acceptFromTrigger(trg());
  assert.equal(rt.stillAuthorized(ticket), true);
  rt.setPolicy({ allowedUsers: ["999"] });
  assert.equal(rt.stillAuthorized(ticket), false);
});

test("决策记录：四种动作都能落盘并读回", () => {
  const f = tmpfile();
  const rt = new TicketRuntime({ file: f, policy: { mode: "off" } });
  rt.recordDecision({ triggerId: "t1", action: "accept", ticketId: "k1", chatKey: "qq:private:1", reason: "dispatch", ms: 12 });
  rt.recordDecision({ triggerId: "t2", action: "ignore", chatKey: "qq:group:9", reason: "silent" });
  rt.recordDecision({ triggerId: "t3", action: "attach", ticketId: "k1", reason: "live_worker" });
  rt.recordDecision({ triggerId: "t4", action: "requeue", ticketId: "k1", reason: "resume" });
  const rows = rt.listDecisions({ limit: 10 });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.action), ["accept", "ignore", "attach", "requeue"]);
  const fs2 = fs.readFileSync(f.replace("tickets.json", "decisions.jsonl"), "utf8").trim().split("\n");
  assert.equal(fs2.length, 4);
  assert.equal(JSON.parse(fs2[0]).action, "accept");
});

test("决策记录超过上限会滚动裁剪，不会无限涨", () => {
  const rt = new TicketRuntime({ file: tmpfile(), policy: { mode: "off" } });
  for (let i = 0; i < 2100; i++) rt.recordDecision({ action: "ignore", reason: `r${i}` });
  // 规则：超过 2000 条时裁到最近 1000 条，所以任何时刻都不会超过 2000
  assert.ok(rt.decisions.length <= 2000, `实际 ${rt.decisions.length}`);
});
