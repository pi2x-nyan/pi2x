import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MODES,
  DEFAULTS,
  normalizeMode,
  readMode,
  writeMode,
  touchHeartbeat,
  readHeartbeat,
  heartbeatAge,
  decide,
  resetAttempts,
} from "../lib/mode.mjs";
import { checkRestartLock } from "../lib/lifecycle.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mode-"));
const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true });

// ── 值域与读写 ────────────────────────────────────────────────────────────

test("normalizeMode：非法值一律回落 normal（宁可跑完整的，不卡在残缺模式）", () => {
  assert.equal(normalizeMode("normal"), "normal");
  assert.equal(normalizeMode("SAFE"), "safe");
  assert.equal(normalizeMode(" rollback "), "rollback");
  assert.equal(normalizeMode("bogus"), "normal");
  assert.equal(normalizeMode(null), "normal");
  assert.equal(normalizeMode(undefined), "normal");
  assert.deepEqual(MODES, ["normal", "safe", "rollback"]);
});

test("readMode：文件缺失 → normal，且不算损坏", () => {
  const d = tmpDir();
  const r = readMode(d);
  assert.equal(r.mode, "normal");
  assert.equal(r.corrupt, false);
  assert.equal(r.normalAttempts, 0);
  cleanup(d);
});

test("readMode：文件损坏 → normal 且标记 corrupt（不抛异常）", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "mode.json"), "{ 这不是 JSON");
  const r = readMode(d);
  assert.equal(r.mode, "normal");
  assert.equal(r.corrupt, true);
  cleanup(d);
});

test("writeMode：原子写 + 计数与缘由正确保留", () => {
  const d = tmpDir();
  writeMode(d, { mode: "safe", reason: "测试", normalAttempts: 2 });
  const r = readMode(d);
  assert.equal(r.mode, "safe");
  assert.equal(r.normalAttempts, 2);
  assert.equal(r.reason, "测试");
  assert.ok(r.since, "应记录切换时间");
  // 没有临时文件残留
  assert.ok(!fs.readdirSync(d).some((f) => f.includes(".tmp")), "不该留下临时文件");
  cleanup(d);
});

test("writeMode：切换模式会刷新 since，但同模式重复写不刷", () => {
  const d = tmpDir();
  writeMode(d, { mode: "safe", now: 1000 });
  const a = readMode(d).since;
  writeMode(d, { mode: "safe", now: 2000 });
  assert.equal(readMode(d).since, a, "同模式不该刷新 since");
  writeMode(d, { mode: "rollback", now: 3000 });
  assert.notEqual(readMode(d).since, a, "换模式应刷新 since");
  cleanup(d);
});

test("resetAttempts：可分别清零 normal / safe / 全部", () => {
  const d = tmpDir();
  writeMode(d, { normalAttempts: 3, safeAttempts: 2 });
  resetAttempts(d, "normal");
  assert.deepEqual([readMode(d).normalAttempts, readMode(d).safeAttempts], [0, 2]);
  writeMode(d, { normalAttempts: 1 });
  resetAttempts(d, "safe");
  assert.deepEqual([readMode(d).normalAttempts, readMode(d).safeAttempts], [1, 0]);
  resetAttempts(d, true);
  assert.deepEqual([readMode(d).normalAttempts, readMode(d).safeAttempts], [0, 0]);
  cleanup(d);
});

// ── 心跳 ──────────────────────────────────────────────────────────────────

test("心跳：写入后可读，且年龄随 now 变化", () => {
  const d = tmpDir();
  touchHeartbeat(d, 10_000);
  assert.equal(heartbeatAge(d, 10_500), 500);
  assert.equal(heartbeatAge(d, 10_000), 0);
  cleanup(d);
});

test("心跳：文件不存在 → Infinity（表示「从没活过」）", () => {
  const d = tmpDir();
  assert.equal(heartbeatAge(d), Infinity);
  cleanup(d);
});

