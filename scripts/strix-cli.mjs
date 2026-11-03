#!/usr/bin/env node
/**
 * strix CLI —— 本地黑盒渗透引擎（PI2X 可选执行器，无 Docker）
 *
 * 把 strix（开源自主 AI 渗透框架）包装成本机可调用的命令行工具。
 * 通过 bash 调用（与 browser-cli.mjs 同一套模式），不注册为 pi 工具，
 * 由技能文档渐进披露。
 *
 * 【为什么用 CLI 而不是子代理】
 * strix 自身已是一个多 agent 系统（root → 侦察/猎手/验证/报告），
 * 再套一层 PI2X 子代理会形成两层嵌套，且它的「反轮询」设计与我们
 * 的唤醒机制会互相干扰。当普通 CLI 用最干净。
 *
 * 用法：
 *   node scripts/strix-cli.mjs status                  # 环境自检
 *   node scripts/strix-cli.mjs scan <target> [选项]     # 跑扫描（前台，很久）
 *   node scripts/strix-cli.mjs start <target> [选项]    # 后台跑，立即返回 runId
 *   node scripts/strix-cli.mjs list [n]                # 列最近的扫描
 *   node scripts/strix-cli.mjs report <runId|latest>   # 打印报告摘要
 *   node scripts/strix-cli.mjs findings <runId|latest> # 列漏洞条目
 *
 * 常用选项：
 *   --mode quick|standard|deep   扫描模式（默认 quick）
 *   --budget <USD>               预算上限（默认 2，务必设）
 *   --turns <N>                  最大轮次（默认 60）
 *   --instruction "<text>"       额外指令（测试账号/范围/禁区）
 *   --timeout <sec>              超时（默认 1800）
 *
 * 后台任务的产物落在 strix/runs/，用 list/report/findings 查看。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../lib/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STRIX_DIR = path.join(path.dirname(HERE), "strix");
const RUN_SH = path.join(STRIX_DIR, "run.sh");
const RUNS_DIR = path.join(STRIX_DIR, "runs", "strix_runs");

const args = process.argv.slice(2);
const action = args[0];

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/** 解析 --key value 形式的选项 */
function parseOpts(rest) {
  const o = { mode: "quick", budget: "2", turns: "60", timeout: 1800, instruction: "" };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    if (a === "--mode") o.mode = next();
    else if (a === "--budget") o.budget = next();
    else if (a === "--turns") o.turns = next();
    else if (a === "--timeout") o.timeout = Number(next()) || 1800;
    else if (a === "--instruction") o.instruction = next();
    else if (a === "--scan-mode") o.mode = next();
    else fail(`未知选项: ${a}`);
  }
  return o;
}

/** 构造 strix 参数 */
function buildArgs(target, o) {
  const a = ["-n", "-t", target, "--scan-mode", o.mode, "--max-budget", o.budget, "--max-turns", o.turns];
  if (o.instruction) a.push("--instruction", o.instruction);
  return a;
}

function ensureInstalled() {
  if (!fs.existsSync(RUN_SH)) fail(`找不到启动器: ${RUN_SH}`);
  if (!fs.existsSync(path.join(STRIX_DIR, "venv", "bin", "strix"))) {
    fail("strix 未安装（strix/venv 不存在）。见 strix/README.md");
  }
}

