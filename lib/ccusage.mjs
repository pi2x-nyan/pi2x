/**
 * Command Code 号池用量统计
 *
 * 数据来源（两条互补）：
 *  1) 账号侧（权威、含 CLI 直连用量）：
 *     GET /alpha/billing/credits    → 月度剩余额度 + 5h/周 滚动窗口 used/cap
 *     GET /alpha/usage/summary      → 计费周期内 请求数 / 输入输出 token / 花费
 *     GET /alpha/billing/subscriptions → 计费周期起点（用于对齐本地命中率窗口）
 *     对 .cc-pool.json 里每个账号并发查询后求和。
 *  2) 本地侧（拿缓存命中率；账号 API 不暴露 cache 明细）：
 *     omniroute（模型网关）每次调用都落 call_logs/<date>/*.json，
 *     summary.tokens = { in, out, cacheRead, cacheWrite }。
 *     按 account 匹配（默认含 "cc-go"）过滤，命中率 = ΣcacheRead / Σin。
 *     只读文件头 4KB 抠出 summary，避免解析整份大 body。
 *
 * 说明：账号 API 的 totalTokensIn 是「总输入 token」（含命中缓存部分），
 * 已实测验证：同一长提示第二次调用 prompt_tokens 不变、cached_tokens=3456。
 */
import fs from "node:fs";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";

// api.commandcode.ai 只解析出 Cloudflare AAAA，本机 IPv6 黑洞 → 偶发 fetch failed。
// 与 commandcode-proxy.mjs 同样处理：强制优先 IPv4。
dns.setDefaultResultOrder("ipv4first");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const CC_USAGE = {
  base: process.env.COMMANDCODE_API_BASE ?? "https://api.commandcode.ai",
  poolFile: process.env.COMMANDCODE_POOL_FILE ?? path.join(ROOT, ".cc-pool.json"),
  logsDir: process.env.OMNIROUTE_CALL_LOGS ?? "/root/.omniroute/call_logs",
  accountMatch: process.env.PI2X_CC_ACCOUNT_MATCH ?? "cc-go",
  ttlMs: Number(process.env.PI2X_CC_USAGE_TTL_MS ?? 60000),
  timeoutMs: Number(process.env.PI2X_CC_USAGE_TIMEOUT_MS ?? 8000),
};

const NIL = null;

function readPool() {
  try {
    const arr = JSON.parse(fs.readFileSync(CC_USAGE.poolFile, "utf8"));
    return (Array.isArray(arr) ? arr : []).filter((a) => a?.key);
  } catch {
    return [];
  }
}

async function apiGetOnce(key, pathname) {
  const r = await fetch(CC_USAGE.base + pathname, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "user-agent": "command-code/0.26.20",
      "x-command-code-version": "0.26.20",
      "x-cli-environment": "production",
      "x-co-flag": "false",
    },
    signal: AbortSignal.timeout(CC_USAGE.timeoutMs),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return j;
}

/** 带重试：偶发 fetch failed（IPv6 黑洞/CF 抖动）重试 2 次 */
async function apiGet(key, pathname, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await apiGetOnce(key, pathname);
    } catch (e) {
      last = e;
      if (/HTTP 4\d\d/.test(String(e?.message ?? ""))) break; // 4xx 不重试
      // 退避逐步拉长：进程刚启动时 DNS/连接可能还没热，太短的间隔会在
      // 1.5 秒内把 4 次机会用光（实测重启后首次 /status 就撞上这个）。
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}

