#!/usr/bin/env node
/**
 * PI2X 看门狗（watchdog）—— 住在 bridge 外面，负责探活与降级
 *
 * 【运行方式】由 cron 每分钟调用一次：
 *     * * * * * cd /opt/pi2x && /usr/bin/node scripts/watchdog.mjs >> logs/watchdog.log 2>&1
 *
 * 为什么用 cron 而不是常驻进程：
 *   常驻进程自己也会坏、需要被监控，会引入递归问题。cron 由系统托管，与本项目完全解耦，
 *   哪怕我把整个项目改烂，cron 依然会按时把它叫起来。
 *
 * 【完整降级链（按主人的设计）】
 *   正常模式死了/心跳停
 *     → 看门狗自动拉起正常模式，最多 3 次
 *       → 3 次都失败 → 切到安全模式（agent 带最小工具集）
 *         → agent 自救：修好了就切回正常；修不动就调用 declare_unfixable
 *           → 回退模式：纯脚本回滚到上一个已验证可用版本再拉起
 *
 * 【行为异常只告警不降级】
 *   进程活着但「报错多/回复慢」这类判断，看门狗一律只告警。
 *   看门狗一旦误判，就会把一个健康的完整版杀掉、换成残废的安全模式 —— 那它自己
 *   就成了新的故障源。宁可多报几次假警。
 *
 * 【自身安全】
 *   · 全程只读多、写少；唯一会碰的是 state/mode.json 与日志
 *   · 永不做「自动改代码」这种危险动作
 *   · --dry-run 只打印将要做什么，不执行
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT, LOGS_DIR, STATE_DIR, config } from "../lib/config.mjs";
import { readMode, writeMode, DEFAULTS } from "../lib/mode.mjs";
import { decide } from "../lib/mode.mjs";
import { isAlive, inspect, spawnMode, killMode, waitReady, countLogLines } from "../lib/lifecycle.mjs";
import { createLogger } from "../lib/log.mjs";

const log = createLogger("watchdog");
const DRY = process.argv.includes("--dry-run");

/** 告警：直接走 send-notify（自己连 NapCat，**不依赖 bridge** —— bridge 正是可能死掉的那个） */
function alert(adminIds, text) {
  if (DRY) {
    log.info(`[dry-run] 本应告警: ${text}`);
    return;
  }
  for (const uid of adminIds) {
    try {
      spawnSync(process.execPath, [path.join(ROOT, "scripts", "send-notify.mjs"), uid, text], {
        cwd: ROOT,
        timeout: 15000,
        stdio: "ignore",
      });
    } catch (e) {
      log.warn(`告警发送失败(${uid}): ${e?.message}`);
    }
  }
}

async function admins() {
  try {
    const { SafeSentry } = await import("../lib/safe/sentry.mjs");
    return await SafeSentry.resolveAdmins();
  } catch (e) {
    log.warn(`获取管理员列表失败: ${e?.message}`);
    return [];
  }
}

/** 拉起正常模式，并验证是否真的就绪 */
function tryStartNormal() {
  const since = countLogLines("normal");
  if (DRY) {
    log.info("[dry-run] 本应拉起正常模式");
    return false;
  }
  try {
    spawnMode("normal");
  } catch (e) {
    log.error(`拉起正常模式失败: ${e?.message}`);
    return false;
  }
  const ok = waitReady("normal", { timeoutMs: 30000, sinceLine: since });
  log.info(ok ? "正常模式已就绪" : "正常模式拉起后未就绪");
  return ok;
}

/** 拉起安全模式，并验证是否真的就绪 */
function tryStartSafe() {
  const since = countLogLines("safe");
  if (DRY) {
    log.info("[dry-run] 本应拉起安全模式");
    return false;
  }
  try {
    spawnMode("safe");
  } catch (e) {
    log.error(`拉起安全模式失败: ${e?.message}`);
    return false;
  }
  const ok = waitReady("safe", { timeoutMs: 30000, sinceLine: since });
  log.info(ok ? "安全模式已就绪" : "安全模式拉起后未就绪");
  return ok;
}