/** 列出扫描产物目录（按时间倒序） */
function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .map((name) => {
      const full = path.join(RUNS_DIR, name);
      let st = null;
      try { st = fs.statSync(full); } catch { return null; }
      if (!st.isDirectory()) return null;
      return { name, full, mtime: st.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

/** runId → 目录（支持 latest / 前缀匹配） */
function resolveRun(id) {
  const runs = listRuns();
  if (!runs.length) fail("还没有任何扫描记录");
  if (!id || id === "latest") return runs[0];
  const hit = runs.find((r) => r.name === id) || runs.find((r) => r.name.startsWith(id));
  if (!hit) fail(`找不到扫描: ${id}\n可用:\n` + runs.slice(0, 10).map((r) => "  " + r.name).join("\n"));
  return hit;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ── status ──────────────────────────────────────────────────────────
if (action === "status") {
  ensureInstalled();
  const pyOk = fs.existsSync(path.join(STRIX_DIR, "venv", "bin", "python"));
  const patch = spawnSync(path.join(STRIX_DIR, "venv", "bin", "python"), [path.join(STRIX_DIR, "scripts", "apply-patches.py"), "--check"], { encoding: "utf8" });
  const runs = listRuns();
  console.log("strix 本地引擎状态");
  console.log("  目录      ", STRIX_DIR);
  console.log("  venv      ", pyOk ? "就绪" : "缺失");
  console.log("  补丁      ", patch.status === 0 ? "已应用（local 后端可用）" : "未应用 —— 跑 scripts/apply-patches.py");
  console.log("  已完成扫描", runs.length, "次");
  if (runs.length) {
    const r = readJson(path.join(runs[0].full, "run.json"));
    console.log("  最近一次  ", runs[0].name);
    if (r) console.log("             状态:", r.status, "| 模式:", r.scan_mode, "| 成本:", r.llm_usage ? "$" + (Number(r.llm_usage.cost || 0)).toFixed(4) : "?");
  }
  process.exit(patch.status === 0 ? 0 : 1);
}

// ── scan（前台）────────────────────────────────────────────────────
if (action === "scan") {
  ensureInstalled();
  const target = args[1];
  if (!target) fail("用法: strix-cli.mjs scan <target> [--mode quick] [--budget 2]");
  const o = parseOpts(args.slice(2));
  const p = spawn(RUN_SH, buildArgs(target, o), { stdio: "inherit", cwd: ROOT });
  const timer = setTimeout(() => { p.kill("SIGTERM"); console.error(`\n[超时 ${o.timeout}s，已终止]`); }, o.timeout * 1000);
  p.on("exit", (code) => { clearTimeout(timer); process.exit(code ?? 1); });
}

// ── start（后台，立即返回）───────────────────────────────────────────
else if (action === "start") {
  ensureInstalled();
  const target = args[1];
  if (!target) fail("用法: strix-cli.mjs start <target> [选项]");
  const o = parseOpts(args.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logFile = path.join(STRIX_DIR, "runs", `bg-${stamp}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, "a");
  const p = spawn(RUN_SH, buildArgs(target, o), {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: ROOT,
  });
  p.unref();
  console.log("已后台启动 strix 扫描");
  console.log("  PID    ", p.pid);
  console.log("  目标   ", target);
  console.log("  模式   ", o.mode, "| 预算 $" + o.budget, "| 上限", o.turns, "轮");
  console.log("  日志   ", logFile);
  console.log("  ⚠ 扫描通常需要数分钟到数小时；用 list / report 查看结果");
  process.exit(0);
}

// ── list ────────────────────────────────────────────────────────────
else if (action === "list") {
  const n = Number(args[1]) || 10;
  const runs = listRuns().slice(0, n);
  if (!runs.length) { console.log("还没有扫描记录。"); process.exit(0); }
  console.log(`最近 ${runs.length} 次扫描：`);
  for (const r of runs) {
    const j = readJson(path.join(r.full, "run.json"));
    const when = new Date(r.mtime).toLocaleString("zh-CN");
    let info = "";
    if (j) {
      const cost = j.llm_usage?.cost != null ? "$" + Number(j.llm_usage.cost).toFixed(4) : "?";
      const vulns = j.vulnerabilities?.length ?? j.vulnerability_count ?? null;
      info = ` | ${j.status || "?"} | ${j.scan_mode || "?"} | ${cost}${vulns != null ? " | 漏洞 " + vulns : ""}`;
    }
    console.log(`  ${r.name}${info}\n    ${when}`);
  }
}

// ── report ──────────────────────────────────────────────────────────
else if (action === "report") {
  const r = resolveRun(args[1]);
  const f = path.join(r.full, "penetration_test_report.md");
  if (!fs.existsSync(f)) fail(`该次扫描没有报告文件: ${r.name}`);
  console.log(`# 报告: ${r.name}\n`);
  console.log(fs.readFileSync(f, "utf8"));
}

// ── findings ────────────────────────────────────────────────────────
else if (action === "findings") {
  const r = resolveRun(args[1]);
  const vf = path.join(r.full, "vulnerabilities.json");
  const j = readJson(vf);
  const list = Array.isArray(j) ? j : j?.vulnerabilities || [];
  if (!list.length) {
    console.log(`本次扫描未发现漏洞（${r.name}）。`);
    const sarif = path.join(r.full, "findings.sarif");
    if (fs.existsSync(sarif)) console.log("（SARIF 报告: " + sarif + "）");
    process.exit(0);
  }
  console.log(`发现 ${list.length} 个漏洞：\n`);
  for (const v of list) {
    console.log(`[${String(v.severity || "?").toUpperCase()}] ${v.title || v.id || "(无标题)"}`);
    if (v.description) console.log("  " + String(v.description).split("\n")[0].slice(0, 200));
    if (v.endpoint || v.url) console.log("  位置: " + (v.endpoint || v.url));
    console.log();
  }
}

// ── help ────────────────────────────────────────────────────────────
else {
  const doc = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const usage = doc.split("用法：")[1]?.split("*/")[0] || "";
  console.log("strix 本地黑盒渗透引擎（无 Docker）\n");
  console.log("用法：" + usage.trim());
}
