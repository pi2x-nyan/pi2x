#!/usr/bin/env node
/**
 * 冒烟检查（preflight）—— 重启前的最后一道闸门
 *
 * 【为什么需要】
 * PI2X 的唯一入口是 bridge.mjs。如果我把代码改坏再重启，bridge 起不来，
 * 就没有任何通道能让我通过 QQ 自救 —— 只能靠人在机器上敲命令。
 * 所以「重启前先确认这套代码至少能起来」是最关键的一道保险。
 *
 * 检查项（按代价从低到高，任何一项失败即整体失败）：
 *   1. 关键文件语法        node --check
 *   2. 关键模块可导入      import() 真跑一遍（能抓到「引用了未声明的变量」这类
 *                          语法检查发现不了的问题 —— 正是 qqbridge 那次崩溃的类型）
 *   3. 回归测试            npm test（完整跑一遍，约 3 秒）
 *   4. 配置可解析且关键字段齐备
 *
 * 用法：
 *   node scripts/preflight.mjs          # 全部检查
 *   node scripts/preflight.mjs --fast   # 跳过测试（仅语法+导入+配置）
 *
 * 退出码：0 = 通过，1 = 不通过
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAST = process.argv.includes("--fast");

const results = [];
let failed = 0;

function step(name, fn) {
  const t0 = Date.now();
  let ok = true;
  let detail = "";
  try {
    const r = fn();
    if (r && typeof r === "object") {
      ok = r.ok !== false;
      detail = r.detail ?? "";
    }
  } catch (e) {
    ok = false;
    detail = e?.message ?? String(e);
  }
  const ms = Date.now() - t0;
  results.push({ name, ok, detail, ms });
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${name} (${ms}ms)${detail ? `\n     ${detail}` : ""}`);
  return ok;
}

/** 递归收集运行时链路的 .mjs 文件 */
function runtimeFiles() {
  const out = [path.join(ROOT, "bridge.mjs"), path.join(ROOT, "control.mjs")];
  const walk = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const full = path.join(dir, n);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (n.endsWith(".mjs")) out.push(full);
    }
  };
  walk(path.join(ROOT, "lib"));
  return out;
}

/** 关键模块清单：这些是启动必经路径，必须在 import 阶段就成功 */
function criticalModules() {
  const list = ["bridge-entry-check"].map(() => null).filter(Boolean);
  const files = [
    "lib/config.mjs",
    "lib/log.mjs",
    "lib/text.mjs",
    "lib/winhost.mjs",
    "lib/prompts.mjs",
    "lib/whitelist.mjs",
    "lib/risk-review.mjs",
    "lib/reminders.mjs",
    "lib/sessions-maint.mjs",
    "lib/tools/index.mjs",
    "lib/agent/turn-assembler.mjs",
    "lib/agent/stream-flusher.mjs",
    "lib/agent/compact-policy.mjs",
    "lib/agent/sent-log.mjs",
    "lib/qqbridge.mjs",
  ];
  // qqbridge / napcat 会连外部服务，只做语法检查不由这里 import（见下）
  return files.filter((f) => fs.existsSync(path.join(ROOT, f)));
}

console.log(`── PI2X 冒烟检查 ${FAST ? "（fast 模式，跳过测试）" : ""}──`);

// 1) 语法
step("语法检查（node --check 全部运行时链路文件）", () => {
  const bad = [];
  for (const f of runtimeFiles()) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) bad.push(`${path.relative(ROOT, f)}: ${(r.stderr || "").split("\n")[0]}`);
  }
  return { ok: bad.length === 0, detail: bad.join("\n     ") };
});

// 2) 关键模块导入
console.log("   （下一步会真正 import 关键模块，能抓出「未声明变量」这类运行时才暴露的问题）");
{
  const t0 = Date.now();
  let ok = true;
  let detail = "";
  try {
    const mods = criticalModules();
    // 注意：`node -e` 的 ESM 相对说明符必须以 ./ 开头，否则会被当成包名（曾报
    // Cannot find package 'lib'）。这里统一转成 file:// 绝对 URL，最稳。
    const payload = mods
      .map((m) => `import(${JSON.stringify(new URL(`file://${path.join(ROOT, m)}`).href)})`)
      .join(",");
    const script = `
      const ms = await Promise.all([${payload}]);
      const names = ${JSON.stringify(mods.map((m) => path.relative(ROOT, m)))};
      for (let i = 0; i < ms.length; i++) {
        if (!ms[i] || typeof ms[i] !== "object") throw new Error(names[i] + " 未导出任何内容");
      }
      console.log(JSON.stringify({ n: ms.length }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    if (r.status !== 0) {
      ok = false;
      detail = (r.stderr || "").split("\n").slice(0, 6).join("\n     ");
    }
  } catch (e) {
    ok = false;
    detail = e?.message ?? String(e);
  }
  const ms = Date.now() - t0;
  results.push({ name: "关键模块 import 冒烟", ok, detail, ms });
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} 关键模块 import 冒烟 (${ms}ms)${detail ? `\n     ${detail}` : ""}`);
}

// 3) 配置
step("配置可解析且关键字段齐备", () => {
  const p = path.join(ROOT, "config.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const need = [
    ["napcat", "qqAccount"],
    ["pi", "model"],
    ["pi", "submitTimeoutMs"],
    ["permissions", "groupReplyMode"],
  ];
  const miss = need.filter(([a, b]) => raw[a]?.[b] === undefined).map(([a, b]) => `${a}.${b}`);
  if (miss.length) return { ok: false, detail: `缺少：${miss.join(", ")}` };
  if (!Number.isFinite(Number(raw.pi?.compactPercent))) return { ok: false, detail: "pi.compactPercent 必须是数字" };
  if (Number(raw.pi.compactPercent) <= 1) return { ok: false, detail: "pi.compactPercent 量纲不对（应为 0~100）" };
  return { ok: true };
});

// 4) 回归测试
if (!FAST) {
  step("回归测试（node --test test/*.test.mjs）", () => {
    const testDir = path.join(ROOT, "test");
    let files = [];
    try {
      files = fs
        .readdirSync(testDir)
        .filter((f) => f.endsWith(".test.mjs"))
        .sort()
        .map((f) => path.join(testDir, f));
    } catch (e) {
      return { ok: false, detail: `读取 test/ 失败：${e?.message}` };
    }
    if (!files.length) return { ok: false, detail: "test/ 下没有任何 .test.mjs" };
    const r = spawnSync(process.execPath, ["--test", ...files], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: 120000,
    });
    if (r.status === 0) return { ok: true, detail: `${files.length} 个测试文件全过` };
    const lines = (r.stdout || "").split("\n").filter((l) => /^ℹ (fail|tests|pass)|^✖ /.test(l)).slice(0, 10);
    return { ok: false, detail: lines.join("\n     ") };
  });
}

console.log("──");
if (failed) {
  console.log(`❌ 冒烟检查未通过（${failed} 项失败）—— 不应重启`);
  process.exit(1);
}
console.log(`✅ 冒烟检查全部通过（${results.length} 项）`);
process.exit(0);
