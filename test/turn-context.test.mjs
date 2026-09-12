import test from "node:test";
import assert from "node:assert/strict";

import {
  runWithTurnCtx,
  getTurnCtx,
  patchTurnCtx,
  deleteTurnCtxField,
  snapshotTurnCtx,
} from "../lib/turn-context.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctxOf = (name, userId, chatType = "private", targetId = null) => ({
  chatType,
  userId,
  targetId: targetId ?? userId,
  chatKey: `${chatType}:${targetId ?? userId}`,
  userName: name,
});

test("回合外没有上下文", () => {
  assert.equal(getTurnCtx(), null);
  assert.equal(snapshotTurnCtx(), null);
});

test("回合内可读，且异步链自动继承", async () => {
  await runWithTurnCtx(ctxOf("甲", "111"), async () => {
    assert.equal(getTurnCtx().userId, "111");
    await sleep(5);
    assert.equal(getTurnCtx().userId, "111", "await 之后仍应保留");
    await Promise.resolve().then(() => {
      assert.equal(getTurnCtx().userId, "111", "微任务里也应保留");
    });
  });
  assert.equal(getTurnCtx(), null, "回合结束后应清理");
});

test("patchTurnCtx：只影响当前回合", async () => {
  await runWithTurnCtx(ctxOf("甲", "111"), async () => {
    assert.equal(patchTurnCtx({ memInjection: "【甲的记忆】" }), true);
    await sleep(5);
    assert.equal(getTurnCtx().memInjection, "【甲的记忆】");
    assert.equal(deleteTurnCtxField("memInjection"), true);
    assert.equal(getTurnCtx().memInjection, undefined);
  });
});

test("回合外 patch 返回 false（不静默丢失）", () => {
  assert.equal(patchTurnCtx({ x: 1 }), false);
  assert.equal(deleteTurnCtxField("x"), false);
});

test("上下文是浅拷贝：外部改动原对象不影响回合内", async () => {
  const mine = ctxOf("甲", "111");
  await runWithTurnCtx(mine, async () => {
    mine.userId = "999"; // 外部改原对象
    assert.equal(getTurnCtx().userId, "111", "回合内应保持进入时的值");
  });
});

// ── 并发隔离：这就是修复的核心价值 ────────────────────────────────────────

test("并发两个回合：各自的上下文互不覆盖（修复前的 bug）", async () => {
  const log = [];

  async function turn(name, userId, delay) {
    return runWithTurnCtx(ctxOf(name, userId), async () => {
      log.push([name, "进入", getTurnCtx().userId]);
      await sleep(delay); // 模拟记忆检索这样的慢 await —— B 会在这期间插入
      log.push([name, "await后", getTurnCtx().userId]);
      patchTurnCtx({ memInjection: `【${name}的记忆】` });
      await sleep(2);
      log.push([name, "读注入", getTurnCtx().memInjection, getTurnCtx().userId]);
      return { name, user: getTurnCtx().userId, mem: getTurnCtx().memInjection };
    });
  }

  const [a, b] = await Promise.all([turn("甲", "111", 40), turn("乙", "222", 5)]);

  assert.equal(a.user, "111", "甲的 userId 不能被乙覆盖");
  assert.equal(b.user, "222");
  assert.equal(a.mem, "【甲的记忆】", "甲必须拿到自己的记忆注入");
  assert.equal(b.mem, "【乙的记忆】", "乙必须拿到自己的记忆注入");

  for (const [name, phase, val, extra] of log) {
    if (phase === "await后") {
      const expected = name === "甲" ? "111" : "222";
      assert.equal(val, expected, `${name} 在 ${phase} 拿到了错误的 userId=${val}`);
    }
  }
});

test("并发群聊与私聊：来源键各自正确（对应记忆写错来源的真实事故）", async () => {
  async function turn(chatType, userId, targetId, delay) {
    return runWithTurnCtx({ chatType, userId, targetId }, async () => {
      await sleep(delay);
      const c = getTurnCtx();
      // 复刻 memorySourceOf 的规则
      return c.chatType === "group" ? `group:${c.targetId}` : `private:${c.userId}`;
    });
  }
  const [priv, grp] = await Promise.all([
    turn("private", "111", "111", 30),
    turn("group", "111", "999", 5),
  ]);
  assert.equal(priv, "private:111", "私聊来源必须是私聊");
  assert.equal(grp, "group:999", "群来源必须用群号");
});

test("并发时发送目标不会串（对应「消息发进别人会话」）", async () => {
  async function send(delay) {
    return runWithTurnCtx({ chatType: "private", userId: "A", targetId: "A" }, async () => {
      await sleep(delay);
      return getTurnCtx().targetId;
    });
  }
  const results = await Promise.all([send(30), send(5), send(15)]);
  assert.deepEqual(results, ["A", "A", "A"]);
});

test("嵌套回合：内层覆盖外层，退出后外层恢复", async () => {
  await runWithTurnCtx(ctxOf("外", "111"), async () => {
    assert.equal(getTurnCtx().userId, "111");
    await runWithTurnCtx(ctxOf("内", "222"), async () => {
      assert.equal(getTurnCtx().userId, "222");
    });
    assert.equal(getTurnCtx().userId, "111", "退出内层后应恢复外层");
  });
});

test("同步抛错时上下文不会泄漏到后续代码", async () => {
  await assert.rejects(async () => {
    await runWithTurnCtx(ctxOf("甲", "111"), async () => {
      throw new Error("boom");
    });
  });
  assert.equal(getTurnCtx(), null);
});

test("多个并发回合各自独立结束，互不影响", async () => {
  const done = [];
  const mk = (n, d) =>
    runWithTurnCtx(ctxOf(`u${n}`, `u${n}`), async () => {
      await sleep(d);
      done.push(getTurnCtx().userId);
    });
  await Promise.all([mk(1, 20), mk(2, 5), mk(3, 12)]);
  assert.deepEqual(done.sort(), ["u1", "u2", "u3"]);
});
