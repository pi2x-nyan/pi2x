import test from "node:test";
import assert from "node:assert/strict";

import { StreamFlusher } from "../lib/agent/stream-flusher.mjs";

function collector() {
  const sent = [];
  return { sent, send: async (t) => sent.push(t) };
}

test("空行分段：完整段落立即切出（f.sent 同步记录），并最终送达", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 10, maxLen: 1000, idleMs: 0 });
  f.feed("第一段内容\n\n");
  assert.deepEqual(f.sent, ["第一段内容"], "空行边界应立刻切段");
  f.feed("第二段内容\n\n");
  assert.deepEqual(f.sent, ["第一段内容", "第二段内容"]);
  await f.end();
  assert.deepEqual(c.sent, ["第一段内容", "第二段内容"], "实际发送内容与切段一致");
});

test("单换行不作为切分点（避免把一段话拆碎）", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 10, maxLen: 1000, idleMs: 0 });
  f.feed("第一行\n第二行\n第三行\n");
  assert.deepEqual(f.sent, [], "只有单换行时不应切段");
  await f.end();
  assert.deepEqual(c.sent, ["第一行\n第二行\n第三行"], "收尾时才整段发出");
});

test("句末标点不作为切分点", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 5, maxLen: 1000, idleMs: 0 });
  f.feed("你好。今天天气不错。");
  assert.deepEqual(f.sent, [], "句号不应触发切分");
  await f.end();
  assert.equal(c.sent.length, 1);
});

test("超过 maxLen 时强制硬切", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 10, maxLen: 50, idleMs: 0 });
  f.feed("A".repeat(120));
  assert.ok(f.sent.length >= 2, `应至少硬切 2 段，实际 ${f.sent.length}`);
  assert.ok(f.sent[0].length <= 50);
  await f.end();
  const total = c.sent.join("");
  assert.equal(total.length, 120);
});

test("flushNow：确定性边界立即发出全部缓冲", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 100, maxLen: 1000, idleMs: 0 });
  f.feed("模型先说一句话，然后准备调用工具");
  assert.deepEqual(f.sent, [], "还没到边界");
  f.flushNow();
  assert.deepEqual(f.sent, ["模型先说一句话，然后准备调用工具"], "工具调用前应把话先切出去");
  await f.end();
  assert.deepEqual(c.sent, ["模型先说一句话，然后准备调用工具"]);
});

test("顺序保证：发送串行，不因异步乱序（慢块不会被打乱）", async () => {
  const order = [];
  const f = new StreamFlusher({
    send: async (t) => {
      // 故意让先发的慢、后发的快
      const delay = t.startsWith("A") ? 30 : 1;
      await new Promise((r) => setTimeout(r, delay));
      order.push(t);
    },
    minLen: 1,
    maxLen: 3,
    idleMs: 0,
  });
  f.feed("AAAAAAAA");
  f.feed("BBBBBBBB");
  await f.end();
  assert.deepEqual(order, ["AAAAAAAA", "BBBBBBBB"], "必须保持发送顺序");
});

test("泄露防护：命中工具调用 XML → 中止流式，且不发送该块", async () => {
  const c = collector();
  const logs = [];
  const f = new StreamFlusher({ send: c.send, minLen: 5, maxLen: 1000, idleMs: 0, log: (m) => logs.push(m) });
  f.feed('<invoke name="x"><parameter name="y">');
  f.flushNow();
  assert.equal(f.aborted, true, "应置 aborted");
  assert.deepEqual(c.sent, [], "泄露内容绝不能发给用户");
  assert.ok(logs.some((l) => l.includes("工具调用 XML")));
  const r = await f.end();
  assert.equal(r.aborted, true);
});

test("泄漏检测可注入（便于测试与替换策略）", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 1, maxLen: 1000, idleMs: 0, leakDetector: () => true });
  f.feed("任意内容");
  f.flushNow();
  assert.equal(f.aborted, true);
  assert.deepEqual(f.sent, []);
});

test("minLen 有 8 字符下限（防碎片发送）", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 1, maxLen: 3, idleMs: 0 });
  assert.equal(f.minLen, 8, "低于 8 会被抬到 8");
  assert.equal(f.maxLen, 8, "maxLen 不得小于 minLen");
  f.feed("短");
  assert.deepEqual(f.sent, [], "不足下限不切段");
  await f.end();
});

test("发送失败：仍记入 sent 但置 failed 标记（上层据标记改用整段文本兜底）", async () => {
  const f = new StreamFlusher({
    send: async (t) => {
      if (t.includes("坏")) throw new Error("network down");
    },
    minLen: 1,
    maxLen: 1000,
    idleMs: 0,
    log: () => {},
  });
  f.feed("好的内容\n\n");
  f.feed("坏的内容\n\n");
  const r = await f.end();
  assert.equal(r.failed, true, "应置 failed");
  assert.deepEqual(r.sent, ["好的内容", "坏的内容"], "sent 记录已切出并尝试发送的块");
  // 上层判定：看到 failed 就不认为「已增量送达」，改用整段文本兜底，不会漏话
  assert.equal(r.sent.length > 0 && !r.aborted && !r.failed, false, "failed 时不得判为已送达");
});

test("end() 幂等且返回结构稳定", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 1, maxLen: 1000, idleMs: 0 });
  f.feed("x");
  const r1 = await f.end();
  assert.deepEqual(Object.keys(r1).sort(), ["aborted", "failed", "sent"]);
  const r2 = await f.end();
  assert.equal(r2.sent.length, r1.sent.length, "重复 end 不应重复发送");
});

test("空白块不发送", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 1, maxLen: 1000, idleMs: 0 });
  f.feed("\n\n\n");
  await f.end();
  assert.deepEqual(f.sent, [], "纯空白不该触发切段");
  assert.deepEqual(c.sent, []);
});

test("aborted 后 feed 被忽略", async () => {
  const c = collector();
  const f = new StreamFlusher({ send: c.send, minLen: 1, maxLen: 1000, idleMs: 0 });
  f.aborted = true;
  f.feed("不应出现");
  await f.end();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(c.sent, []);
});
