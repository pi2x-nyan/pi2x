/**
 * 端到端验证：瘦身是否真的「语义等价」
 *
 * 单测用的是人造会话文件，但真正的风险在于「真实文件的字段组合」——
 * 所以这个测试直接拿 sessions/ 下真实存在的、最大的会话文件做验证：
 *   1. 复制一份，对副本执行瘦身
 *   2. 用 pi 自己的 SessionManager 分别打开原文件与瘦身文件
 *   3. 对比 buildContextEntries() 的条目 id 序列 —— 必须逐项一致
 *
 * 若会话目录里没有足够大的文件（例如全新部署），测试自动跳过。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { slimFile, survey } from "../lib/sessions-maint.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SESSIONS = path.join(ROOT, "sessions");
const MIN_SIZE = 200 * 1024; // 小于 200KB 的文件没有压缩历史，验证没意义

function biggestSession() {
  try {
    const s = survey(SESSIONS);
    return s.files.find((f) => f.bytes >= MIN_SIZE && !f.stale) ?? null;
  } catch {
    return null;
  }
}

test("真实会话瘦身后，模型可见上下文逐项一致（id 序列完全相同）", (t) => {
  const target = biggestSession();
  if (!target) {
    t.skip("会话目录里没有 >=200KB 的会话文件，跳过");
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slim-e2e-"));
  const copy = path.join(tmpDir, path.basename(target.path));
  fs.copyFileSync(target.path, copy);

  // 用 pi 读原文件 → 上下文 id 序列
  const beforeIds = SessionManager.open(copy)
    .buildContextEntries()
    .map((e) => e.id);

  // 瘦身（副本，minIdleMs=0 绕过空闲检查）
  const r = slimFile(copy, { minIdleMs: 0 });
  if (r.skipped) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    t.skip(`该文件无法瘦身：${r.reason}`);
    return;
  }

  const afterIds = SessionManager.open(copy)
    .buildContextEntries()
    .map((e) => e.id);

  assert.equal(afterIds.length, beforeIds.length, `上下文条目数必须相同：${beforeIds.length} vs ${afterIds.length}`);
  assert.deepEqual(afterIds, beforeIds, "上下文条目 id 序列必须逐项一致（顺序也不能变）");

  // 顺便确认真的变小了，且备份存在
  assert.ok(r.after < r.before, "瘦身后应更小");
  const bdir = path.join(tmpDir, ".backup");
  assert.ok(fs.existsSync(bdir) && fs.readdirSync(bdir).length === 1, "应留下 1 份备份");

  console.log(
    `    ↳ ${path.basename(target.path)}: ${(r.before / 1024 / 1024).toFixed(2)}MB → ${(r.after / 1024).toFixed(1)}KB` +
      ` (上下文 ${beforeIds.length} 条完全一致)`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("真实会话瘦身后仍可被 pi 正常打开（leafId 可解析）", (t) => {
  const target = biggestSession();
  if (!target) {
    t.skip("会话目录里没有 >=200KB 的会话文件，跳过");
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slim-e2e2-"));
  const copy = path.join(tmpDir, path.basename(target.path));
  fs.copyFileSync(target.path, copy);
  const r = slimFile(copy, { minIdleMs: 0 });
  if (r.skipped) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    t.skip(`该文件无法瘦身：${r.reason}`);
    return;
  }
  const s = SessionManager.open(copy);
  assert.ok(s.getLeafId(), "leafId 应可解析");
  assert.ok(s.getEntries().length > 0, "应能读出条目");
  assert.ok(s.buildContextEntries().length > 0, "上下文不应为空");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
