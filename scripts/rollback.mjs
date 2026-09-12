#!/usr/bin/env node
/**
 * 回退模式 —— 降级链的最后一环，**不含 agent**，只有一个固定动作
 *
 * 【为什么不含 agent】
 * 到这一步说明：正常模式起不来、安全模式的 agent 也修不动（或主动声明放弃）。
 * 此时最不该出现的就是「又一段可能写错的逻辑」。所以这里只做一件事，而且做得很笨：
 *
 *     找一个「已验证可用」的版本  →  把工作区切过去  →  拉起正常模式  →  验证
 *
 * 因为逻辑固定、分支极少，它几乎不可能自己坏掉 —— 这正是它存在的意义。
 *
 * 【「已验证可用」怎么定义】
 *   state/known-good.json 里记录一个 commit sha 和验证时间。
 *   由 `scripts/mode.mjs mark-good` 打标（正常模式稳定运行一段时间后调用），
 *   也可由 rollback 自己在成功启动后更新。
 *   若该文件不存在，退化为「上一个 commit」（至少能回到上一层，比没有强）。
 *
 * 【安全措施】
 *   · 回退前把当前工作区打成 bundle 存档（哪怕代码很烂也留着，便于事后分析）
 *   · 使用 git stash 而不是 reset --hard，避免误删未提交工作（git 会保留 stash）
 *   · 只回退代码，**不动** workspace/（记忆库）、sessions/、state/
 *
 * 用法：
 *   node scripts/rollback.mjs [--reason "为什么回退"] [--dry-run] [--sha <commit>]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ROOT, LOGS_DIR, STATE_DIR } from "../lib/config.mjs";
import { createLogger } from "../lib/log.mjs";
import { writeMode } from "../lib/mode.mjs";
import { spawnMode, killMode, waitReady, logLines } from "../lib/lifecycle.mjs";

const log = createLogger("rollback");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const reasonIdx = argv.indexOf("--reason");
const REASON = reasonIdx >= 0 ? argv[reasonIdx + 1] ?? "" : "";
const shaIdx = argv.indexOf("--sha");
const FORCE_SHA = shaIdx >= 0 ? argv[shaIdx + 1] : null;

const KNOWN_GOOD = path.join(STATE_DIR, "known-good.json");

function git(args, opts = {}) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", ...opts }).trim();
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** 读取「已验证可用」的版本；没有则退化为上一个 commit */
function pickTarget() {
  if (FORCE_SHA) return { sha: FORCE_SHA, source: "命令行指定" };
  try {
    const raw = JSON.parse(fs.readFileSync(KNOWN_GOOD, "utf8"));
    if (raw.sha && gitOrNull(["cat-file", "-e", `${raw.sha}^{commit}`]) !== null) {
      return { sha: raw.sha, source: `已验证可用（${raw.markedAt ?? "时间未知"}）`, note: raw.note ?? "" };
    }
    log.warn(`known-good.json 里的 sha 已失效（${raw.sha}），退化为上一个 commit`);
  } catch (e) {
    if (e?.code !== "ENOENT") log.warn(`读取 known-good.json 失败：${e?.message}`);
  }
  const prev = gitOrNull(["rev-parse", "HEAD~1"]);
  return prev ? { sha: prev, source: "上一个 commit（无已验证标记）" } : null;
}

/** 把当前工作区存档（哪怕很烂也留着，便于事后分析为什么坏） */
function archiveCurrentWorkspace() {
  const dir = path.join(LOGS_DIR, "rollback-archive");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bundle = path.join(dir, `before-rollback-${stamp}.bundle`);
  const head = gitOrNull(["rev-parse", "HEAD"]) ?? "";
  try {
    // 把未提交改动也存进 stash（git 会保留，不会丢）
    const dirty = gitOrNull(["status", "--porcelain"]);
    if (dirty) {
      gitOrNull(["stash", "push", "-u", "-m", `rollback-snapshot ${stamp}`]);
      log.info("未提交的改动已存入 git stash（不会丢，可用 git stash list 找回）");
    }
    gitOrNull(["bundle", "create", bundle, "--all"]);
    log.info(`工作区已存档: ${path.relative(ROOT, bundle)}（HEAD=${head.slice(0, 8)}）`);
    return bundle;
  } catch (e) {
    log.warn(`存档失败（不阻塞回退）: ${e?.message}`);
    return null;
  }
}