test("心跳：内容损坏 → Infinity（不抛异常）", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "heartbeat"), "乱七八糟");
  assert.equal(heartbeatAge(d), Infinity);
  cleanup(d);
});

test("心跳：未来时间戳不会得到负数（防时钟回拨误判）", () => {
  const d = tmpDir();
  touchHeartbeat(d, 100_000);
  assert.equal(heartbeatAge(d, 50_000), 0);
  cleanup(d);
});

// ── 决策：完整降级链 ──────────────────────────────────────────────────────

test("降级链①：正常模式健康 → 什么都不做", () => {
  assert.equal(decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: 1000 }).action, "none");
  assert.equal(decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: 179_000 }).action, "none");
});

test("降级链②：进程死了 → 先自救三次（看门狗自动拉起正常模式）", () => {
  for (const n of [0, 1, 2]) {
    const r = decide({ mode: "normal", normalAlive: false, normalAttempts: n });
    assert.equal(r.action, "restart-normal", `第 ${n + 1} 次应为自动拉起`);
    assert.match(r.reason, new RegExp(`第 ${n + 1}/3 次`));
  }
});

test("降级链③：自救三次都失败 → 降级到安全模式", () => {
  const r = decide({ mode: "normal", normalAlive: false, normalAttempts: 3 });
  assert.equal(r.action, "degrade-safe");
  assert.match(r.reason, /3 次/);
});

test("降级链：心跳停了同样先自救三次，再降级", () => {
  assert.equal(decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: 300_000, normalAttempts: 0 }).action, "restart-normal");
  assert.equal(decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: 300_000, normalAttempts: 2 }).action, "restart-normal");
  assert.equal(decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: 300_000, normalAttempts: 3 }).action, "degrade-safe");
});

test("降级链：心跳文件从未存在时给宽限期（仅凭进程存活判定健康）", () => {
  // 否则一部署看门狗就会把健康的进程反复重启
  const r = decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: Infinity, normalAttempts: 0 });
  assert.equal(r.action, "none");
});

test("降级链④：安全模式运行中 → 不动它（agent 正在自救）", () => {
  assert.equal(decide({ mode: "safe", safeAlive: true, heartbeatAgeMs: 1000 }).action, "none");
});

test("降级链⑤：安全模式不在 → 拉起，最多三次", () => {
  for (const n of [0, 1, 2]) {
    const r = decide({ mode: "safe", safeAlive: false, safeAttempts: n });
    assert.equal(r.action, "start-safe");
    assert.match(r.reason, new RegExp(`第 ${n + 1}/3 次`));
  }
});

test("降级链⑥：安全模式也三次拉不起来 → 回退模式", () => {
  const r = decide({ mode: "safe", safeAlive: false, safeAttempts: 3 });
  assert.equal(r.action, "degrade-rollback");
});

test("回退模式：不再自动做任何事（等人工处理）", () => {
  const r = decide({ mode: "rollback", normalAlive: false, safeAlive: false });
  assert.equal(r.action, "none");
  assert.match(r.reason, /人工/);
});

test("行为异常只告警，永不降级（看门狗误判会变成新的故障源）", () => {
  const r = decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: 1000, abnormal: true });
  assert.equal(r.action, "alert");
  assert.match(r.reason, /不降级/);
});

test("阈值可被配置覆盖（maxNormalAttempts / heartbeatStaleMs）", () => {
  assert.equal(decide({ mode: "normal", normalAlive: false, normalAttempts: 1, maxNormalAttempts: 1 }).action, "degrade-safe");
  assert.equal(decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: 5000, heartbeatStaleMs: 1000 }).action, "restart-normal");
  assert.equal(decide({ mode: "normal", normalAlive: true, heartbeatAgeMs: 500, heartbeatStaleMs: 1000 }).action, "none");
});

test("空参数调用不抛异常（回落到 normal + 什么都不做）", () => {
  assert.doesNotThrow(() => decide());
  assert.equal(decide().action, "restart-normal");
});

