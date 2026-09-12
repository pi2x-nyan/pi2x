#!/usr/bin/env node
/**
 * 敏感数据扫描 —— 推送到公共仓库前的安全闸门
 *
 * 【为什么要这个脚本】
 * 这个仓库里混进了大量本机私有信息：API key、QQ token、真实 QQ 号、内网 IP。
 * 推公共仓库前必须逐项确认。手工 grep 会漏（模式多样），所以固化成可复跑的脚本，
 * 并且**默认对历史提交也扫描** —— 因为即使从工作区删掉，git 历史里仍然有，
 * `git push` 会把历史一起推上去。
 *
 * 用法：
 *   node scripts/scan-secrets.mjs            # 扫描工作区（当前被跟踪的文件）
 *   node scripts/scan-secrets.mjs --history  # 额外扫描全部提交历史
 *   node scripts/scan-secrets.mjs --json     # 机器可读输出
 *
 * 退出码：0 = 未发现高危；1 = 发现高危
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 支持扫描任意目录（导出公开版时需要扫「还不是 git 仓库」的目录）
// 注意：scripts/scan-secrets.mjs 自身要跳过 —— 它的规则里写着
// `/webui\?token=...` 这类**模式**，会被自己的正则命中，产生假阳性。
const SELF = "scripts/scan-secrets.mjs";

const ROOT = process.env.PI2X_SCAN_ROOT
  ? path.resolve(process.env.PI2X_SCAN_ROOT)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARGS = process.argv.slice(2);
const SCAN_HISTORY = ARGS.includes("--history");
const AS_JSON = ARGS.includes("--json");

/**
 * 规则表。severity: high = 必须处理；medium = 需确认；low = 提示。
 * 每条规则给出「为什么敏感」与「怎么处理」，便于非作者也能看懂报告。
 */
