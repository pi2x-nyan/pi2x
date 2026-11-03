#!/usr/bin/env node
/**
 * find-win-host —— 自动发现 Windows(win-agent) 的当前 IP 并写回 config.json
 *
 * 【为什么需要】
 * 手机与 Windows 都在校园网 DHCP 下，地址会变（手机 139.60↔140.0，Windows 135.71→166.169）。
 * 任一端一变，双向调用就断：手机调不到 win-agent，Windows 也连不上 OmniRoute。
 * EasyTier 本可给固定地址，但它的数据面在校园网里不通，故退而求其次做「自动发现」。
 *
 * 【为什么按端口扫，而不是按 MAC 找】
 * 实测手机 ARP 表里对端全是 00:00:5e:00:01:01（VRRP 网关虚拟 MAC）
 * —— 手机与 Windows 不在同一二层，走网关路由，所以 ARP/MAC 发现不可行。
 *
 * 【策略（从便宜到昂贵）】
 *   1) 先用 config 里当前 host 试探（绝大多数情况一次 HTTP 就结束）
 *   2) 再试缓存里记录过的历史地址
 *   3) 再试本机所在 /24
 *   4) 最后才扫整个 /18（约 1.6 万地址，用 TCP 连接探测 + 并发，几十秒）
 * 命中判定：TCP 能连上 win-agent 端口 **且** /ping 带正确 token 返回 ok（避免误认别的服务）。
 *
 * 用法：
 *   node scripts/find-win-host.mjs            # 需要时才扫；找到就更新 config
 *   node scripts/find-win-host.mjs --force    # 跳过缓存/当前值，直接扫
 *   node scripts/find-win-host.mjs --dry      # 只报告，不写 config
 */
import fs from "node:fs";
import { CONFIG_PATH, WHITELIST_PATH, STATE_DIR } from "../lib/config.mjs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = CONFIG_PATH;
// 【曾经这里漏了 STATE_DIR 的导入】只 import 了 CONFIG_PATH/WHITELIST_PATH，
// 导致本文件一加载就 `ReferenceError: STATE_DIR is not defined`（实测 2026-09-24 日志：
// [winShell] 自动发现失败 … STATE_DIR is not defined）—— 自动发现全灭、缓存永远停在旧 IP，
// 而它本来是“Windows 换 IP 后自动恢复”的那道保险。排查时先看到的是「windows shell 用不了」，
// 极易误判成网络/防火墙问题。
const CACHE = path.join(STATE_DIR, "win-host-cache.json");

const argv = new Set(process.argv.slice(2));
const FORCE = argv.has("--force");
const DRY = argv.has("--dry");
const QUIET = argv.has("--quiet");

const CONCURRENCY = 128;
const CONNECT_TIMEOUT_MS = 350;
const HTTP_TIMEOUT_MS = 2500;

const log = (m) => { if (!QUIET) console.log(`[find-win] ${m}`); };

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
}

const cfg = readJson(CONFIG, {});
const ws = cfg.winShell ?? {};
const TOKEN = ws.token;
const PORT = Number(ws.port);
if (!TOKEN || !PORT) {
  log("config.winShell 缺 token/port，退出");
  process.exit(2);
}

/** 带 token 确认某 IP 就是我们的 win-agent */
async function confirmWinAgent(ip) {
  try {
    const r = await fetch(`http://${ip}:${PORT}/ping`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return !!(j && j.ok === true);
  } catch {
    return false;
  }
}

/** 便宜探测：TCP 能否连上端口（用于大范围筛选，比 HTTP 省） */
function canConnect(ip) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(CONNECT_TIMEOUT_MS);
    s.once("connect", () => finish(true));
    s.once("timeout", () => finish(false));
    s.once("error", () => finish(false));
    try { s.connect(PORT, ip); } catch { finish(false); }
  });
}

/** 本机 wlan0 的 IPv4（顺便拿到所在 /24 与 /18 网段） */
async function localWlanIp() {
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("ip", ["-4", "-o", "addr", "show", "wlan0"], { encoding: "utf8" });
    const m = out.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    if (m) return { ip: m[1], prefix: Number(m[2]) };
  } catch { /* ignore */ }
  return null;
}

