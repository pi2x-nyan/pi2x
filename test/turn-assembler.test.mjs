import test from "node:test";
import assert from "node:assert/strict";

import { TurnAssembler, DUP_SIM_THRESHOLD } from "../lib/agent/turn-assembler.mjs";
import { markSent, resetSent } from "../lib/agent/sent-log.mjs";

const silent = { log() {}, error() {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * 可控的假 session。
 * prompt() 返回一个「由测试手动结束」的 Promise —— 这样增量事件与结算时机都能精确编排，
 * 也更贴近真实：真实 session 的 prompt 直到整个 run 跑完才 resolve。
 */
class FakeSession {
  constructor() {
    this.subs = new Set();
    this.agent = { state: { messages: [] } };
    this.promptCalls = [];
    this.abortCalls = 0;
    this._pending = [];
  }
  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(ev) {
    for (const s of [...this.subs]) s(ev);
  }
  prompt(text, opts) {
    this.promptCalls.push({ text, opts });
    return new Promise((resolve, reject) => this._pending.push({ resolve, reject }));
  }
  async abort() {
    this.abortCalls++;
  }
  /** 结束最早一次未结束的 prompt（模拟 run 跑完） */
  finish() {
    const p = this._pending.shift();
    p?.resolve();
  }
  fail(err) {
    const p = this._pending.shift();
    p?.reject(err);
  }
  /** 模拟模型流式输出 */
  stream(text) {
    for (const ch of text) {
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch } });
    }
  }
}

test("msgText：从 content 数组提取文本，工具轮返回 null", () => {
  assert.equal(TurnAssembler.msgText({ content: [{ type: "text", text: "你好" }] }), "你好");
  assert.equal(TurnAssembler.msgText({ content: "纯字符串" }), "纯字符串");
  assert.equal(TurnAssembler.msgText({ content: [{ type: "toolCall", name: "x" }] }), null);
  assert.equal(TurnAssembler.msgText({ content: [] }), null);
  assert.equal(TurnAssembler.msgText(null), null);
});

test("submit：无流式时返回完整文本，并释放订阅", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("hi", null, {});
  await tick();
  assert.equal(s.promptCalls.length, 1, "应提交给 session");
  assert.equal(s.promptCalls[0].opts.streamingBehavior, "followUp", "并发消息应排队而非打断");
  s.stream("你好呀");
  assert.equal(s.subs.size, 1, "运行中应保持订阅");
  s.finish();
  const out = await p;
  assert.equal(out, "你好呀");
  assert.equal(s.subs.size, 0, "结算后必须释放订阅（否则泄漏）");
});

test("submit：图片透传给 prompt", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("看图", ["data:image/png;base64,AAA"], {});
  await tick();
  assert.deepEqual(s.promptCalls[0].opts.images, ["data:image/png;base64,AAA"]);
  s.stream("ok");
  s.finish();
  await p;
});

test("submit：流式已送达 → 返回空串（避免整段重发）", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const sent = [];
  const p = asm.submit("hi", null, { send: async (t) => sent.push(t), flushMin: 1, flushMax: 1000 });
  await tick();
  s.stream("这是要分段发出去的一段话\n\n");
  s.finish();
  const out = await p;
  assert.equal(out, "", "已增量送达就不该再返回整段文本");
  assert.deepEqual(sent, ["这是要分段发出去的一段话"]);
});

test("submit：工具已发且最终文本高度重复 → 吞掉（用户不收到两遍）", async () => {
  resetSent();
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const dupText = "CC 号池一共 3 个账号，用量 in 86.53M、out 651.0K，命中率 92.6%。";
  const p = asm.submit("查状态", null, {});
  await tick();
  markSent(dupText); // 模拟 qq_send_message 工具已经发过这句
  s.agent.state.messages = [
    { role: "user" },
    { role: "assistant", content: [{ type: "toolCall", name: "qq_send_message", id: "c1" }] },
    { role: "toolResult", toolCallId: "c1" },
  ];
  s.stream(dupText);
  s.finish();
  const out = await p;
  assert.equal(out, "", `相似度应超过 ${DUP_SIM_THRESHOLD}，判为重复`);
});

test("submit：工具已发但最终文本不同 → 照常返回（不能误吞）", async () => {
  resetSent();
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("hi", null, {});
  await tick();
  markSent("先说一句别的话，完全不相关的内容在这里。");
  s.agent.state.messages = [
    { role: "user" },
    { role: "assistant", content: [{ type: "toolCall", name: "qq_send_message", id: "c1" }] },
    { role: "toolResult", toolCallId: "c1" },
  ];
  s.stream("这是完全不同的补充说明，必须发给用户。");
  s.finish();
  const out = await p;
  assert.equal(out, "这是完全不同的补充说明，必须发给用户。");
});

test("_sentByQqToolThisTurn：工具失败（isError）不算已发送", () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  s.agent.state.messages = [
    { role: "user" },
    { role: "assistant", content: [{ type: "toolCall", name: "qq_send_message", id: "c1" }] },
    { role: "toolResult", toolCallId: "c1", isError: true },
  ];
  assert.equal(asm._sentByQqToolThisTurn(), false, "失败的工具调用不能吞掉最终文本");
  s.agent.state.messages[2].isError = false;
  assert.equal(asm._sentByQqToolThisTurn(), true);
});