/** 单账号：credits + summary + subscriptions 并发取 */
async function accountStats(acct) {
  const out = { name: acct.name ?? "?", ok: false, partial: false, credits: NIL, summary: NIL, sub: NIL, error: "" };
  const [c, s, b] = await Promise.allSettled([
    apiGet(acct.key, "/alpha/billing/credits"),
    apiGet(acct.key, "/alpha/usage/summary"),
    apiGet(acct.key, "/alpha/billing/subscriptions"),
  ]);
  if (c.status === "fulfilled") out.credits = c.value;
  if (s.status === "fulfilled") out.summary = s.value;
  if (b.status === "fulfilled") out.sub = b.value?.data ?? b.value;
  out.ok = !!(out.credits || out.summary);
  out.partial = out.ok && !(out.credits && out.summary);
  if (!out.ok) {
    out.error = String(
      c.reason?.message ?? s.reason?.message ?? b.reason?.message ?? "未知错误",
    ).slice(0, 80);
  }
  return out;
}

let _poolCache = { ts: 0, data: NIL };

/** 取数失败时的短缓存时长：只用来防「同一瞬间被连点多次」的重复请求，
 *  绝不能让一次网络抖动在接下来一分钟里持续显示为「全部失败」。 */
const FAIL_TTL_MS = 5000;

function cachePool(data, ts = Date.now()) {
  _poolCache = { ts, data };
}
let _poolInflight = NIL;

/**
 * 汇总号池全部账号用量。
 * @returns {Promise<{ok:boolean, ts:number, accounts:any[], agg:any, error:string}>}
 */
export async function poolUsage({ force = false, ttlMs = CC_USAGE.ttlMs } = {}) {
  // 缓存有效期：成功用配置的 ttlMs；失败用很短的 FAIL_TTL_MS。
  // 这一点很关键 —— 曾经「失败结果也被缓存 60 秒」，导致重启后第一次取数失败时，
  // 用户紧接着再查一次看到的还是同一份失败快照（表现为「号池 0/3」，实际早就通了）。
  if (!force && _poolCache.data) {
    const ttl = Number(_poolCache.data.ttl) || ttlMs;
    if (Date.now() - _poolCache.ts < ttl) return _poolCache.data;
  }
  if (_poolInflight) return _poolInflight;
  _poolInflight = (async () => {
    const pool = readPool();
    const empty = {
      ok: false, ts: Date.now(), accounts: [], error: pool.length ? "" : "账号池为空（.cc-pool.json）",
      agg: blankAgg(),
    };
    if (!pool.length) return empty;
    const accounts = await Promise.all(pool.map(accountStats));
    const agg = blankAgg();
    for (const a of accounts) {
      agg.accounts++;
      if (!a.ok) { agg.failed++; continue; }
      // 只累加取到的字段：拿不到就保持不计入（标 partial），避免把「失败」当成 0 用
      const cr = a.credits?.credits;
      const wl = a.credits?.windowLimits;
      if (cr) {
        agg.monthlyLeft += num(cr.monthlyCredits);
        agg.purchased += num(cr.purchasedCredits);
        agg.free += num(cr.freeCredits);
      }
      if (wl) {
        const fh = wl.fiveHour ?? {}, wk = wl.weekly ?? {};
        agg.fiveUsed += num(fh.used); agg.fiveCap += num(fh.cap);
        agg.weekUsed += num(wk.used); agg.weekCap += num(wk.cap);
        if (fh.resetAt) agg.fiveResetAt = agg.fiveResetAt ? Math.min(agg.fiveResetAt, fh.resetAt) : fh.resetAt;
        if (wk.resetAt) agg.weekResetAt = agg.weekResetAt ? Math.min(agg.weekResetAt, wk.resetAt) : wk.resetAt;
      }
      if (a.summary) {
        // 月度总额度 = 已用（summary.totalCost）+ 剩余，避免各账号档位不同时算错
        const cost = num(a.summary.totalCost);
        agg.used += cost;
        agg.requests += num(a.summary.totalCount);
        agg.tokensIn += num(a.summary.totalTokensIn);
        agg.tokensOut += num(a.summary.totalTokensOut);
      }
      if (a.credits && a.summary) {
        agg.monthQuota += num(a.summary.totalCost) + num(cr?.monthlyCredits) + num(cr?.purchasedCredits) + num(cr?.freeCredits);
        agg.quotaAccounts++;
      }
      const ps = a.sub?.currentPeriodStart;
      if (ps) { const t = Date.parse(ps); if (Number.isFinite(t)) agg.periodStart = agg.periodStart ? Math.min(agg.periodStart, t) : t; }
    }
    const partial = accounts.filter((a) => a.partial).length;
    const notes = [];
    if (agg.failed) notes.push(`${agg.failed} 个账号取数失败`);
    if (partial) notes.push(`${partial} 个账号部分字段缺失`);
    const allFailed = agg.failed > 0 && agg.failed === agg.accounts;
    const data = { ok: agg.accounts > 0, ts: Date.now(), accounts, agg, error: notes.join(" · "), ttl: allFailed ? FAIL_TTL_MS : undefined };
    cachePool(data);
    return data;
  })().catch((e) => {
    const d = { ok: false, ts: Date.now(), accounts: [], agg: blankAgg(), error: String(e?.message ?? e).slice(0, 120), ttl: FAIL_TTL_MS };
    cachePool(d);
    return d;
  }).finally(() => { _poolInflight = NIL; });
  return _poolInflight;
}

