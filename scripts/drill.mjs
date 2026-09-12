#!/usr/bin/env node
/**
 * 降级链端到端演练（drill）—— 在**隔离沙盒**里真跑一遍三层降级
 *
 * 【为什么必须演练】
 * 一套只在纸面上正确的救援机制，跟没有一样。真正要验证的是：
 * 进程真被杀了以后，看门狗会不会认出来、会不会按预期层级降级、会不会误伤健康进程。
 *
 * 【为什么不直接在本机跑】
 * 演练会真的杀进程、改模式状态。直接跑会把正在服务的 PI2X 打掉 —— 那就成了
 * 「为了测试救援把自己救援没了」。所以全程在临时目录里操作，只借用真实的
 * lib/ 代码与一个假的进程。

 * 用法：
 *   node scripts/drill.mjs            # 跑全部演练
 *   node scripts/drill.mjs --verbose
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

import { readMode, writeMode, touchHeartbeat, decide, heartbeatAge } from "../lib/mode.mjs";
import { createLogger } from "../lib/log.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = createLogger("drill");
const VERBOSE = process.argv.includes("--verbose");

let pass = 0;
let fail = 0;

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

/** 造一个「假 PI2X」：一个只睡觉的 node 进程，cmdline 里带指定标记 */
function spawnFake(tag, dir) {
  const script = path.join(dir, `fake-${tag}.mjs`);
  fs.writeFileSync(script, `setInterval(() => {}, 1000); // ${tag}\n`, "utf8");
  const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi2x-drill-"));
  console.log(`── PI2X 降级链演练（沙盒 ${sandbox}）──\n`);

  // ── 场景 1：正常模式健康 → 看门狗不该动它 ──────────────────────────────
  console.log("场景 1：正常模式健康");
  {
    writeMode(sandbox, { mode: "normal", resetAttempts: true });
    touchHeartbeat(sandbox);
    const d = decide({
      mode: readMode(sandbox).mode,
      normalAlive: true,
      heartbeatAgeMs: heartbeatAge(sandbox),
    });
    check("判定为健康，不做任何动作", d.action === "none", `实际 ${d.action}：${d.reason}`);
  }

  // ── 场景 2：进程死了 → 连续三次自救 ────────────────────────────────────
  console.log("\n场景 2：正常模式进程死了，看门狗连续自救三次");
  {
    writeMode(sandbox, { mode: "normal", resetAttempts: true });
    const actions = [];
    for (let i = 0; i < 4; i++) {
      const st = readMode(sandbox);
      const d = decide({ mode: st.mode, normalAlive: false, normalAttempts: st.normalAttempts });
      actions.push(d.action);
      if (d.action === "restart-normal") {
        // 模拟「拉起但失败」（进程起不来，计数 +1）
        writeMode(sandbox, { normalAttempts: st.normalAttempts + 1, reason: d.reason });
      } else if (d.action === "degrade-safe") {
        writeMode(sandbox, { mode: "safe", reason: d.reason, resetAttempts: "safe" });
      }
    }
    check(
      "前三次都是「自动拉起正常模式」",
      actions.slice(0, 3).every((a) => a === "restart-normal"),
      `实际 ${actions.join(" → ")}`
    );
    check("第四次才降级到安全模式", actions[3] === "degrade-safe", `实际 ${actions.join(" → ")}`);
    check("模式已切到 safe", readMode(sandbox).mode === "safe");
  }

  // ── 场景 3：安全模式能起来 → 保持 ──────────────────────────────────────
  console.log("\n场景 3：已降级到安全模式，且安全模式正常运行");
  {
    const d = decide({ mode: "safe", safeAlive: true, heartbeatAgeMs: 1000 });
    check("不动它（agent 正在自救）", d.action === "none", `实际 ${d.action}`);
  }

  // ── 场景 4：安全模式也起不来 → 回退 ────────────────────────────────────
  console.log("\n场景 4：安全模式连续三次起不来");
  {
    writeMode(sandbox, { mode: "safe", safeAttempts: 0 });
    const actions = [];
    for (let i = 0; i < 4; i++) {
      const st = readMode(sandbox);
      const d = decide({ mode: st.mode, safeAlive: false, safeAttempts: st.safeAttempts });
      actions.push(d.action);
      if (d.action === "start-safe") writeMode(sandbox, { safeAttempts: st.safeAttempts + 1 });
      else if (d.action === "degrade-rollback") writeMode(sandbox, { mode: "rollback", reason: d.reason });
    }
    check("前三次尝试拉起安全模式", actions.slice(0, 3).every((a) => a === "start-safe"), `实际 ${actions.join(" → ")}`);
    check("第四次下沉到回退模式", actions[3] === "degrade-rollback", `实际 ${actions.join(" → ")}`);
  }

  // ── 场景 5：回退模式不再自动折腾 ───────────────────────────────────────
  console.log("\n场景 5：已处于回退模式");
  {
    const d = decide({ mode: "rollback", normalAlive: false, safeAlive: false });
    check("不再自动做动作（等人工）", d.action === "none", `实际 ${d.action}`);
  }

  // ── 场景 6：真进程探活（用真实 lifecycle 代码，但针对假进程）───────────
  console.log("\n场景 6：真实进程枚举（lifecycle 的 isAlive）");
  {
    const { pidsOf } = await import("../lib/lifecycle.mjs");
    // 造一个 cmdline 形似 bridge-safe.mjs 的进程
    const fakeDir = path.join(sandbox, "fake");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeSafe = path.join(fakeDir, "bridge-safe.mjs");
    fs.writeFileSync(fakeSafe, "setInterval(()=>{},1000);\n", "utf8");
    const child = spawn(process.execPath, [fakeSafe], { detached: true, stdio: "ignore" });
    child.unref();
    await new Promise((r) => setTimeout(r, 300));
    const found = pidsOf("safe");
    check("能枚举出 bridge-safe.mjs 进程", found.includes(child.pid), `找到 ${JSON.stringify(found)}，期望含 ${child.pid}`);
    const foundNormal = pidsOf("normal");
    check("不会把 safe 误判成 normal", !foundNormal.includes(child.pid), `normal 列表 ${JSON.stringify(foundNormal)}`);
    // 真进程存在时，判定应为「运行中」
    const d = decide({ mode: "safe", safeAlive: found.includes(child.pid) });
    check("安全模式有进程 → 判定运行中", d.action === "none");
    killPid(child.pid);
    await new Promise((r) => setTimeout(r, 200));
    const after = pidsOf("safe");
    check("杀掉后枚举不到该进程", !after.includes(child.pid));
  }

  // ── 场景 7：dry-run 绝不改状态 ─────────────────────────────────────────
  console.log("\n场景 7：看门狗 dry-run 不得改动状态文件");
  {
    // 关键：用 PI2X_STATE_DIR 把真实的 watchdog 代码指到沙盒，
    // 否则它写的是正在服务的真实 state 目录 —— 那样测了等于没测。
    writeMode(sandbox, { mode: "normal", resetAttempts: true });
    const sandboxMode = path.join(sandbox, "mode.json");
    const before = fs.readFileSync(sandboxMode, "utf8");
    const r = execFileSync(process.execPath, [path.join(ROOT, "scripts", "watchdog.mjs"), "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PI2X_STATE_DIR: sandbox },
    });
    const after = fs.readFileSync(sandboxMode, "utf8");
    check("dry-run 后沙盒状态文件逐字节不变", before === after, `before=${before}\nafter=${after}`);
    check("dry-run 有输出", r.length > 0);

    // 反证：非 dry-run 且确实需要动作时，会写状态 —— 证明上面的「不变」不是假通过。
    // 用 mode=safe + safeAttempts=0：这条路径不依赖真实进程存活，且 PI2X_NO_SPAWN=1
    // 保证它不会真把 bridge-safe 拉起来抢 NapCat 连接。
    writeMode(sandbox, { mode: "safe", safeAttempts: 0 });
    const before2 = fs.readFileSync(sandboxMode, "utf8");
    try {
      execFileSync(process.execPath, [path.join(ROOT, "scripts", "watchdog.mjs")], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, PI2X_STATE_DIR: sandbox, PI2X_NO_SPAWN: "1" },
      });
    } catch {
      /* 只看它有没有写状态 */
    }
    const after2 = JSON.parse(fs.readFileSync(sandboxMode, "utf8"));
    check(
      "对照：非 dry-run 且需要动作时确实会写状态（证明隔离生效，不是假通过）",
      after2.safeAttempts === 1,
      `safeAttempts=${after2.safeAttempts}（期望 1）`
    );
    // 真拉起被拦住了吗
    check("PI2X_NO_SPAWN 生效：演练没有真的启动安全模式进程", (() => {
      const out = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });
      return !/bridge-safe[.]mjs/.test(out);
    })());
    // 还原成健康态，避免影响后续场景
    writeMode(sandbox, { mode: "normal", resetAttempts: true, reason: null });
  }

  // ── 场景 8：模式文件损坏时不影响判定 ───────────────────────────────────
  console.log("\n场景 8：模式状态文件损坏");
  {
    fs.writeFileSync(path.join(sandbox, "mode.json"), "{ 损坏的 JSON");
    const st = readMode(sandbox);
    check("回落为 normal 且标记 corrupt", st.mode === "normal" && st.corrupt === true);
    const d = decide({ mode: st.mode, normalAlive: true, heartbeatAgeMs: 1000 });
    check("仍能正常判定", d.action === "none");
  }

  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n── 演练结束：${pass} 通过 / ${fail} 失败 ──`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  log.error(`演练异常: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
