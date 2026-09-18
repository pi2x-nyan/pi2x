import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { TurnAssembler, DUP_SIM_THRESHOLD } from "../lib/agent/turn-assembler.mjs";
import { markSent, resetSent } from "../lib/agent/sent-log.mjs";

// 部分用例需要直接读源码断言接线（行为难以在单测里完整复现）
const ROOT = path.resolve(import.meta.dirname, "..");

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

// ── 空响应兜底（2026-09-13 真实事故）────────────────────────────────────

test("模型「秒回空」不得静默：必须有兜底文案（用户连发三条没收到任何回复）", async () => {
  // 【事故经过】上游额度受限，模型连续三次在 2 秒内返回空内容：
  //   请求成功、无异常、无超时、一个 delta 都没有。
  //   settle 对空串直接 resolve("")，bridge 收到空串执行 `if (!cleaned) return`，
  //   于是用户连发三条消息一条回复都没有，也看不到任何错误提示 —— 完全静默。
  // 超时路径早已有兜底（"这轮处理超时了"），唯独「成功但为空」这条漏了。
  const src = fs.readFileSync(path.join(ROOT, "lib/agent/turn-assembler.mjs"), "utf8");
  const i = src.indexOf("空响应兜底");
  assert.ok(i > 0, "没找到空响应兜底分支");
  const seg = src.slice(i, i + 600);
  assert.match(seg, /!err && !out && !toolSent && !streamedOk/, "判定条件必须排除 err/超时/已流式送达");
  assert.match(seg, /item\.resolve\(/, "必须 resolve 一个非空文案");
  assert.doesNotMatch(seg, /resolve\(""\)/, "不得再 resolve 空串");
});

test("err 但 message 为空时也不得静默", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/agent/turn-assembler.mjs"), "utf8");
  const i = src.indexOf("err 但 message 为空时也会静默");
  assert.ok(i > 0, "没找到 err-message 兜底注释");
  const seg = src.slice(i, i + 300);
  assert.match(seg, /未知错误/, "err 无 message 时应给通用文案");
});

test("兜底顺序：err 优先于超时，超时优先于空响应", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/agent/turn-assembler.mjs"), "utf8");
  const iTimeout = src.indexOf("这轮处理超时了");
  const iEmpty = src.indexOf("这次模型返回了空内容");
  const iErr = src.indexOf("err 但 message 为空时也会静默");
  assert.ok(iTimeout > 0 && iEmpty > 0 && iErr > 0, "三处兜底必须都存在");
  assert.ok(iTimeout < iEmpty, "超时判定必须在空响应判定之前");
  assert.ok(iEmpty < iErr, "空响应判定必须在最终 err resolve 之前");
});

// ── 空闲超时（2026-09-13 真实事故）──────────────────────────────────────

test("超时必须按「空闲」计，不是「总时长」：持续活动不得被掐断", async () => {
  // 【事故】一轮里模型连续调了 56 次工具（每次 0.4~13 秒，累计约 560 秒），
  // 全部成功、没有一处卡死，却在第 600 秒被整体掐断 —— 活干完了，一个字没交付。
  // 根因：定时器从用户消息进来就挂上、中途不重置，「一直在干活」被当成了「卡死」。
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  const p = asm.submit("hi", null, { timeoutMs: 120 });
  await tick();
  // 每隔 40ms 制造一次活动（模拟持续产出 / 工具执行），总时长会远超 120ms
  const keepAlive = setInterval(() => s.emit({ type: "tool_execution_start", toolName: "bash" }), 40);
  await new Promise((r) => setTimeout(r, 400));
  clearInterval(keepAlive);
  assert.equal(s.abortCalls, 0, "持续活动期间不该 abort（原来会在 120ms 总时长到点时掐断）");
  s.stream("干完了");
  s.finish();
  const out = await p;
  assert.equal(out, "干完了", "持续活动的一轮必须正常交付结果");
});

test("真卡死（长时间零活动）必须被空闲超时掐断", async () => {
  const s = new FakeSession();
  const asm = new TurnAssembler(s, { logger: silent });
  // 不发生任何事件 → 完全静默，定时器到点后必然判空闲超时
  const out = await asm.submit("hi", null, { timeoutMs: 80 });
  assert.match(out, /超时/, "静默卡死必须超时");
  assert.match(out, /没能给出回复/, "且要告知用户，不能静默");
  assert.ok(s.abortCalls >= 1, "卡死时应 abort 上游");
});

test("空闲超时文案要说明原因，便于区分「卡死」与「空响应」", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/agent/turn-assembler.mjs"), "utf8");
  assert.match(src, /空闲超时/, "日志与注释须体现「空闲」语义");
  assert.match(src, /idleTimer/, "必须有可重置的空闲计时器");
});

test("可选总时长硬上限：默认不设，配置后才启用", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/agent/turn-assembler.mjs"), "utf8");
  // 找准代码点（文件里有多处提到「总时长」，注释里的不算）
  const i = src.indexOf("if (totalTimeoutMs > 0)");
  assert.ok(i > 0, "必须存在「仅当配置了才挂总时长定时器」的判断");
  assert.match(
    src.slice(0, i),
    /submitTotalTimeoutMs \?\? DEFAULTS\.pi\.submitTotalTimeoutMs/,
    "默认值须走 config DEFAULTS（不就地写死）",
  );
  const cfgSrc = fs.readFileSync(path.join(ROOT, "lib/config.mjs"), "utf8");
  assert.match(cfgSrc, /submitTotalTimeoutMs: 0/, "DEFAULTS 里必须为 0（否则又退回总时长超时）");
});

test("默认 logger 不得是裸 console（否则日志漏时间戳）", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/agent/turn-assembler.mjs"), "utf8");
  assert.doesNotMatch(
    src,
    /logger\s*=\s*console/,
    "默认 logger 用 console 会绕过 lib/log.mjs，输出没有时间戳 —— 必须走 createLogger",
  );
  assert.match(src, /createLogger\(/, "默认 logger 必须由 createLogger 构造");
});

test("默认 logger 输出的每个 [dbg-submit] 行都带完整时间戳", async () => {
  // 不传 logger → 用默认值（这一步就是回归点：以前落到 console，裸写 stdout）
  const s = new FakeSession();
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    const asm = new TurnAssembler(s);
    const p = asm.submit("hi", null, {});
    await tick();
    s.stream("ok");
    s.finish();
    await p;
  } finally {
    process.stdout.write = orig;
  }
  const out = chunks.join("");
  // node 测试运行器也在往 stdout 写 TAP（可能与本模块的日志共用一行、不含换行），
  // 所以不能按行切分；直接在整段输出里定位「完整时间戳 + 日志头 + [dbg-submit] settle」的片段。
  const hits = [
    ...out.matchAll(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[LOG\]\[info\]\[asm\] \[dbg-submit\] settle · deltaCount=\d+/g,
    ),
  ];
  assert.ok(hits.length > 0, `默认 logger 必须真输出带时间戳与日志头的 settle 行（否则本测试失去意义），实际捕获: ${out.slice(0, 200)}`);
  // 反向确认：不存在「裸的」[dbg-submit] settle（即前面没有完整时间戳+日志头的那些）
  const bare = [
    ...out.matchAll(/(?<!\[LOG\]\[info\]\[asm\] )\[dbg-submit\] settle · deltaCount=\d+/g),
  ];
  assert.equal(bare.length, 0, `不得存在无时间戳/无日志头的 settle 行（命中 ${bare.length} 次）`);
});