const RULES = [
  {
    id: "cc-pool-key",
    severity: "high",
    desc: "Command Code 账号池密钥（明文）",
    re: /\buser_[A-Za-z0-9]{40,}\b/g,
    fix: "该文件不应进仓库：加入 .gitignore 并从历史清除",
  },
  {
    id: "gh-token",
    severity: "high",
    desc: "GitHub 个人访问令牌",
    re: /\bghp_[A-Za-z0-9]{30,}\b/g,
    fix: "立即吊销该 token，并从历史清除",
  },
  {
    id: "openai-key",
    severity: "high",
    desc: "OpenAI 风格密钥",
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    fix: "改用环境变量，并从历史清除",
  },
  {
    id: "omniroute-key",
    severity: "high",
    desc: "硬编码的网关 API key（代码里写了默认值）",
    re: /\bor_[a-f0-9]{32,}\b/g,
    fix: "改为只从环境变量读取，不给默认值",
  },
  {
    id: "token-default-literal",
    severity: "high",
    desc: "代码里把密钥/令牌写成默认值（形如 `|| \"xxxx\"`）",
    // 这类写法等于把密钥焊进源码，且很多扫描规则抓不到（不是 JSON、不是 Bearer）
    re: /\|\|\s*"[A-Za-z0-9_\-]{12,}"\s*[;,)]|\|\|\s*"[A-Za-z0-9_\-]{12,}"\s*$/gm,
    fix: "改为只从配置/环境变量读取，不给默认值",
  },
  {
    id: "bearer-literal",
    severity: "high",
    desc: "字面量 Bearer 令牌",
    re: /Bearer\s+[A-Za-z0-9_\-.=]{24,}/g,
    fix: "改为从配置/环境变量注入",
  },
  {
    id: "napcat-token",
    severity: "high",
    desc: "OneBot/NapCat 连接令牌",
    re: /"token"\s*:\s*"[A-Za-z0-9_\-]{8,}"/g,
    fix: "从 config.json 移除该文件，改为示例配置 + 本地覆盖",
  },
  {
    // 【为什么要有这条】原规则只认 `"token": "xxx"` 这种 JSON 形态，
    // 于是 README 里 `http://127.0.0.1:6099/webui?token=xxxx` 这种 **URL 查询串**
    // 形式的真实 token 一路滑过扫描、被推上了公开仓库。
    // URL 里的密钥是最常见的泄露形态之一（复制粘贴日志、文档时极易带入）。
    id: "token-in-url",
    severity: "high",
    desc: "URL 查询串里的令牌（token=/key=/secret=/password=）",
    // 注意要包含**裸 key=**：只写 api_?key 会漏掉最常见的 ?key=xxx 形态。
    re: /[?&](?:token|access[_-]?token|api[_-]?key|key|secret|password|passwd|pwd|auth|apikey)=[A-Za-z0-9_\-.=]{6,}/gi,
    fix: "从文档/日志中删除真实值，改为占位符或说明「见启动日志」",
  },
  {
    // 同理：把「某端口 + 某个短 token」这类组合也纳入（哪怕没写成 JSON）
    id: "webui-url",
    severity: "medium",
    desc: "WebUI 地址直带凭据（应写明「见启动日志」）",
    re: /\/webui\?token=[^\s`"')]+/gi,
    fix: "改为「WebUI 地址与 token 见启动日志」",
  },
  {
    id: "winagent-token",
    severity: "high",
    desc: "win-agent 远程执行令牌（可远程控制 Windows）",
    re: /\b[a-f0-9]{48}\b/g,
    fix: "该 token 泄露等于 Windows 可被远程执行命令，必须换新",
  },
  {
    // 部署路径不是密钥，但会暴露目录结构，且别人 clone 后路径不对。
    //
    // 【为什么定 low 而不是 medium】本机仓库里 `<PI2X_ROOT>` 是**正确且必需**的：
    // prompt/ 里那些 `node <PI2X_ROOT>/scripts/xxx.mjs` 是模型运行时照着执行的命令，
    // 改了 bot 当场失效。所以本地扫描必然命中，报成 medium 只会变成长期噪音。
    // 归一化由 export-public 在**导出副本**上完成 —— 导出后扫描为 0。
    // 这条留 low 是为了提示「新文件若不在归一化覆盖范围内（如 .txt、无扩展名），
    // 需要单独处理」。
    id: "local-path",
    severity: "low",
    desc: "写死的本机部署路径",
    re: /\/opt\/pi2x|D:\\PI2X/g,
    fix: "导出时由 export-public.mjs 归一化为 <PI2X_ROOT>；新文件务必走同一规则",
  },
  {
    id: "private-ip",
    severity: "medium",
    desc: "内网 IP（暴露网络拓扑）",
    re: /\b10\.(?:208|126)\.\d{1,3}\.\d{1,3}\b/g,
    fix: "文档中改为占位符（如 <LAN_IP> / <OVERLAY_IP>）",
  },
  {
    id: "qq-number",
    severity: "medium",
    desc: "真实 QQ 号（身份信息）",
    re: /\b[1-9]\d{5,10}\b/g,
    fix: "配置类文件改为示例值；文档改为占位符",
    // QQ 号太容易误报（时间戳、端口等），只在特定文件类型里报
    onlyIn: /\.(json|md|sh|ps1)$|whitelist/,
  },
  {
    id: "hostname",
    severity: "low",
    desc: "本机主机名",
    re: /\bLAPTOP-[A-Z0-9]{6,}\b/g,
    fix: "文档改为占位符",
  },
  {
    // 注意：这里刻意不写具体姓名 —— 规则文件本身也可能被公开，
    // 把姓名当正则写进去等于换个地方泄露。改为从本地忽略文件读取。
    id: "real-name",
    severity: "medium",
    desc: "真实姓名/昵称（来自本机私有词表）",
    re: null, // 由 loadPrivateTerms() 动态构造
    fix: "从仓库中移除个人身份信息",
    private: true,
  },
];

/**
 * 收集要扫描的文件。
 * 优先用 git ls-files（只扫会被推送的部分）；非 git 目录则退化为遍历文件树。
 */
function trackedFiles() {
  try {
    const out = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
    if (out.length) return out;
  } catch {
    /* 不是 git 仓库 → 走遍历 */
  }
  const acc = [];
  const skip = new Set([".git", "node_modules", "tmp", "logs", "state", "sessions", "sandbox", "workspace", "agent-dir", "browser-profile", "browser-profile-op", "napcat", "win-agent"]);
  const walk = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (skip.has(n)) continue;
      const full = path.join(dir, n);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else acc.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  };
  walk(ROOT);
  return acc;
}

/** 跳过明显不该扫的二进制/体积大的文件 */
function isScannable(rel) {
  if (rel === SELF) return false; // 规则文件里写着各种“像密钥的**模式**”，扫自己只会产生假阳性
  if (/\.(png|jpg|jpeg|gif|webp|pdf|zip|gz|tar|woff2?|ttf|so|node|wasm|db|bundle)$/i.test(rel)) return false;
  if (rel.startsWith("package-lock.json")) return false; // 依赖清单，量大且非自研
  return true;
}

/** 允许的例外：文档里刻意写的占位/示例 */
const ALLOWLIST = [
  { id: "qq-number", file: /^test\//, note: "测试夹具里的假号码" },
  { id: "private-ip", file: /^test\/winhost\.test\.mjs$/, note: "winhost 测试用的地址样本" },
  { id: "qq-number", file: /^(lib|scripts|test)\//, note: "文档/注释里刻意使用的假号码" },
];

/** 明显是伪造的测试号码（1 开头 10 位），命中则一律不算真实 QQ */
const FAKE_QQ = /^100000000\d$/;

/**
 * 判断一个数字是否「不像 QQ 号」。
 * QQ 号是随机的，极少是整千整万；而代码里大量出现毫秒超时（180000/600000）。
 * 不排除这些会造成大量误报，让真正的问题淹没在噪音里。
 */
function unlikelyQQ(raw) {
  if (FAKE_QQ.test(raw)) return true;
  // 以 000/0000 结尾的整数（超时值、容量值）
  if (/0000$/.test(raw)) return true;
  if (Number(raw) % 10000 === 0) return true;
  return false;
}

function allowed(hit, rel) {
  return ALLOWLIST.some((a) => (a.id ? a.id === hit.rule : true) && a.file.test(rel));
}

/**
 * 载入本机私有词表（真实姓名等），不写进仓库。
 * 格式：.private-terms（每行一个词，文件被 .gitignore 忽略）
 */
function loadPrivateTerms() {
  try {
    return fs
      .readFileSync(path.join(ROOT, ".private-terms"), "utf8")
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith("#"));
  } catch {
    return [];
  }
}
const PRIVATE_TERMS = loadPrivateTerms();
for (const r of RULES) {
  if (r.private) {
    r.re = PRIVATE_TERMS.length ? new RegExp(PRIVATE_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : /$^/;
  }
}

function scanText(text, rel) {
  const hits = [];
  const lines = text.split("\n");
  for (const rule of RULES) {
    if (rule.onlyIn && !rule.onlyIn.test(rel)) continue;
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text))) {
      const idx = m.index;
      const lineNo = text.slice(0, idx).split("\n").length;
      const raw = m[0];
      // 打码：只留前后几位，报告本身不泄露明文
      const masked = raw.length <= 10 ? `${raw.slice(0, 2)}…` : `${raw.slice(0, 6)}…${raw.slice(-4)}`;
      if (rule.id === "qq-number" && unlikelyQQ(raw)) continue; // 不像 QQ 号的整数，跳过
      const hit = { rule: rule.id, severity: rule.severity, desc: rule.desc, fix: rule.fix, line: lineNo, masked, file: rel };
      if (!allowed(hit, rel)) hits.push(hit);
      if (re.lastIndex === idx) re.lastIndex++; // 防零宽死循环
    }
  }
  return hits;
}

const files = trackedFiles().filter(isScannable);
const findings = [];
for (const rel of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  findings.push(...scanText(text, rel));
}

// ── 历史扫描 ──
const historyFindings = [];
if (SCAN_HISTORY) {
  let log;
  try {
    log = execFileSync("git", ["-C", ROOT, "log", "--all", "--pretty=format:%H|%h|%s"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    log = [];
  }
  for (const line of log) {
    const [sha, short, subject] = line.split("|");
    let names;
    try {
      names = execFileSync("git", ["-C", ROOT, "ls-tree", "-r", "--name-only", sha], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const rel of names.filter(isScannable)) {
      let text;
      try {
        text = execFileSync("git", ["-C", ROOT, "show", `${sha}:${rel}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      } catch {
        continue;
      }
      for (const h of scanText(text, rel)) {
        historyFindings.push({ ...h, commit: short, subject: subject.slice(0, 50) });
      }
    }
  }
}