test("_sentByQqToolThisTurn：只看本轮（user 之后的助手消息）", () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  s.agent.state.messages = [
    { role: "assistant", content: [{ type: "toolCall", name: "qq_send_message", id: "old" }] },
    { role: "toolResult", toolCallId: "old" },
    { role: "user" },
    { role: "assistant", content: [{ type: "text", text: "普通回复" }] },
  ];
  assert.equal(asm._sentByQqToolThisTurn(), false, "上一轮的发送不该影响本轮");
});

test("cancelAll：立即结算在途消息，并 abort（旧版 items 恒空 → 这条曾经无效）", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("长任务", null, {});
  await tick();
  assert.equal(asm.inflight.size, 1, "应有 1 条在途");
  const n = await asm.cancelAll("（已中止）");
  assert.equal(n, 1, "cancelAll 应报告结算了 1 条");
  assert.equal(await p, "（已中止）", "在途消息必须被立即结算");
  assert.equal(s.abortCalls, 1, "同时要 abort agent");
  assert.equal(asm.inflight.size, 0);
});

test("cancelAll：无在途时返回 0", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  assert.equal(await asm.cancelAll(), 0);
});

test("submit：超时后 abort 并结算已有内容，不永久挂住", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("慢任务", null, { timeoutMs: 30 });
  await tick();
  s.stream("已经吐出来的部分内容"); // 之后 prompt 永不 resolve → 靠超时兜底
  const out = await p;
  assert.equal(out, "已经吐出来的部分内容", "超时应结算已产出的内容");
  assert.equal(s.abortCalls, 1, "超时必须 abort，否则后续消息全被堵死");
  assert.equal(asm.inflight.size, 0, "超时路径也要清理在途记录");
});

test("submit：prompt 抛错 → 返回友好错误文案且不挂住", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("hi", null, {});
  await tick();
  s.fail(new Error("HTTP 500"));
  const out = await p;
  assert.match(out, /出错了/);
  assert.match(out, /HTTP 500/);
  assert.equal(asm.inflight.size, 0);
});

test("同一会话并发提交：两条都提交成功，且都进入 followUp 排队", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p1 = asm.submit("问题一", null, {});
  const p2 = asm.submit("问题二", null, {});
  await tick();
  assert.equal(s.promptCalls.length, 2, "两条都应提交");
  assert.ok(s.promptCalls.every((c) => c.opts.streamingBehavior === "followUp"), "并发消息一律排队，不打断进行中的 run");
  assert.equal(asm.inflight.size, 2, "两条都在途");
  const r1 = await asm.cancelAll("（中止）");
  assert.equal(r1, 2, "在途两条都应被结算");
  assert.equal(await p1, "（中止）");
  assert.equal(await p2, "（中止）");
  assert.equal(asm.inflight.size, 0);
});

test("并发提交：不同会话各自独立结算，互不串味", async () => {
  const sa = new FakeSession();
  const sb = new FakeSession();
  const A = new TurnAssembler(sa, { logger: silent });
  const B = new TurnAssembler(sb, { logger: silent });
  const pa = A.submit("甲的问题", null, {});
  const pb = B.submit("乙的问题", null, {});
  await tick();
  sa.stream("甲的回答");
  sa.finish();
  sb.stream("乙的回答");
  sb.finish();
  assert.equal(await pa, "甲的回答");
  assert.equal(await pb, "乙的回答");
  assert.equal(A.inflight.size, 0);
  assert.equal(B.inflight.size, 0);
});

test("cancelAll 必须清掉超时定时器（否则中止的回合会留下悬空 10 分钟定时器）", async () => {
  const logs = [];
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: { log: (m) => logs.push(m), error() {} } });
  const p = asm.submit("长任务", null, { timeoutMs: 40 });
  await tick();
  await asm.cancelAll("（中止）");
  await p;
  await new Promise((r) => setTimeout(r, 90)); // 越过原本的超时点
  assert.equal(
    logs.some((l) => l.includes("⏱ 超时")),
    false,
    "已中止的回合不应在超时点再次触发「超时」路径"
  );
  assert.equal(s.abortCalls, 1, "abort 只应发生一次");
});

test("cancelAll 之后到达的迟到事件不会二次结算", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("hi", null, {});
  await tick();
  await asm.cancelAll("（中止）");
  assert.equal(await p, "（中止）");
  s.stream("迟到的输出"); // 结算后模型才吐字
  s.finish(); // 并且 run 才结束
  assert.equal(await p, "（中止）", "不得被迟到事件覆盖");
  assert.equal(asm.inflight.size, 0);
});

test("cancelAll 后 lastFullText 仍记录已产出内容（供收割判断）", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("hi", null, {});
  await tick();
  s.stream("半截话");
  await asm.cancelAll("（中止）");
  await p;
  assert.equal(asm.lastFullText, "半截话");
});

test("lastFullText：记录最近一次完整文本供上层收割使用", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("hi", null, {});
  await tick();
  s.stream("要被打捞的文本");
  s.finish();
  await p;
  assert.equal(asm.lastFullText, "要被打捞的文本");
});

test("结算幂等：prompt 完成后再超时，不会二次结算", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("hi", null, { timeoutMs: 40 });
  await tick();
  s.stream("正常回答");
  s.finish();
  assert.equal(await p, "正常回答");
  await new Promise((r) => setTimeout(r, 60)); // 越过超时点
  assert.equal(s.abortCalls, 0, "已正常结算就不该再 abort");
  assert.equal(asm.inflight.size, 0);
});
