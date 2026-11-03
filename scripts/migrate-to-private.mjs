#!/usr/bin/env node
/**
 * 迁移到 private/ 布局 —— 把散落各处的私密数据收进单一 private/ 目录
 *
 * 【背景】原先私密数据散在仓库各处（config.json / sessions/ / workspace/ /
 * browser-profile/ …），只能靠 .gitignore 逐条列，发布还得另跑一份「导出公开版」。
 * 改成单一 private/ 后：.gitignore 只忽略一行，仓库可直接 push/pull。
 *
 * 【行为】
 *   默认 **dry-run**（只打印计划，不动任何文件）。
 *   加 --apply 才真正搬。
 *
 * 【为什么用 rename 而不是复制】
 *   总计约 1.3GB（workspace 739M + browser-profile 488M + tmp 424M…）。
 *   同一文件系统内 rename 是元数据操作，瞬间完成；复制则要几十分钟且占双倍空间。
 *   rename 失败（跨设备等）才回退到「复制 + 删除」。
 *
 * 【安全性】
 *   · 目标已存在时**跳过**（不覆盖），避免误伤已经搬过去的数据；
 *   · 全程只做「移动」，不删除源以外的任何东西；失败即报错退出，不半途静默；
 *   · 搬完打印一份校验清单（源已空、目标已存）。
 *
 * 用法：
 *   node scripts/migrate-to-private.mjs            # 预览
 *   node scripts/migrate-to-private.mjs --apply    # 执行
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APPLY = process.argv.includes("--apply");
const PRIVATE = path.join(ROOT, "private");

/**
 * 迁移清单：源（相对 ROOT）→ 目标（相对 PRIVATE）
 *
 * 注：**不含 napcat/**。NapCat 是外部 screen 托管的独立进程，
 * 挪动它的数据目录会导致 QQ 掉线需要重新扫码登录 —— 代价太大。
 * 它继续由 .gitignore 忽略（不影响「仓库可直接 push/pull」这个目标）。
 */
const PLAN = [
  // ── 配置类 ──
  ["config.json", "config.json"],
  ["whitelist.json", "whitelist.json"],
  [".cc-pool.json", ".cc-pool.json"],
  [".private-terms", ".private-terms"],
  [".napcat-offline-count", ".napcat-offline-count"],
  ["win-agent/config.json", "win-agent/config.json"],

  // ── 人设（作者的私人设定）──
  ["prompt/context/2x.md", "persona/2x.md"],

  // ── 运行期目录 ──
  ["sessions", "sessions"],
  ["state", "state"],
  ["logs", "logs"],
  ["workspace", "workspace"],
  ["sandbox", "sandbox"],
  ["agent-dir", "agent-dir"],
  ["browser-profile", "browser-profile"],
  ["browser-profile-op", "browser-profile-op"],
  ["tmp", "tmp"],
];

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
  } catch {
    return 0;
  }
  let total = 0;
  const walk = (d) => {
    let names;
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
        else if (e.isSymbolicLink()) total += 0; // 悬空链接按 0 计
      } catch {
        /* 悬空/无权限，跳过 */
      }
    }
  };
  walk(p);
  return total;
}

const human = (n) => (n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)}GB` : n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`);

console.log(`═══ 迁移到 private/ ${APPLY ? "【执行】" : "【预览 · 加 --apply 才真正搬】"} ═══\n`);
console.log(`private/ 目标：${PRIVATE}`);
console.log(`是否存在：${fs.existsSync(PRIVATE) ? "是" : "否（将创建）"}\n`);

let willMove = 0;
let willSkip = 0;
let bytes = 0;
const todo = [];

for (const [srcRel, dstRel] of PLAN) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(PRIVATE, dstRel);
  const hasSrc = fs.existsSync(src);
  const hasDst = fs.existsSync(dst);
  const sz = hasSrc ? sizeOf(src) : 0;

  let mark;
  if (!hasSrc && hasDst) mark = "✅ 已就位（源已不在）";
  else if (!hasSrc && !hasDst) mark = "○  两边都没有（跳过）";
  else if (hasSrc && hasDst) {
    mark = "⚠️  目标已存在（跳过，不覆盖）";
    willSkip++;
  } else {
    mark = "→ 待迁移";
    willMove++;
    bytes += sz;
    todo.push([src, dst, srcRel]);
  }
  console.log(`  ${mark.padEnd(26)} ${srcRel.padEnd(28)} → private/${dstRel.padEnd(22)} ${hasSrc ? human(sz) : ""}`);
}

console.log(`\n合计：待迁移 ${willMove} 项（${human(bytes)}），跳过 ${willSkip} 项`);

if (!APPLY) {
  console.log("\n（预览结束，未改动任何文件。加 --apply 执行。）");
  process.exit(0);
}

if (!todo.length) {
  console.log("\n无需迁移，已是 private/ 布局。");
  process.exit(0);
}

// ── 执行 ──
console.log("\n开始迁移…");
fs.mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });

let moved = 0;
const failed = [];
for (const [src, dst, srcRel] of todo) {
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      // 同分区：秒级
      fs.renameSync(src, dst);
    } catch (e) {
      if (e.code !== "EXDEV" && e.code !== "EPERM") throw e;
      // 跨设备/权限：复制后删除
      fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
      fs.rmSync(src, { recursive: true, force: true });
    }
    moved++;
    console.log(`  ✅ ${srcRel}`);
  } catch (e) {
    failed.push([srcRel, e.message]);
    console.log(`  ❌ ${srcRel} —— ${e.message}`);
  }
}

// ── 校验 ──
console.log(`\n已迁移 ${moved}/${todo.length} 项`);
if (failed.length) {
  console.log("\n失败项：");
  for (const [f, m] of failed) console.log(`  · ${f}: ${m}`);
}
console.log("\n校验（源应已为空，目标应存在）：");
for (const [, dst, srcRel] of todo) {
  const src = path.join(ROOT, srcRel);
  const okSrc = !fs.existsSync(src);
  const okDst = fs.existsSync(dst);
  console.log(`  ${okSrc && okDst ? "✅" : "⚠️ "} ${srcRel}: 源已清=${okSrc} 目标在=${okDst}`);
}

console.log("\n完成。建议接着跑：node scripts/preflight.mjs");
process.exit(failed.length ? 1 : 0);
