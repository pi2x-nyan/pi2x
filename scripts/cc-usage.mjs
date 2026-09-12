#!/usr/bin/env node
/**
 * Command Code 号池用量 CLI
 *   node scripts/cc-usage.mjs            # 人类可读汇总（等同 /status 中的段落）
 *   node scripts/cc-usage.mjs --json     # 机器可读
 *   node scripts/cc-usage.mjs --local    # 只看本地缓存命中统计
 */
import { statusLines, snapshot, localCacheStats, fmtTokens, CC_USAGE } from "../lib/ccusage.mjs";

const args = process.argv.slice(2);
if (args.includes("--local")) {
  const s = localCacheStats({ sinceTs: 0 });
  console.log(`调用 ${s.calls} 次 · 输入 ${fmtTokens(s.tokensIn)} · 输出 ${fmtTokens(s.tokensOut)} · 缓存读 ${fmtTokens(s.cacheRead)} · 命中率 ${(s.hitRate * 100).toFixed(1)}%`);
  console.log(`日志目录: ${CC_USAGE.logsDir} · 账号匹配: ${CC_USAGE.accountMatch}${s.error ? " · 错误: " + s.error : ""}`);
  process.exit(0);
}
const snap = await snapshot({ force: true });
if (args.includes("--json")) {
  console.log(JSON.stringify(snap, null, 2));
  process.exit(snap.ok ? 0 : 1);
}
const text = await statusLines();
console.log(text ?? "（取数失败）");
console.log("");
console.log("各账号明细：");
for (const a of snap.accounts) {
  if (!a.ok) { console.log(`  ${a.name}: 失败（${a.error}）`); continue; }
  console.log(`  ${a.name}: 剩 $${a.monthlyLeft.toFixed(2)} · ${a.requests} 次 · in ${fmtTokens(a.tokensIn)} / out ${fmtTokens(a.tokensOut)} · 花费 $${a.cost.toFixed(3)} · 5h ${a.fiveHour?.used ?? 0}/${a.fiveHour?.cap ?? 0}`);
}
process.exit(snap.ok ? 0 : 1);
