import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 运行时链路（必须走结构化日志的模块） */
function runtimeFiles() {
  const out = [path.join(ROOT, "bridge.mjs")];
  const libDir = path.join(ROOT, "lib");
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      const full = path.join(dir, n);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (n.endsWith(".mjs")) out.push(full);
    }
  };
  walk(libDir);
  return out;
}

test("运行时链路里不得存在裸 console.log/error/warn（统一走 lib/log.mjs）", () => {
  const offenders = [];
  for (const f of runtimeFiles()) {
    const rel = path.relative(ROOT, f);
    if (rel === "lib/log.mjs") continue; // 日志器自己就是往 stdout 写的
    if (rel === "lib/config.mjs") continue; // 见下一条测试：它有意直接写 stderr
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/\bconsole\.(log|warn|error|info)\s*\(/.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `发现裸 console 调用：\n${offenders.join("\n")}`);
});

test("lib/config.mjs 是唯一例外，且必须写明原因（不能 import log.mjs 会循环依赖）", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "config.mjs"), "utf8");
  assert.match(src, /循环依赖/, "config.mjs 的 stderr 直写必须注释说明原因，否则后人会误改");
  assert.doesNotMatch(src, /from "\.\/log\.mjs"/, "config.mjs 不得 import log.mjs");
});

/** logger 的「使用形态」：logXxx.info(...) / .warn / .error / .debug / .time */
const LOGGER_USE = /\b(log[A-Z][A-Za-z0-9_]*)\.(?:info|warn|error|debug|time)\s*\(/g;

test("每个被当作 logger 使用的 logXxx 都必须有声明（防止漏声明导致运行时崩溃）", () => {
  const offenders = [];
  for (const f of runtimeFiles()) {
    const rel = path.relative(ROOT, f);
    if (rel === "lib/log.mjs") continue;
    const s = fs.readFileSync(f, "utf8");
    const used = new Set([...s.matchAll(LOGGER_USE)].map((m) => m[1]));
    const declared = new Set([...s.matchAll(/(?:const|let|var)\s+(log[A-Z][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]));
    const missing = [...used].filter((u) => !declared.has(u));
    if (missing.length) offenders.push(`${rel}: ${missing.join(", ")}`);
  }
  assert.deepEqual(offenders, [], `未声明的 logger：\n${offenders.join("\n")}`);
});

test("logger 命名统一：log + 首字母大写的驼峰", () => {
  const bad = [];
  for (const f of runtimeFiles()) {
    const rel = path.relative(ROOT, f);
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/const\s+(\w+)\s*=\s*createLogger/g)) {
      if (!/^log[A-Z][A-Za-z0-9]*$/.test(m[1])) bad.push(`${rel}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `logger 命名不规范（应为 log + 大驼峰，如 logBoot / logPi）：\n${bad.join("\n")}`);
});

test("根目录不存在陈旧 bridge 副本（防止改错文件）", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "bridge.mjs")), "主入口应存在");
  assert.ok(!fs.existsSync(path.join(ROOT, "lib", "bridge.mjs")), "lib/ 下不应再有 bridge.mjs 副本");
});

test("主入口 bridge.mjs 从 lib/config.mjs 取配置，不自己 JSON.parse 一遍", () => {
  const s = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");
  assert.doesNotMatch(s, /JSON\.parse\(fs\.readFileSync\(path\.join\(ROOT, "config\.json"\)/, "应改用 lib/config.mjs 的 config");
  assert.match(s, /from "\.\/lib\/config\.mjs"/);
});

test("不得把裸 console 当作默认 logger（会让日志丢掉时间戳）", () => {
  const offenders = [];
  for (const f of runtimeFiles()) {
    const rel = path.relative(ROOT, f);
    if (rel === "lib/log.mjs") continue; // 它自己就是输出终端
    if (rel === "lib/config.mjs") continue; // 有意直写 stderr（见上一条测试）
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      // logger = console / logger: console —— 都会绕过 lib/log.mjs
      if (/\blogger\s*[:=]\s*console\b/.test(code)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `默认 logger 不能是 console（直写 stdout，日志没有时间戳；请用 createLogger）：\n${offenders.join("\n")}`,
  );
});

test("日志时间戳必须带日期（YYYY-MM-DD），否则跨天日志无法区分", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "log.mjs"), "utf8");
  assert.match(src, /getFullYear\(\)/, "人类可读通道的时间戳必须包含年份");
  assert.match(src, /getMonth\(\)/, "必须包含月份");
  assert.match(src, /getDate\(\)/, "必须包含日");
  // 反向：不应再存在只输出 HH:MM:SS 的旧实现
  assert.doesNotMatch(
    src,
    /function localHms\(\)/,
    "旧的 localHms（仅时刻）必须已被带日期的 localStamp 取代",
  );
});