/** 生成候选（按代价递增） */
function buildCandidates(local) {
  const seen = new Set();
  const out = [];
  const push = (ip) => { if (ip && !seen.has(ip)) { seen.add(ip); out.push(ip); } };

  // 1) 缓存的已知地址（最近成功过的排前面）
  const cache = readJson(CACHE, { known: [] });
  for (const ip of cache.known ?? []) push(ip);
  // 2) 本机所在 /24
  if (local) {
    const base = local.ip.split(".").slice(0, 3).join(".");
    for (let i = 1; i <= 254; i++) push(`${base}.${i}`);
  }
  return { quick: out, seen: seen };
}

/** 生成整个 /18 的地址（<LAN_A>/18）。
 *  网段前缀不写死：由调用方按「本机实际 IP」（来自本机网卡）推导出 /18 基址，
 *  避免把部署环境的私网前缀固化进源码（会被 scan-secrets 判为中危、也不利于换网段）。
 *  说明：历史上这里写死过校园网网段，导出公开仓库时触发扫描告警。
 */
function fullRange(local) {
  const out = [];
  // 无本机地址时不做全段扫描（扫全网段既慢又可能惊动网关）
  if (!local || !local.ip) return out;
  const parts = local.ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return out;
  // 以本机 IP 为准推出 /18：第三段按 64 对齐（128..191 是其一个 /18 区间）
  const a = parts[0];
  const b = parts[1];
  const cStart = Math.floor(parts[2] / 64) * 64;
  for (let c = cStart; c < cStart + 64; c++) {
    for (let d = 1; d <= 254; d++) out.push(`${a}.${b}.${c}.${d}`);
  }
  return out;
}

/** 并发跑一批探针，任一命中即返回（带上限，避免把校园网关当靶子猛扫） */
async function sweep(ips, { useHttp = false, label = "" } = {}) {
  let idx = 0;
  let hit = null;
  const workers = new Array(Math.min(CONCURRENCY, ips.length)).fill(0).map(async () => {
    while (!hit) {
      const i = idx++;
      if (i >= ips.length) return;
      const ip = ips[i];
      const ok = useHttp ? await confirmWinAgent(ip) : (await canConnect(ip)) && (await confirmWinAgent(ip));
      if (ok) { hit = ip; return; }
    }
  });
  log(`  扫描 ${label}（${ips.length} 个地址，并发 ${workers.length}）…`);
  const t0 = Date.now();
  await Promise.all(workers);
  if (hit) log(`  命中 ${hit}（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  else log(`  未命中（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return hit;
}

function saveHost(ip) {
  if (DRY) { log(`[--dry] 本应把 winShell.host 改为 ${ip}`); console.log(`FOUND=${ip}`); return; }
  const fresh = readJson(CONFIG, cfg);
  if (fresh.winShell) fresh.winShell.host = ip;
  fs.writeFileSync(CONFIG, JSON.stringify(fresh, null, 2));
  // 记录历史（最多留 10 个），供下次优先试
  const cache = readJson(CACHE, { known: [] });
  const known = [ip, ...(cache.known ?? []).filter((x) => x !== ip)].slice(0, 10);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ known, updatedAt: new Date().toISOString() }, null, 2));
  log(`已写入 config.json: winShell.host = ${ip}`);
  console.log(`FOUND=${ip}`); // 机器可读：供 WinHostResolver 解析
}

(async () => {
  const local = await localWlanIp();
  log(`本机 wlan0: ${local ? local.ip + "/" + local.prefix : "未知"}`);
  const current = ws.host;

  // ── 1) 当前值 / 缓存 / 本机同段（便宜）
  if (!FORCE) {
    if (current && (await confirmWinAgent(current))) { log(`当前 host ${current} 可用，无需变更`); console.log(`FOUND=${current}`); process.exit(0); }
    const { quick } = buildCandidates(local);
    const skip = local ? local.ip : null;
    const cands = quick.filter((ip) => ip !== skip);
    const hitQuick = await sweep(cands, { useHttp: true, label: "缓存+本机/24" });
    if (hitQuick) { saveHost(hitQuick); process.exit(0); }
  }

  // ── 2) 整个 /18（贵）——TCP 初筛 + HTTP 确认
  const all = fullRange(local).filter((ip) => ip !== (local ? local.ip : ""));
  const hit = await sweep(all, { label: "全 /18" });
  if (hit) { saveHost(hit); process.exit(0); }

  log("全段未找到 win-agent。可能原因：Windows 未开机/未联网、win-agent 未启动、或防火墙未放行本机网段。");
  process.exit(1);
})();