function blankAgg() {
  return {
    accounts: 0, failed: 0, quotaAccounts: 0, monthlyLeft: 0, monthQuota: 0, purchased: 0, free: 0, used: 0,
    fiveUsed: 0, fiveCap: 0, weekUsed: 0, weekCap: 0, fiveResetAt: 0, weekResetAt: 0,
    requests: 0, tokensIn: 0, tokensOut: 0, periodStart: 0,
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ── 本地 call_logs：抠 summary（只读文件头，避免整份大 body 解析）──
function readSummary(file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    const s = buf.subarray(0, n).toString("utf8");
    const k = s.indexOf('"summary"');
    if (k < 0) return NIL;
    const st = s.indexOf("{", k);
    if (st < 0) return NIL;
    let depth = 0, inStr = false, esc = false;
    for (let i = st; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return JSON.parse(s.slice(st, i + 1)); }
    }
  } catch { /* 忽略坏文件 */ } finally { if (fd >= 0) try { fs.closeSync(fd); } catch {} }
  return NIL;
}

let _logCache = { ts: 0, key: "", data: NIL };

/**
 * 本地网关（omniroute）侧缓存命中统计。
 * @param {{sinceTs?:number}} opts sinceTs 只统计该时刻之后的调用（缺省=全部）
 */
export function localCacheStats({ sinceTs = 0 } = {}) {
  const key = `${sinceTs}`;
  if (_logCache.data && _logCache.key === key && Date.now() - _logCache.ts < CC_USAGE.ttlMs) return _logCache.data;
  const res = { calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, hitRate: 0, dirs: 0 };
  try {
    const days = fs.readdirSync(CC_USAGE.logsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const day of days) {
      const dayStart = Date.parse(`${day}T00:00:00Z`);
      if (Number.isFinite(dayStart) && sinceTs && dayStart + 864e5 <= sinceTs) continue; // 整天早于窗口
      const dir = path.join(CC_USAGE.logsDir, day);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      res.dirs++;
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const s = readSummary(path.join(dir, f));
        if (!s || s.path !== "/v1/chat/completions") continue;
        if (!String(s.account ?? "").includes(CC_USAGE.accountMatch)) continue;
        const ts = Date.parse(s.timestamp ?? "");
        if (sinceTs && (!Number.isFinite(ts) || ts < sinceTs)) continue;
        const t = s.tokens ?? {};
        const tin = num(t.in);
        if (!tin && !num(t.out)) continue;
        res.calls++;
        res.tokensIn += tin;
        res.tokensOut += num(t.out);
        res.cacheRead += num(t.cacheRead);
      }
    }
    res.hitRate = res.tokensIn ? res.cacheRead / res.tokensIn : 0;
  } catch (e) {
    res.error = String(e?.message ?? e).slice(0, 80);
  }
  _logCache = { ts: Date.now(), key, data: res };
  return res;
}

