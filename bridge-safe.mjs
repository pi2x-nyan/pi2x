#!/usr/bin/env node
/**
 * PI2X 安全模式入口 —— 独立于 bridge.mjs 的自救通道
 *
 * 【为什么是独立文件而不是 bridge.mjs 的一个分支】
 * bridge.mjs 本身就可能被我改坏（今天就有一次：日志改造时引用了未声明的 logger，
 * 一启动就 ReferenceError）。如果安全模式复用它的代码路径，就会「一起坏」。
 * 所以这里只做三件事，且依赖闭包尽可能小：
 *     连 NapCat  →  起一个极简 agent  →  相互转达消息
 *
 * 【依赖闭包】（由 test/safe-closure.test.mjs 锁死）
 *   node:* · lib/qqbridge.mjs · lib/log.mjs · lib/config.mjs · lib/mode.mjs
 *   · lib/model-config.mjs · lib/safe/sentry.mjs · lib/safe/giveup.mjs · pi SDK
 * 明确**不**碰：memory / tools / piagent / prompts / browser / subagent / winShell
 *
 * 用法：node bridge-safe.mjs
 */
import fs from "node:fs";
import path from "node:path";

import { ROOT, LOGS_DIR, config } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import { readMode, writeMode, touchHeartbeat, DEFAULTS } from "./lib/mode.mjs";
import { SafeSentry } from "./lib/safe/sentry.mjs";

const logSafe = createLogger("safe");
const STATE_DIR = path.join(ROOT, "state");

async function main() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const st = readMode(STATE_DIR);
  logSafe.info(`启动中 · 当前模式=${st.mode}${st.reason ? ` · 缘由：${st.reason}` : ""}`);

  // 明确把自己标记成 safe 模式（看门狗据此判断「安全模式已接管」）
  if (st.mode !== "safe") {
    writeMode(STATE_DIR, { mode: "safe", reason: st.reason ?? "由 bridge-safe.mjs 启动", updatedBy: "safe-entry" });
    logSafe.info("已将运行模式标记为 safe");
  }

  const admins = await SafeSentry.resolveAdmins();
  if (!admins.length) {
    logSafe.error("未找到任何 admin 用户 —— 安全模式下没有人能指挥我。请在 whitelist.json 中为管理员配置 admin 预设。");
  }

  const sentry = new SafeSentry({ stateDir: STATE_DIR, adminIds: admins });
  await sentry.start();

  // 心跳由 sentry 内部定时器负责；这里额外保证启动瞬间就有一次
  touchHeartbeat(STATE_DIR);

  const shutdown = async (sig) => {
    logSafe.info(`收到 ${sig}，正在退出安全模式…`);
    await sentry.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (e) => logSafe.error(`未捕获异常: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e) => logSafe.error(`未处理的 rejection: ${e?.message ?? e}`));
}

main().catch((e) => {
  logSafe.error(`安全模式启动失败: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