test("DEFAULTS 冻结且有合理默认", () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.equal(DEFAULTS.maxNormalAttempts, 3, "看门狗自救三次");
  assert.equal(DEFAULTS.maxSafeAttempts, 3);
  assert.equal(DEFAULTS.heartbeatIntervalMs, 60_000);
  assert.ok(DEFAULTS.heartbeatStaleMs > DEFAULTS.heartbeatIntervalMs, "过期阈值必须大于心跳间隔，否则会误判");
});

// ── 心跳归属校验（踩过的坑：残留心跳导致刚重启的进程被误判为卡死）────────────

test("心跳内容带进程号（用于识别残留）", () => {
  const d = tmpDir();
  touchHeartbeat(d, 5000);
  const hb = readHeartbeat(d);
  assert.equal(hb.pid, process.pid, "应写入当前进程 pid");
  assert.equal(hb.ts, 5000);
  cleanup(d);
});

test("残留心跳：心跳属于已消失的进程 → 视为没有心跳（Infinity）", () => {
  const d = tmpDir();
  touchHeartbeat(d, 5000);
  // 假设当前存活进程是别的 pid（模拟「进程重启后旧心跳还在」）
  const age = heartbeatAge(d, 10_000, { alivePids: [999999] });
  assert.equal(age, Infinity, "不属于存活进程的心跳必须被判为无效");
  cleanup(d);
});

test("有效心跳：心跳属于存活进程 → 正常计算年龄", () => {
  const d = tmpDir();
  touchHeartbeat(d, 5000);
  const age = heartbeatAge(d, 10_000, { alivePids: [process.pid] });
  assert.equal(age, 5000);
  cleanup(d);
});

test("传递空存活列表 → 任何心跳都算残留", () => {
  const d = tmpDir();
  touchHeartbeat(d, 5000);
  assert.equal(heartbeatAge(d, 6000, { alivePids: [] }), Infinity);
  cleanup(d);
});

test("不传 alivePids 时保持旧行为（只按时间判断）", () => {
  const d = tmpDir();
  touchHeartbeat(d, 5000);
  assert.equal(heartbeatAge(d, 6000), 1000);
  cleanup(d);
});

test("兼容旧的「纯时间戳」心跳格式（pid 未知时不参与归属校验）", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "heartbeat"), "12345\n");
  const hb = readHeartbeat(d);
  assert.equal(hb.pid, null);
  assert.equal(hb.ts, 12345);
  // 旧格式在传 alivePids 时仍按时间算（pid 未知，无法归因）
  assert.equal(heartbeatAge(d, 13000, { alivePids: [1] }), 655);
  cleanup(d);
});

test("回归：陈旧残留心跳不会导致刚启动的进程被误判为卡死", () => {
  const d = tmpDir();
  // 模拟：上一个进程 4 小时前写了心跳后死了；新进程刚起来（pid 不同）
  touchHeartbeat(d, Date.now() - 4 * 3600 * 1000);
  const fakeNewPid = process.pid + 1;
  const d2 = decide({
    mode: "normal",
    normalAlive: true,
    heartbeatAgeMs: heartbeatAge(d, Date.now(), { alivePids: [fakeNewPid] }),
  });
  assert.equal(d2.action, "none", "应判定健康，而不是准备重启一个刚启动的进程");
  cleanup(d);
});

// ── 重启锁：只跳一轮（2026-09-13 真实事故）──────────────────────────────

test("重启锁：第一次跳过，第二轮照常探活（同一把锁只跳一次）", () => {
  // 【事故】watchdog 由 cron 每分钟跑一次，只看「进程存活+心跳新鲜」，不知道有人在重启。
  // restart-pi2x.sh 从杀进程到新进程就绪有约 54 秒空窗，cron 落进去就抢先拉起，
  // 用户收到的是「被看门狗自动拉起」而不是「已重启完成」。两次真实重启都撞上了。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "restart.lock"), `1234 ${now}`);

  const first = checkRestartLock({ stateDir: dir, now });
  assert.equal(first.skip, true, "第一次必须跳过（正在重启）");

  const second = checkRestartLock({ stateDir: dir, now: now + 30_000 });
  assert.equal(second.skip, false, "同一把锁第二轮不得再跳（否则残留死锁让探活永久失效）");
});

