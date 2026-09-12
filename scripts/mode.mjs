#!/usr/bin/env node
/**
 * 模式切换 CLI —— 人工/agent 用来查看与切换运行模式
 *
 * 用法：
 *   node scripts/mode.mjs                       # 查看当前模式与健康状态
 *   node scripts/mode.mjs normal                # 切到正常模式（**会先跑冒烟检查**）
 *   node scripts/mode.mjs safe                  # 切到安全模式
 *   node scripts/mode.mjs rollback [--dry-run]  # 执行回退
 *   node scripts/mode.mjs mark-good [--note 说明] # 把当前 commit 标为「已验证可用」
 *   node scripts/mode.mjs reset-attempts        # 清零自动拉起计数
 *   node scripts/mode.mjs status --json
 *
 * 【切回正常模式必须过闸门】
 *   从安全模式切回正常模式时，会先跑 scripts/preflight.mjs（语法 + 模块导入 + 测试）。
 *   不通过就拒绝切换 —— 否则会在「修不好」和「又坏了」之间反复震荡。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ROOT, STATE_DIR, LOGS_DIR } from "../lib/config.mjs";
import { readMode, writeMode, heartbeatAge, DEFAULTS, MODES } from "../lib/mode.mjs";
import { isAlive, killMode, spawnMode, waitReady, countLogLines } from "../lib/lifecycle.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const JSON_OUT = flags.has("--json");
const DRY = flags.has("--dry-run");
const KNOWN_GOOD = path.join(STATE_DIR, "known-good.json");

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;

function snapshot() {
  const st = readMode(STATE_DIR);
  const hb = heartbeatAge(STATE_DIR);
  return {
    ...st,
    normalAlive: isAlive("normal"),
    safeAlive: isAlive("safe"),
    heartbeatAgeMs: Number.isFinite(hb) ? hb : null,
    heartbeatStaleMs: DEFAULTS.heartbeatStaleMs,
    knownGood: (() => {
      try {
        return JSON.parse(fs.readFileSync(KNOWN_GOOD, "utf8"));
      } catch {
        return null;
      }
    })(),
    head: (() => {
      try {
        return execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })(),
  };
}

function printStatus(s) {
  const hb = s.heartbeatAgeMs === null ? "无心跳文件" : `${Math.round(s.heartbeatAgeMs / 1000)} 秒前`;
  const stale = s.heartbeatAgeMs !== null && s.heartbeatAgeMs > s.heartbeatStaleMs;
  console.log(`当前模式   ${s.mode === "normal" ? ok(s.mode) : warn(s.mode)}${s.reason ? `  （${s.reason}）` : ""}`);
  console.log(`进程       normal=${s.normalAlive ? "运行中" : "未运行"}  safe=${s.safeAlive ? "运行中" : "未运行"}`);
  console.log(`心跳       ${stale ? bad(hb) : hb}${s.normalAttempts || s.safeAttempts ? `   拉起计数 normal=${s.normalAttempts} safe=${s.safeAttempts}` : ""}`);
  console.log(`当前提交   ${s.head ?? "?"}`);
  console.log(`可用版本   ${s.knownGood ? `${s.knownGood.sha?.slice(0, 8)}（${s.knownGood.markedAt ?? "?"}）` : warn("未标记 —— 回退将退化为「上一个 commit」")}`);
}

function preflight() {
  console.log("── 切回正常模式前的冒烟检查 ──");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "preflight.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return r.status === 0;
}

function switchTo(target) {
  const cur = readMode(STATE_DIR);
  if (!MODES.includes(target)) {
    console.error(`未知模式：${target}（可用：${MODES.join(" / ")}）`);
    process.exit(2);
  }
  if (cur.mode === target && (target === "safe" ? isAlive("safe") : isAlive("normal"))) {
    console.log(`已经是 ${target} 模式且进程在跑，无需切换`);
    return 0;
  }

  // 切回正常模式必须先过闸门
  if (target === "normal" && !flags.has("--force")) {
    if (!preflight()) {
      console.error(bad("\n❌ 冒烟检查未通过，拒绝切回正常模式（保持现状）"));
      return 1;
    }
  }

  if (DRY) {
    console.log(`[dry-run] 将切到 ${target} 模式`);
    return 0;
  }

  // 停旧、起新
  const other = target === "normal" ? "safe" : "normal";
  try {
    killMode(other);
  } catch {
    /* ignore */
  }
  try {
    killMode(target);
  } catch {
    /* ignore */
  }

  const since = countLogLines(target);
  spawnMode(target);
  const ready = waitReady(target, { timeoutMs: 40000, sinceLine: since });
  writeMode(STATE_DIR, {
    mode: target,
    reason: `由 scripts/mode.mjs 人工/agent 切换（${cur.mode} → ${target}）`,
    resetAttempts: true,
    updatedBy: "mode-cli",
  });
  if (ready) {
    console.log(ok(`✅ 已切到 ${target} 模式并就绪`));
    return 0;
  }
  console.error(bad(`⚠️ 已切到 ${target} 模式，但未观察到就绪日志（请看 logs/）`));
  return 1;
}

function markGood() {
  const noteIdx = argv.indexOf("--note");
  const note = noteIdx >= 0 ? argv[noteIdx + 1] ?? "" : "";
  let sha;
  try {
    sha = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) {
    console.error(`无法读取 HEAD：${e?.message}`);
    return 1;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const rec = { sha, markedAt: new Date().toISOString(), note };
  fs.writeFileSync(KNOWN_GOOD, JSON.stringify(rec, null, 2) + "\n", "utf8");
  console.log(ok(`✅ 已将 ${sha.slice(0, 8)} 标记为「已验证可用」${note ? `（${note}）` : ""}`));
  return 0;
}

function main() {
  switch (cmd) {
    case "status": {
      const s = snapshot();
      if (JSON_OUT) console.log(JSON.stringify(s, null, 2));
      else printStatus(s);
      return 0;
    }
    case "normal":
    case "safe":
      return switchTo(cmd);
    case "rollback": {
      const args = [path.join(ROOT, "scripts", "rollback.mjs")];
      if (DRY) args.push("--dry-run");
      const ri = argv.indexOf("--reason");
      if (ri >= 0) args.push("--reason", argv[ri + 1] ?? "");
      return spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" }).status ?? 1;
    }
    case "mark-good":
      return markGood();
    case "reset-attempts": {
      writeMode(STATE_DIR, { resetAttempts: true, updatedBy: "mode-cli" });
      console.log(ok("✅ 已清零自动拉起计数"));
      return 0;
    }
    case "watchdog": {
      const args = [path.join(ROOT, "scripts", "watchdog.mjs")];
      if (DRY) args.push("--dry-run");
      return spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" }).status ?? 1;
    }
    default:
      console.log(`用法：
  node scripts/mode.mjs                     查看状态
  node scripts/mode.mjs normal              切到正常模式（会先跑冒烟检查）
  node scripts/mode.mjs safe                切到安全模式
  node scripts/mode.mjs rollback            执行回退
  node scripts/mode.mjs mark-good           把当前 commit 标为已验证可用
  node scripts/mode.mjs reset-attempts      清零自动拉起计数
  node scripts/mode.mjs watchdog            手动跑一次看门狗
选项：--dry-run  --force  --json  --reason 说明  --note 说明`);
      return 2;
  }
}

process.exit(main());
