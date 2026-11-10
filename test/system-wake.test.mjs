/**
 * 系统唤醒通道的回归测试
 *
 * 锁的不变量（都是这次断链事故直接对应的）：
 *   1. 事件队列里有 mooc/disk/job → 轮询一次就唤醒一次，并把事件消费掉
 *   2. 同一个 key 30 分钟内不重复唤醒（但事件不被消费，等窗口过了还能唤醒）
 *   3. 超过每日上限就不再唤醒，只写日志（事件保留，不丢）
 *   4. 模型回 SKIP 也算已消费（否则每分钟重来）
 *   5. 提交失败不消费、不记节流（下一轮还能重试）
 *   6. 消费时落一条 source=system 的 trigger 记录，可追溯
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi2x-sw-"));
process.env.PI2X_STATE_DIR = path.join(ROOT_TMP, "state");
process.env.PI2X_EVENTS_FILE = path.join(ROOT_TMP, "events.json");
process.env.PI2X_TRIGGERS_FILE = path.join(ROOT_TMP, "triggers.jsonl");

const ev = await import("../lib/events.mjs");
const sw = await import("../lib/system-wake.mjs");
const { getTurnCtx } = await import("../lib/turn-context.mjs");

const quiet = { debug() {}, info() {}, warn() {}, error() {}, log() {} };

let seq = 0;
function sandbox() {
  const dir = fs.mkdtempSync(path.join(ROOT_TMP, `t${++seq}-`));
  process.env.PI2X_EVENTS_FILE = path.join(dir, "events.json");
  return {
    dir,
    stateFile: path.join(dir, "system-wake.json"),
    triggersFile: path.join(dir, "triggers.jsonl"),
  };
}

function makeCfg(over = {}) {
  return {
    enabled: true,
    types: ["mooc", "disk", "job"],
    chat: "private:1001",
    throttleMinutes: 30,
    dailyMax: 12,
    ...over,
  };
}

function recorder(result = { ok: true }) {
  const calls = [];
  return {
    calls,
    submit: async (x) => {
      calls.push(x);
      return typeof result === "function" ? result(x) : result;
    },
  };
}

function triggers(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("有事件就唤醒一次：事件被消费，trigger 落 source=system", async () => {
  const s = sandbox();
  const rc = recorder();
  const clock = Date.now();
  const w = sw.createSystemWake({
    cfg: makeCfg(), chatKey: "private:1001", submit: rc.submit,
    stateFile: s.stateFile, triggersFile: s.triggersFile,
    now: () => clock, logger: quiet,
  });
  ev.pushEvent({ type: "mooc", key: "mooc:stall", text: "状态已经 17 分钟没更新，可能卡死" });

  const r = await w.tick();
  assert.equal(r.woke, true);
  assert.equal(rc.calls.length, 1);
  assert.equal(rc.calls[0].chatKey, "private:1001");
  // 正文形状：一眼能看出是事件、不是用户发言
  assert.match(rc.calls[0].text, /^【系统事件】mooc：状态已经 17 分钟没更新，可能卡死（事件队列，非用户发言）/);
  assert.match(rc.calls[0].text, /自动唤醒/);
  assert.match(rc.calls[0].text, /SKIP/);
  // 已消费
  assert.equal(ev.loadEvents().length, 0);

  const recs = triggers(s.triggersFile);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].source, "system");
  assert.equal(recs[0].type, "mooc");
  assert.equal(recs[0].eventKey, "mooc:stall");
  assert.equal(recs[0].chatKey, "private:1001");

  const st = JSON.parse(fs.readFileSync(s.stateFile, "utf8"));
  assert.equal(st.count, 1);
  assert.ok(st.keys["mooc:stall"] > 0);
});

test("同一个 key 30 分钟内不重复唤醒；窗口过后可以再唤醒", async () => {
  const s = sandbox();
  const rc = recorder();
  let clock = Date.now();
  const w = sw.createSystemWake({
    cfg: makeCfg(), chatKey: "private:1001", submit: rc.submit,
    stateFile: s.stateFile, triggersFile: s.triggersFile,
    now: () => clock, logger: quiet,
  });

  ev.pushEvent({ type: "mooc", key: "mooc:stall", text: "第一次" });
  assert.equal((await w.tick()).woke, true);
  assert.equal(rc.calls.length, 1);

  // 看门狗每 5 分钟会重推同一个 key —— 30 分钟内不该再叫醒 Router
  clock += 10 * 60_000;
  ev.pushEvent({ type: "mooc", key: "mooc:stall", text: "第二次" });
  const r2 = await w.tick();
  assert.equal(r2.woke, false);
  assert.equal(r2.reason, "throttled");
  assert.equal(rc.calls.length, 1);
  // 事件还在队列里，没有被悄悄吃掉
  assert.equal(ev.loadEvents().length, 1);

  // 过了节流窗：同一条事件可以再次唤醒
  clock += 21 * 60_000;
  const r3 = await w.tick();
  assert.equal(r3.woke, true);
  assert.equal(rc.calls.length, 2);
  assert.equal(ev.loadEvents().length, 0);
});

test("超过 dailyMax 不再唤醒，事件保留", async () => {
  const s = sandbox();
  const rc = recorder();
  const clock = Date.now();
  const w = sw.createSystemWake({
    cfg: makeCfg({ dailyMax: 2, throttleMinutes: 0 }),
    chatKey: "private:1001", submit: rc.submit,
    stateFile: s.stateFile, triggersFile: s.triggersFile,
    now: () => clock, logger: quiet,
  });

  // 一次只来一条，模拟不同时间点发生的三件事
  ev.pushEvent({ type: "mooc", key: "k1", text: "a" });
  assert.equal((await w.tick()).woke, true);
  ev.pushEvent({ type: "disk", key: "k2", text: "b" });
  assert.equal((await w.tick()).woke, true);
  ev.pushEvent({ type: "job", key: "k3", text: "c" });
  const r = await w.tick();
  assert.equal(r.woke, false);
  assert.equal(r.reason, "daily-max");
  assert.equal(rc.calls.length, 2);
  // 第三条还留着，等明天额度恢复
  const left = ev.loadEvents().map((e) => e.key);
  assert.deepEqual(left, ["k3"]);
});

test("只认配置里的 type：url 不唤醒，disk 唤醒", async () => {
  const s = sandbox();
  const rc = recorder();
  const clock = Date.now();
  const w = sw.createSystemWake({
    cfg: makeCfg(), chatKey: "private:1001", submit: rc.submit,
    stateFile: s.stateFile, triggersFile: s.triggersFile,
    now: () => clock, logger: quiet,
  });

  ev.pushEvent({ type: "url", key: "url:x", text: "网页变了" });
  assert.equal((await w.tick()).woke, false);
  assert.equal(rc.calls.length, 0);

  ev.pushEvent({ type: "disk", key: "disk:root", text: "根分区 92%" });
  const r = await w.tick();
  assert.equal(r.woke, true);
  assert.equal(rc.calls.length, 1);
  assert.equal(triggers(s.triggersFile)[0].type, "disk");
});

test("模型回 SKIP 也要消费掉，trigger 里留 skipped=1", async () => {
  const s = sandbox();
  const rc = recorder({ ok: true, skipped: true });
  const clock = Date.now();
  const w = sw.createSystemWake({
    cfg: makeCfg(), chatKey: "private:1001", submit: rc.submit,
    stateFile: s.stateFile, triggersFile: s.triggersFile,
    now: () => clock, logger: quiet,
  });

  ev.pushEvent({ type: "job", key: "job:1", text: "跑完了" });
  const r = await w.tick();
  assert.equal(r.woke, true);
  assert.equal(ev.loadEvents().length, 0);
  assert.equal(triggers(s.triggersFile)[0].disposition.skipped, 1);

  // 再 tick 一次不该再来一遍
  assert.equal((await w.tick()).reason, "no-events");
  assert.equal(rc.calls.length, 1);
});

test("提交失败不消费、不占额度，下一轮还能重试", async () => {
  const s = sandbox();
  let fail = true;
  const calls = [];
  const submit = async (x) => {
    calls.push(x);
    return fail ? { ok: false, reason: "no-session" } : { ok: true };
  };
  const clock = Date.now();
  const w = sw.createSystemWake({
    cfg: makeCfg(), chatKey: "private:1001", submit,
    stateFile: s.stateFile, triggersFile: s.triggersFile,
    now: () => clock, logger: quiet,
  });

  ev.pushEvent({ type: "mooc", key: "mooc:stall", text: "卡住了" });
  assert.equal((await w.tick()).woke, false);
  assert.equal(ev.loadEvents().length, 1);
  assert.equal(triggers(s.triggersFile).length, 0);

  fail = false;
  assert.equal((await w.tick()).woke, true);
  assert.equal(calls.length, 2);
  assert.equal(ev.loadEvents().length, 0);
});

test("关掉开关就完全不动", async () => {
  const s = sandbox();
  const rc = recorder();
  const w = sw.createSystemWake({
    cfg: makeCfg({ enabled: false }), chatKey: "private:1001", submit: rc.submit,
    stateFile: s.stateFile, triggersFile: s.triggersFile, logger: quiet,
  });
  ev.pushEvent({ type: "mooc", key: "mooc:stall", text: "卡住了" });
  const r = await w.tick();
  assert.equal(r.woke, false);
  assert.equal(r.reason, "disabled");
  assert.equal(rc.calls.length, 0);
  assert.equal(ev.loadEvents().length, 1);
});

test("配置归一化与正文格式", () => {
  const c = sw.systemWakeConfig({ dailyMax: "abc", types: [], throttleMinutes: -1 });
  assert.deepEqual(c.types, ["mooc", "disk", "job"]);
  assert.equal(c.dailyMax, 12);
  assert.equal(c.throttleMinutes, 30);
  assert.equal(c.enabled, true);

  const text = sw.formatWakeText([{ type: "mooc", text: "进度停滞" }]);
  assert.ok(text.startsWith("【系统事件】mooc：进度停滞（事件队列，非用户发言）"));
  assert.ok(text.includes("由你判断"));
});

test("多条事件合并成一次唤醒，一条 disposition 都不少", async () => {
  const s = sandbox();
  const rc = recorder();
  const clock = Date.now();
  const w = sw.createSystemWake({
    cfg: makeCfg(), chatKey: "private:1001", submit: rc.submit,
    stateFile: s.stateFile, triggersFile: s.triggersFile,
    now: () => clock, logger: quiet,
  });

  ev.pushEvent({ type: "mooc", key: "mooc:stall", text: "停滞" });
  ev.pushEvent({ type: "disk", key: "disk:root", text: "92%" });
  const r = await w.tick();
  assert.equal(r.woke, true);
  assert.equal(rc.calls.length, 1);
  assert.match(rc.calls[0].text, /【系统事件】mooc/);
  assert.match(rc.calls[0].text, /【系统事件】disk/);
  assert.equal(triggers(s.triggersFile).length, 2);
  assert.equal(ev.loadEvents().length, 0);
});

test("makePiSessionSubmit：走 _notifySession，并在正确的 turn ctx 里发出", async () => {
  const seen = [];
  let ctxInside = null;
  const pi = {
    _getSession: async (k, uid) => {
      seen.push(["get", k, uid]);
      return { session: { id: "s1" } };
    },
    _wakeCtxFromChatKey: (k, uid) => ({ chatKey: k, userId: uid, chatType: "private", targetId: uid }),
    _notifySession: async (sess, type, text) => {
      ctxInside = getTurnCtx();
      seen.push(["notify", sess.id, type, text]);
      return true;
    },
  };
  const r = await sw.makePiSessionSubmit(pi)({ chatKey: "private:1001", text: "事件正文" });
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0], ["get", "private:1001", "1001"]);
  assert.deepEqual(seen[1], ["notify", "s1", "system-event", "事件正文"]);
  assert.equal(ctxInside.chatKey, "private:1001");
  assert.equal(ctxInside.targetId, "1001");

  // 找不到会话 → 不假装送达，让上层保留事件等下次
  const r2 = await sw.makePiSessionSubmit({ ...pi, _getSession: async () => ({}) })({
    chatKey: "private:1001", text: "x",
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "no-session");
});