async function main() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  // 用 lifecycle.inspect 统一取状态：它会在读心跳时做「归属校验」，
  // 把「上一个进程的残留心跳」视为没有心跳，避免把刚重启的健康进程误判成卡死。
  const snap = inspect(STATE_DIR);
  const st = readMode(STATE_DIR);
  const normalAlive = snap.normalAlive;
  const safeAlive = snap.safeAlive;
  const hbAge = snap.heartbeatAgeMs;

  const verdict = decide({
    mode: st.mode,
    normalAlive,
    safeAlive,
    heartbeatAgeMs: hbAge,
    normalAttempts: st.normalAttempts,
    safeAttempts: st.safeAttempts,
    heartbeatStaleMs: Number(config.lifecycle?.heartbeatStaleMs ?? DEFAULTS.heartbeatStaleMs),
    maxNormalAttempts: Number(config.lifecycle?.maxNormalAttempts ?? DEFAULTS.maxNormalAttempts),
    maxSafeAttempts: Number(config.lifecycle?.maxSafeAttempts ?? DEFAULTS.maxSafeAttempts),
  });

  log.info(
    `mode=${st.mode} normal=${normalAlive ? "on" : "off"} safe=${safeAlive ? "on" : "off"} ` +
      `心跳=${Number.isFinite(hbAge) ? `${Math.round(hbAge / 1000)}s前` : "无"} → ${verdict.action}（${verdict.reason}）`
  );

  switch (verdict.action) {
    case "none":
      return;

    case "alert": {
      const ids = await admins();
      alert(ids, `⚠️ PI2X 正常模式进程存活但行为异常，请留意。\n${verdict.reason}`);
      return;
    }

    case "restart-normal": {
      const n = st.normalAttempts + 1;
      log.warn(`正常模式异常，第 ${n} 次自动拉起：${verdict.reason}`);
      if (DRY) {
        log.info("[dry-run] 本应拉起正常模式（不改动状态文件）");
        return;
      }
      writeMode(STATE_DIR, { normalAttempts: n, reason: verdict.reason, updatedBy: "watchdog" });
      const ok = tryStartNormal();
      if (ok) {
        // 起来了就清空计数，等下一轮确认心跳
        writeMode(STATE_DIR, { resetAttempts: "normal", reason: "自动拉起成功", updatedBy: "watchdog" });
        const ids = await admins();
        alert(ids, `🔧 PI2X 正常模式曾被看门狗自动拉起（第 ${n} 次尝试成功），现已恢复。`);
      }
      return;
    }

    case "degrade-safe": {
      log.error(`正常模式 ${st.normalAttempts} 次拉起均失败 → 降级到安全模式`);
      if (DRY) {
        log.info("[dry-run] 本应降级到安全模式（不改动状态文件）");
        return;
      }
      const ids = await admins();
      alert(ids, `🚨 PI2X 正常模式连续 ${st.normalAttempts} 次拉不起来，正在切到**安全模式**。\n${verdict.reason}`);
      // 清掉正常模式的僵尸进程，避免与新入口抢资源
      try {
        killMode("normal");
      } catch {
        /* ignore */
      }
      writeMode(STATE_DIR, { mode: "safe", reason: verdict.reason, resetAttempts: "safe", updatedBy: "watchdog" });
      const ok = tryStartSafe();
      if (ok) {
        alert(ids, "✅ 安全模式已上线（只有 read/write/edit/bash 四个工具）。可以指挥我修正常模式；修不好我会主动请求回退。");
      } else {
        log.error("安全模式也拉不起来 —— 交给下一轮 watchdog 重试或下沉回退");
      }
      return;
    }

    case "start-safe": {
      const n = st.safeAttempts + 1;
      log.warn(`安全模式不在，第 ${n} 次拉起`);
      if (DRY) {
        log.info("[dry-run] 本应拉起安全模式（不改动状态文件）");
        return;
      }
      writeMode(STATE_DIR, { safeAttempts: n, reason: verdict.reason, updatedBy: "watchdog" });
      tryStartSafe();
      return;
    }

    case "degrade-rollback": {
      log.error(`安全模式 ${st.safeAttempts} 次拉不起来 → 回退模式`);
      const ids = await admins();
      alert(ids, `🆘 PI2X 连安全模式都起不来，正在执行**回退**（回滚到上一个已验证可用版本）。`);
      if (DRY) {
        log.info("[dry-run] 本应执行回退（不改动状态文件）");
        return;
      }
      writeMode(STATE_DIR, { mode: "rollback", reason: verdict.reason, updatedBy: "watchdog" });
      spawnSync(process.execPath, [path.join(ROOT, "scripts", "rollback.mjs"), "--reason", verdict.reason], {
        cwd: ROOT,
        stdio: "inherit",
      });
      return;
    }

    default:
      log.warn(`未知动作: ${verdict.action}`);
  }
}

main().catch((e) => {
  log.error(`看门狗异常: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
