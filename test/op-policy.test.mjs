import test from "node:test";
import assert from "node:assert/strict";

import { PRESET_LEVEL, GRANTABLE, MAX_GRANT, levelOf, presetNameOf, checkGrant, checkRevoke } from "../lib/op-policy.mjs";

test("等级表与可授予清单", () => {
  assert.deepEqual(PRESET_LEVEL, { dialog: 0, friend: 1, operator: 2, admin: 3 });
  assert.deepEqual(GRANTABLE, ["friend", "operator", "admin"]);
  assert.ok(Object.isFrozen(PRESET_LEVEL) && Object.isFrozen(MAX_GRANT));
});

test("levelOf：字符串 / 数组 / 非法值", () => {
  assert.equal(levelOf("admin"), 3);
  assert.equal(levelOf("operator"), 2);
  assert.equal(levelOf(undefined), 0);
  assert.equal(levelOf("bogus"), 0);
  assert.equal(levelOf(["friend", "operator"]), 2, "数组取最高");
  assert.equal(levelOf(["bogus", "friend"]), 1);
  assert.equal(levelOf([]), 0);
});

test("presetNameOf：数字 → 名字", () => {
  assert.equal(presetNameOf("admin"), "admin");
  assert.equal(presetNameOf(undefined), "dialog");
});

// ── 授予规则 ──────────────────────────────────────────────────────────────

test("admin 可以授予 operator / friend", () => {
  assert.equal(checkGrant({ callerPreset: "admin", targetPreset: undefined, preset: "operator" }).ok, true);
  assert.equal(checkGrant({ callerPreset: "admin", targetPreset: "friend", preset: "friend" }).ok, true);
});

test("admin 不能授予 admin（保持原语义：不得授予同级或更高）", () => {
  // 提权永远需要一次「文件级」操作（admin 本就有 files:full 可直接改 whitelist.json），
  // 而不是一条命令就能复制出第二个最高权限账号。
  const r = checkGrant({ callerPreset: "admin", targetPreset: undefined, preset: "admin" });
  assert.equal(r.ok, false);
  assert.match(r.text, /最多只能授予 operator/);
});

test("admin 不能授予不存在的预设", () => {
  for (const p of ["dialog", "", "superuser", "ADMIN"]) {
    const r = checkGrant({ callerPreset: "admin", targetPreset: undefined, preset: p });
    assert.equal(r.ok, false, `预设 ${JSON.stringify(p)} 不该被接受`);
  }
});

test("operator 只能授予 friend（切断级联提权链）", () => {
  assert.equal(checkGrant({ callerPreset: "operator", targetPreset: undefined, preset: "friend" }).ok, true);
  for (const p of ["operator", "admin"]) {
    const r = checkGrant({ callerPreset: "operator", targetPreset: undefined, preset: p });
    assert.equal(r.ok, false, `operator 不该能授予 ${p}`);
    assert.match(r.text, /最多只能授予 friend/);
  }
});

test("回归：operator 不能给自己提权到 admin（这就是已修复的漏洞）", () => {
  // 修复前：qq-cli 那边一旦 allowOpEscalation=true 就整个跳过校验，
  // 任何 operator 都能执行 `qq-cli op <自己> admin` 把自己变成 files:full。
  const r = checkGrant({ callerPreset: "operator", targetPreset: "operator", preset: "admin" });
  assert.equal(r.ok, false, "必须拒绝");
  const r2 = checkGrant({ callerPreset: "operator", targetPreset: undefined, preset: "admin" });
  assert.equal(r2.ok, false, "即使目标当前无权限，也不能授出超过自己上限的档位");
});

test("operator 不能修改同级或更高", () => {
  assert.equal(checkGrant({ callerPreset: "operator", targetPreset: "operator", preset: "friend" }).ok, false);
  assert.equal(checkGrant({ callerPreset: "operator", targetPreset: "admin", preset: "friend" }).ok, false);
});

test("friend 与 dialog 没有任何授予能力", () => {
  for (const caller of ["friend", "dialog", undefined]) {
    const r = checkGrant({ callerPreset: caller, targetPreset: undefined, preset: "friend" });
    assert.equal(r.ok, false, `${caller} 不该能授予任何权限`);
  }
});

// ── 隐私：拒绝文案不得泄露对方等级 ─────────────────────────────────────────

test("拒绝文案里不出现任何等级数字（防止靠试错探测他人权限）", () => {
  const cases = [
    checkGrant({ callerPreset: "operator", targetPreset: "admin", preset: "friend" }),
    checkGrant({ callerPreset: "operator", targetPreset: undefined, preset: "admin" }),
    checkGrant({ callerPreset: "friend", targetPreset: undefined, preset: "friend" }),
    checkRevoke({ callerPreset: "operator", targetPreset: "admin" }),
    checkRevoke({ callerPreset: "operator", targetPreset: "operator" }),
    checkRevoke({ callerPreset: "operator", targetPreset: "admin", isTargetSelf: true }),
  ];
  for (const r of cases) {
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.text, /\d/, `文案里含数字（可能泄露等级）: ${r.text}`);
  }
});

test("文案不透露「目标是否在白名单里」", () => {
  const r = checkGrant({ callerPreset: "operator", targetPreset: "admin", preset: "friend" });
  const r2 = checkGrant({ callerPreset: "operator", targetPreset: undefined, preset: "friend" });
  assert.equal(r2.ok, true, "无权限的目标应可直接授予 friend");
  // 两条路径的失败文案不应出现「该用户/该QQ已授权」之类可判定归属的措辞
  for (const t of [r.text, r2.text ?? ""]) {
    assert.doesNotMatch(t, /已授权|在白名单|不在白名单/);
  }
});

// ── 撤销规则 ──────────────────────────────────────────────────────────────

test("不能撤销自己（避免自锁）", () => {
  const r = checkRevoke({ callerPreset: "admin", targetPreset: "admin", isTargetSelf: true });
  assert.equal(r.ok, false);
  assert.match(r.text, /自己/);
});

test("operator 只能撤销 friend 档", () => {
  assert.equal(checkRevoke({ callerPreset: "operator", targetPreset: "friend" }).ok, true);
  assert.equal(checkRevoke({ callerPreset: "operator", targetPreset: "operator" }).ok, false);
  assert.equal(checkRevoke({ callerPreset: "operator", targetPreset: "admin" }).ok, false);
});

test("admin 可以撤销 operator / friend", () => {
  assert.equal(checkRevoke({ callerPreset: "admin", targetPreset: "operator" }).ok, true);
  assert.equal(checkRevoke({ callerPreset: "admin", targetPreset: "friend" }).ok, true);
});

test("friend / dialog 无撤销能力", () => {
  for (const caller of ["friend", "dialog", undefined]) {
    assert.equal(checkRevoke({ callerPreset: caller, targetPreset: "friend" }).ok, false);
  }
});

test("空参数调用不抛异常", () => {
  assert.doesNotThrow(() => checkGrant({}));
  assert.doesNotThrow(() => checkRevoke({}));
  assert.equal(checkGrant({}).ok, false);
});