/** 记录本次回退，便于事后复盘 */
function record({ target, archive, ok }) {
  const file = path.join(STATE_DIR, "rollback-log.jsonl");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        at: new Date().toISOString(),
        reason: REASON,
        from: gitOrNull(["rev-parse", "HEAD"]),
        to: target?.sha ?? null,
        targetSource: target?.source ?? null,
        archive: archive ? path.relative(ROOT, archive) : null,
        ok,
      })}\n`,
      "utf8"
    );
  } catch {
    /* 记录失败不影响回退 */
  }
}

function main() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const target = pickTarget();
  if (!target) {
    log.error("找不到任何可回退的版本（git 仓库无历史？）→ 回退失败，需人工介入");
    record({ target: null, archive: null, ok: false });
    process.exit(1);
  }

  const head = gitOrNull(["rev-parse", "HEAD"]) ?? "?";
  log.warn(`开始回退：${head.slice(0, 8)} → ${target.sha.slice(0, 8)}（${target.source}）`);
  if (REASON) log.warn(`原因：${REASON}`);

  if (DRY) {
    log.info("[dry-run] 将执行：存档当前工作区 → git 切到目标版本 → 拉起正常模式 → 验证");
    return;
  }

  // 1) 存档
  const archive = archiveCurrentWorkspace();

  // 2) 切到目标版本
  const co = spawnSync("git", ["-C", ROOT, "checkout", "--detach", target.sha], { encoding: "utf8" });
  if (co.status !== 0) {
    log.error(`git checkout 失败: ${(co.stderr || "").trim()}`);
    record({ target, archive, ok: false });
    process.exit(1);
  }
  log.info(`已切到 ${target.sha.slice(0, 8)}`);

  // 3) 干净地停掉可能残留的进程
  try {
    killMode("safe");
  } catch {
    /* ignore */
  }
  try {
    killMode("normal");
  } catch {
    /* ignore */
  }

  // 4) 拉起正常模式并验证
  const since = logLines("normal");
  let ok = false;
  try {
    spawnMode("normal");
    ok = waitReady("normal", { timeoutMs: 40000, sinceLine: since });
  } catch (e) {
    log.error(`拉起正常模式失败: ${e?.message}`);
  }

  if (ok) {
    log.info("✅ 回退成功，正常模式已就绪");
    writeMode(STATE_DIR, { mode: "normal", reason: `已回退到 ${target.sha.slice(0, 8)}`, resetAttempts: true, updatedBy: "rollback" });
    // 回退成功后，把当前版本记为已验证（下次若再需要回退，目标就是这个）
    try {
      const nowSha = gitOrNull(["rev-parse", "HEAD"]);
      fs.writeFileSync(KNOWN_GOOD, JSON.stringify({ sha: nowSha, markedAt: new Date().toISOString(), note: "由 rollback 成功启动后自动标记" }, null, 2) + "\n", "utf8");
    } catch {
      /* ignore */
    }
    notify(`✅ PI2X 已回退到 ${target.sha.slice(0, 8)} 并成功启动。原因：${REASON || "未说明"}`);
  } else {
    log.error("❌ 回退后仍无法启动 —— 需要人工介入（此时已无自动手段）");
    writeMode(STATE_DIR, { mode: "rollback", reason: `回退到 ${target.sha.slice(0, 8)} 后仍起不来`, updatedBy: "rollback" });
    notify(`🆘 PI2X 回退到 ${target.sha.slice(0, 8)} 后仍无法启动，需要人工介入。`);
  }

  record({ target, archive, ok });
  process.exit(ok ? 0 : 1);
}

/** 发告警（走 send-notify，不依赖 bridge） */
function notify(text) {
  try {
    // 同步读 whitelist.json 取管理员，避免引入异步链
    const wl = JSON.parse(fs.readFileSync(path.join(ROOT, "whitelist.json"), "utf8"));
    for (const [uid, preset] of Object.entries(wl.users ?? {})) {
      if (preset !== "admin") continue;
      spawnSync(process.execPath, [path.join(ROOT, "scripts", "send-notify.mjs"), uid, text], { cwd: ROOT, timeout: 15000, stdio: "ignore" });
    }
  } catch (e) {
    log.warn(`告警失败: ${e?.message}`);
  }
}

main();
