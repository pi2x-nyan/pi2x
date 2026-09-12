import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, DEFAULTS, ROOT as CFG_ROOT, AGENT_DIR, WORKSPACE, SESSIONS_DIR, cfg } from "../lib/config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("ROOT / 路径导出正确且为绝对路径", () => {
  assert.equal(CFG_ROOT, ROOT);
  for (const p of [AGENT_DIR, WORKSPACE, SESSIONS_DIR]) {
    assert.ok(path.isAbsolute(p), `${p} 应为绝对路径`);
  }
  assert.equal(AGENT_DIR, path.join(ROOT, "agent-dir"));
  assert.equal(WORKSPACE, path.join(ROOT, "workspace"));
  assert.equal(SESSIONS_DIR, path.join(ROOT, "sessions"));
});

test("config 已用默认值补齐（关键字段不可能是 undefined）", () => {
  const keys = [
    "pi.submitTimeoutMs",
    "pi.streamFlushMin",
    "pi.streamFlushMax",
    "pi.streamFlushIdleMs",
    "pi.compactPercent",
    "pi.compactCooldownMs",
    "pi.compactWaitMs",
    "pi.slowToolMs",
    "pi.leakMaxRetries",
    "pi.subagentTimeoutSec",
    "pi.model",
    "winShell.probeTimeoutMs",
    "winShell.probeTtlMs",
    "winShell.port",
    "memory.maxFacts",
    "memory.injectChars",
    "memory.harvestIntervalMin",
    "sandboxBash.defaultTimeoutSec",
    "sandboxBash.maxOutputChars",
    "permissions.driftStaleMin",
  ];
  for (const k of keys) {
    assert.notEqual(cfg(k), undefined, `config.${k} 未补齐默认值`);
  }
});

test("cfg() 点号取值：命中 / 未命中回落 / 中间层缺失", () => {
  assert.equal(cfg("winShell.port"), 8123);
  assert.equal(cfg("不存在.也不存在", "fallback"), "fallback");
  assert.equal(cfg("pi.也.不存在", "x"), "x");
});

test("compactPercent 必须与 pi 的 0~100 量纲一致（回归：曾误写 0.70）", () => {
  const v = Number(config.pi.compactPercent);
  assert.ok(v > 1, `compactPercent=${v} 看起来是 0~1 量纲，会误触发压缩`);
  assert.ok(v <= 100, `compactPercent=${v} 超过 100 永远不会触发`);
});

test("DEFAULTS 是冻结的（防止运行期被意外改写）", () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.throws(() => {
    DEFAULTS.pi = {};
  }, "冻结对象赋值应抛错（严格模式）");
});

test("mergeDefaults 语义：默认值只补缺失键，不覆盖用户显式配置", async () => {
  // 通过 saveConfig 的等价逻辑间接验证：直接用导出的配置对象检查
  // config.json 里显式写过的值不能被 DEFAULTS 覆盖
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  for (const [k, v] of Object.entries(raw.pi ?? {})) {
    if (typeof v === "object" && v !== null) continue;
    assert.equal(config.pi[k], v, `config.json 里的 pi.${k} 被默认值覆盖了`);
  }
  for (const [k, v] of Object.entries(raw.winShell ?? {})) {
    if (typeof v === "object" && v !== null) continue;
    assert.equal(config.winShell[k], v, `config.json 里的 winShell.${k} 被默认值覆盖了`);
  }
});

// ── 「配置单一数据源」的机械约束 ────────────────────────────────────────────
/** 受约束的模块：这些是重构后新建/重写的，要求默认值只能来自 config.mjs */
const STRICT_FILES = [
  "lib/winhost.mjs",
  "lib/text.mjs",
  "lib/log.mjs",
  "lib/sessions-maint.mjs",
  "lib/agent/compact-policy.mjs",
  "lib/agent/stream-flusher.mjs",
  "lib/agent/sent-log.mjs",
  "lib/agent/turn-assembler.mjs",
  "lib/tools/index.mjs",
  "lib/tools/memory.mjs",
  "lib/tools/reminders.mjs",
  "lib/tools/session.mjs",
  "lib/tools/windows.mjs",
  "lib/tools/subagent.mjs",
  "lib/tools/credentials.mjs",
  "lib/tools/messaging.mjs",
];

/** 匹配 `?? 数字` 这种「就地写死的默认值」 */
const DOUBLE_DEFAULT = /\?\?\s*\d+(\.\d+)?\b/;

test("重构后的模块不得就地写死数值默认值（必须走 config.mjs / DEFAULTS）", () => {
  const offenders = [];
  for (const rel of STRICT_FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, "utf8").split("\n");
    lines.forEach((line, i) => {
      // 跳过注释行
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (DOUBLE_DEFAULT.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `发现就地写死的数值默认值：\n${offenders.join("\n")}`);
});

test("lib/config.mjs 的 DEFAULTS 覆盖代码里读取的所有 config 路径", () => {
  // 扫描 lib/ scripts/ 里出现的 config.xxx.yyy 取值路径，确认 DEFAULTS 有对应叶子
  const roots = ["lib", "scripts", "."]; // 不含 test/：里面是构造出来的样例路径，会污染扫描
  const seen = new Set();
  const fileRe = /\.mjs$/;
  const pathRe = /\bconfig\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g;

  const walk = (dir, depth = 0) => {
    if (depth > 2) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === "node_modules" || n === "tmp" || n === "test" || n.startsWith(".")) continue;
      // 跳过浏览器 profile / 下载物等非源码目录（里面有 Chrome 留下的悬空符号链接）
      if (["browser-profile", "browser-profile-op", "workspace", "agent-dir", "sessions", "state", "sandbox", "logs", "napcat", "win-agent"].includes(n)) continue;
      const full = path.join(dir, n);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue; // 悬空链接等，直接跳过
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (fileRe.test(n)) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(pathRe)) {
          const p = m[1].split(".").filter((x) => x !== "length");
          if (p.length >= 2) seen.add(p.slice(0, 2).join("."));
        }
      }
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));

  const missing = [];
  for (const p of seen) {
    const [a, b] = p.split(".");
    const def = DEFAULTS[a];
    if (!def || !(b in def)) missing.push(p);
  }
  // 这些是刻意的运行期注入字段（非配置项），不算缺失
  const allowed = new Set(["pi.agentDir", "pi.workspace", "memory.scoring", "memory.reflect"]);
  const real = missing.filter((m) => !allowed.has(m));
  assert.deepEqual(real, [], `这些 config 路径在 DEFAULTS 里没有定义：\n  ${real.join("\n  ")}`);
});
