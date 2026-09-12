/**
 * 压缩设置单一来源的回归测试。
 *
 * 背景（真实事故）：pi 的压缩摘要输出上限 = min(floor(0.8 × reserveTokens), model.maxTokens)。
 * 而 `SettingsManager.inMemory()` 不带参数时 reserveTokens 默认只有 16384，
 * 即摘要最多写 13107 token。历史一长（实测 1544 条 / 55 万 token）摘要就被截断，
 * pi 判定「摘要不完整」并**静默放弃整次压缩** —— 外部表现是「压缩没反应、上下文不变」，
 * 且同规模输入一次成功一次失败（随机性），极难定位。
 *
 * 本测试锁死：摘要预算必须**大于** pi 默认值（否则截断），且设置必须真的传递进 SettingsManager。
 *
 * 注意当前预算（40983 ⇒ 摘要上限 32786）是**用户指定**的，不等于「越大越好」。
 * 断言写成「高于触发事故的下限」，而非绑定某个具体大数：
 *   · 必须 > pi 默认 16384（否则摘要上限只有 13107，注定截断）；
 *   · 摘要上限必须高于实测真实用量（42 万 token 历史 → 摘要约 7.1K token）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeSettingsManager, SUMMARIZATION_RESERVE_TOKENS, KEEP_RECENT_TOKENS } from "../lib/agent/settings.mjs";

/** pi 的默认 reserveTokens —— 低于此预算会触发上面的截断事故 */
const PI_DEFAULT_RESERVE_TOKENS = 16384;

test("makeSettingsManager：reserveTokens 必须高于 pi 默认值（防摘要被截断）", () => {
  const s = makeSettingsManager().getCompactionSettings();
  assert.equal(s.reserveTokens, SUMMARIZATION_RESERVE_TOKENS);
  assert.ok(
    s.reserveTokens > PI_DEFAULT_RESERVE_TOKENS,
    `摘要预算 ${s.reserveTokens} 不得低于 pi 默认（${PI_DEFAULT_RESERVE_TOKENS}），否则摘要上限仅 13107 必被截断`,
  );
});

test("makeSettingsManager：摘要输出上限（0.8×reserveTokens）符合约定且高于实测所需", () => {
  const s = makeSettingsManager().getCompactionSettings();
  const summaryBudget = Math.floor(0.8 * s.reserveTokens);
  // 用户指定：摘要上限恰为 32786
  assert.equal(summaryBudget, 32786, `摘要上限应为 32786，实际 ${summaryBudget}`);
  // 实测摘要真实用量约 7.1K token（42.4 万 token 历史 / 24.9K 字符），必须留足余量
  assert.ok(summaryBudget > 10000, `摘要上限 ${summaryBudget} 低于实测所需，可能被截断`);
});

test("makeSettingsManager：keepRecentTokens 被显式设置且为有限正数", () => {
  const s = makeSettingsManager().getCompactionSettings();
  assert.equal(s.keepRecentTokens, KEEP_RECENT_TOKENS);
  assert.ok(Number.isFinite(s.keepRecentTokens) && s.keepRecentTokens > 0);
});

test("makeSettingsManager：压缩功能保持启用", () => {
  assert.equal(makeSettingsManager().getCompactionSettings().enabled, true);
});

test("makeSettingsManager：允许调用方覆盖，且不污染其他设置键", () => {
  const s = makeSettingsManager({ compaction: { keepRecentTokens: 1234 } });
  const cs = s.getCompactionSettings();
  assert.equal(cs.keepRecentTokens, 1234, "覆盖未生效");
  assert.equal(cs.reserveTokens, SUMMARIZATION_RESERVE_TOKENS, "覆盖某一字段时不应丢掉其他字段");
  assert.equal(cs.enabled, true);
});

test("makeSettingsManager：入参非法时不崩，回落到内置默认", () => {
  const s = makeSettingsManager({ compaction: { reserveTokens: -1, keepRecentTokens: NaN } });
  const cs = s.getCompactionSettings();
  // NaN / 负数应被替换成默认值，绝不能把 undefined/NaN 传下去（会导致摘要预算变成 NaN）
  assert.ok(Number.isFinite(cs.reserveTokens) && cs.reserveTokens > 0, `reserveTokens 非法: ${cs.reserveTokens}`);
  assert.ok(Number.isFinite(cs.keepRecentTokens) && cs.keepRecentTokens > 0, `keepRecentTokens 非法: ${cs.keepRecentTokens}`);
});

test("配置项可覆盖默认（config.json 的 pi.compactionReserveTokens 生效）", async () => {
  const { config } = await import("../lib/config.mjs");
  const s = makeSettingsManager().getCompactionSettings();
  assert.equal(s.reserveTokens, Number(config.pi.compactionReserveTokens ?? SUMMARIZATION_RESERVE_TOKENS));
  assert.equal(s.keepRecentTokens, Number(config.pi.compactionKeepRecentTokens ?? KEEP_RECENT_TOKENS));
});

test("全仓库不得再出现裸的 SettingsManager.inMemory()（防止绕过统一设置）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const offenders = [];
  // test/ 本身要排除：本文件就是靠字面量 "SettingsManager.inMemory(" 做检查的，
  // 不排除会把自己也算成违规者。
  const skip = new Set(["node_modules", ".git", "tmp", "sandbox", "downloads", "logs", "state", "test"]);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".mjs")) {
        const src = fs.readFileSync(full, "utf8");
        // settings.mjs 自己就是唯一允许调用 inMemory() 的地方
        if (path.basename(full) === "settings.mjs") continue;
        if (/SettingsManager\.inMemory\(/.test(src)) offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `以下文件绕过统一设置直接调用了 SettingsManager.inMemory()：${offenders.join(", ")}`);
});