// ── 格式化 ──
export function fmtTokens(n) {
  n = num(n);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
const fmtMoney = (n) => `$${num(n).toFixed(3)}`;
/** 手机友好：金额保留 2 位即可 */
const fmtMoney2 = (n) => `$${num(n).toFixed(2)}`;

/**
 * /status 用：号池用量 + 缓存命中率。
 * 格式针对手机（窄屏、行短、不用对齐空格）。
 * @returns {Promise<string|null>} 失败返回 null（不打扰 /status）
 */
export async function statusLines() {
  let data = NIL;
  try { data = await poolUsage(); } catch { return NIL; }
  if (!data || !data.accounts?.length) {
    return data?.error ? `CC 号池 取数失败：${data.error}` : NIL;
  }
  const a = data.agg;
  const lines = [];
  const full = a.quotaAccounts > 0 && a.quotaAccounts === a.accounts - a.failed;
  lines.push(`CC 号池 ${a.accounts - a.failed}/${a.accounts} 在线`);
  // 中文标签比 in/out 更宽，所以去掉「用量」前缀、直接用「入/出」：
  // 实测「用量 in 252.64M · out 1.32M」= 27 宽会折行，改成这样 21 宽，移动端一行放得下。
  lines.push(`入 ${fmtTokens(a.tokensIn)} · 出 ${fmtTokens(a.tokensOut)}`);
  lines.push(`${a.requests} 次请求 · 花费 ${fmtMoney(a.used)}`);
  const lc = localCacheStats({ sinceTs: a.periodStart || 0 });
  lines.push(lc.calls ? `命中率 ${(lc.hitRate * 100).toFixed(1)}%` : "命中率 无样本");
  lines.push(full
    ? `额度 剩 ${fmtMoney2(a.monthlyLeft)}/${fmtMoney2(a.monthQuota)}`
    : `额度 剩 ${fmtMoney2(a.monthlyLeft)}（部分未取到）`);
  const win = [];
  if (a.fiveCap) win.push(`5h ${a.fiveUsed.toFixed(2)}/${a.fiveCap.toFixed(0)}`);
  if (a.weekCap) win.push(`周 ${a.weekUsed.toFixed(2)}/${a.weekCap.toFixed(0)}`);
  if (win.length) lines.push(win.join(" · "));
  const per = data.accounts
    .filter((x) => x.ok && x.summary)
    .map((x) => {
      const left = x.credits ? `剩 ${fmtMoney2(num(x.credits.credits?.monthlyCredits))}` : "剩 ?";
      return `${x.name} ${fmtMoney2(x.summary.totalCost)} · ${left}`;
    });
  if (per.length) { lines.push("账号"); lines.push(...per); }
  if (data.error) lines.push(`（${data.error}）`);
  return lines.join("\n");
}

/** 供 CLI 调试：纯对象输出 */
export async function snapshot({ force = true } = {}) {
  const p = await poolUsage({ force });
  const lc = localCacheStats({ sinceTs: p.agg.periodStart || 0 });
  return {
    ok: p.ok, error: p.error, ts: p.ts, agg: p.agg, local: lc,
    accounts: p.accounts.map((x) => ({
      name: x.name, ok: x.ok, error: x.error,
      monthlyLeft: num(x.credits?.credits?.monthlyCredits),
      partial: !!x.partial,
      fiveHour: x.credits?.windowLimits?.fiveHour ?? NIL,
      weekly: x.credits?.windowLimits?.weekly ?? NIL,
      requests: num(x.summary?.totalCount),
      tokensIn: num(x.summary?.totalTokensIn),
      tokensOut: num(x.summary?.totalTokensOut),
      cost: num(x.summary?.totalCost),
      periodStart: x.sub?.currentPeriodStart ?? NIL,
    })),
  };
}