test("重启锁：过期即失效（重启最多被容忍 TTL 这么久）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "restart.lock"), `1234 ${now}`);
  const r = checkRestartLock({ stateDir: dir, now: now + 200_000, ttlMs: 120_000 });
  assert.equal(r.skip, false, "超过 TTL 必须照常探活");
  assert.match(r.reason, /过期/);
});

test("重启锁：换了新锁（新一轮重启）应重新跳过一轮", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "restart.lock"), `1111 ${now}`);
  assert.equal(checkRestartLock({ stateDir: dir, now }).skip, true, "第一把锁：跳过");
  assert.equal(checkRestartLock({ stateDir: dir, now: now + 1000 }).skip, false, "第一把锁：第二轮不跳");
  // 新一次重启写了新锁
  fs.writeFileSync(path.join(dir, "restart.lock"), `2222 ${now + 2000}`);
  assert.equal(
    checkRestartLock({ stateDir: dir, now: now + 3000 }).skip,
    true,
    "新锁要重新享有一轮豁免",
  );
});

test("重启锁：无锁 / 内容损坏都不得跳过", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  assert.equal(checkRestartLock({ stateDir: dir, now: Date.now() }).skip, false, "无锁 → 不跳");
  fs.writeFileSync(path.join(dir, "restart.lock"), "垃圾内容");
  assert.equal(checkRestartLock({ stateDir: dir, now: Date.now() }).skip, false, "损坏 → 不跳");
});

test("重启锁：时间戳必须按毫秒解读（秒级会误判成过期 56 年）", () => {
  // 【真实事故】restart-pi2x.sh 用 `date +%s`（秒，1789303067）写锁，
  // 看门狗用 Node 的 Date.now()（毫秒，1789303067472）做差值 → 差 1000 倍，
  // 刚写的锁被判定「过期 1787513755 秒」，整个防抢拉机制形同虚设。
  // 这条守住量纲：毫秒级时间戳必须被认作「未过期」。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  const nowMs = Date.now();
  fs.writeFileSync(path.join(dir, "restart.lock"), `9999 ${nowMs}`);
  assert.equal(checkRestartLock({ stateDir: dir, now: nowMs }).skip, true, "毫秒时间戳：应视为未过期");

  // 反向：若误写成秒级（同一时刻的秒），会被判过期 —— 说明修复前就是这样失效的
  const nowSec = Math.floor(nowMs / 1000);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  fs.writeFileSync(path.join(dir2, "restart.lock"), `9999 ${nowSec}`);
  const r = checkRestartLock({ stateDir: dir2, now: nowMs });
  assert.equal(r.skip, false, "秒级时间戳会被判过期（这正是当初的 bug 表现）");
  assert.match(r.reason, /过期/);
});

test("restart-pi2x.sh 写锁必须用毫秒（date +%s%3N）", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/restart-pi2x.sh"), "utf8");
  // 锚定赋值行本身（注释里也提到 restart.lock，不能拿它当锚点）
  const i = src.indexOf('LOCK="$ROOT_DIR/state/restart.lock"');
  assert.ok(i > 0, "找不到锁的写入点");
  const seg = src.slice(i, i + 800);
  assert.ok(seg.includes("date +%s%3N"), "必须用毫秒时间戳 date +%s%3N");
  const writeLine = seg.split("\n").find((l) => l.includes("> \"$LOCK\"")) ?? "";
  assert.ok(writeLine.includes("%3N"), `写锁那行必须带毫秒（实际：${writeLine.trim()}）`);
});