// ── 汇总 ──
const all = [...findings, ...historyFindings];
const bySeverity = { high: [], medium: [], low: [] };
for (const f of all) bySeverity[f.severity]?.push(f);

if (AS_JSON) {
  console.log(JSON.stringify({ workspace: findings, history: historyFindings, summary: { high: bySeverity.high.length, medium: bySeverity.medium.length, low: bySeverity.low.length } }, null, 2));
  process.exit(bySeverity.high.length ? 1 : 0);
}

console.log(`扫描范围：${files.length} 个被跟踪文件${SCAN_HISTORY ? ` + 全部提交历史` : ""}\n`);

function printGroup(title, list, limit = 40) {
  if (!list.length) {
    console.log(`【${title}】无\n`);
    return;
  }
  console.log(`【${title}】${list.length} 处`);
  const byRule = {};
  for (const h of list) {
    const k = `${h.rule}|${h.file}`;
    byRule[k] = byRule[k] ?? { ...h, count: 0, lines: [] };
    byRule[k].count++;
    if (byRule[k].lines.length < 5) byRule[k].lines.push(h.line);
  }
  for (const v of Object.values(byRule).slice(0, limit)) {
    const where = v.commit ? `${v.file} (提交 ${v.commit})` : v.file;
    console.log(`  · ${v.desc}`);
    console.log(`    ${where}${v.lines.length ? ` 行 ${v.lines.join(",")}` : ""}  ×${v.count}  例:${v.masked}`);
    if (v.fix) console.log(`    → ${v.fix}`);
  }
  console.log();
}

printGroup("高危（密钥/令牌，必须处理）", bySeverity.high);
printGroup("中危（身份/拓扑信息，需确认）", bySeverity.medium);
printGroup("提示", bySeverity.low);

console.log("─────");
console.log(`高危 ${bySeverity.high.length} · 中危 ${bySeverity.medium.length} · 提示 ${bySeverity.low.length}`);
if (SCAN_HISTORY && historyFindings.length) {
  const hc = new Set(historyFindings.map((h) => h.commit)).size;
  console.log(`⚠ 其中 ${historyFindings.length} 处存在于历史提交（涉及 ${hc} 个提交）——`);
  console.log(`  仅从工作区删除**不够**，push 会把历史一起推上去。`);
}
process.exit(bySeverity.high.length ? 1 : 0);
