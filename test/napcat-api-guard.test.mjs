/**
 * NapCat API 风险门禁的防复发测试。
 *
 * 【为什么需要它】
 * lib/napcat-api.mjs 只是**判定表**（riskOf → red/yellow/green），它自己不拦任何调用。
 * 于是安全性完全依赖「每个能把动态接口名透传给 OneBot 的入口都记得过 riskOf()」。
 *
 * 这个约定曾经被破坏过，而且是双重的：
 *   · 文件头自称「风险分级表 + 审核」，还带两个无人调用的 audit()/riskStats()，
 *     让人以为审核是内建的；
 *   · qq-cli 的 napcat 分支里那句判据实际是坏的（levelOf 未导入 → ReferenceError
 *     或短路失效），实测 operator 能直接取到 QQ 凭据（get_csrf_token）。
 *
 * 单靠「记得」不可靠，所以用测试把约定钉死：新增动态透传点时，
 * 要么先用 riskOf() 判定，要么显式写进豁免名单并说明理由。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API_FILE = path.join(ROOT, "lib/napcat-api.mjs");

/** 递归收集 .mjs 源文件（跳过运行期目录） */
function sources(dir, out = []) {
  // 跳过 test/：本文件用 `.api(someVar, …)` 这样的**示例**描述什么算危险点，
  // 不跳过会把自己扫成违规者（假阳性）。
  const skip = new Set(["node_modules", ".git", "tmp", "sandbox", "workspace", "logs", "state", "sessions", "agent-dir", "napcat", "test"]);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name) || e.name.startsWith(".")) continue;
    // 跳过其它测试生成的临时副本（persona-single / perm-block-routing 会把
    // piagent.mjs 复制成 lib/__piagent_*.mjs 来加载）。这些副本含同样的
    // `.api(var, …)` 危险点，但不属于"源码里的新增位置"；更麻烦的是它们只在
    // 那两条测试运行期间存在 —— 并发跑时本测试会偶发扫到，造成随机失败。
    if (e.name.startsWith("__")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (e.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

// ── 死代码已清、文件头诚实 ─────────────────────────────────────────────

test("napcat-api.mjs 不再提供无人调用的 audit() / riskStats()", () => {
  const src = fs.readFileSync(API_FILE, "utf8");
  assert.doesNotMatch(src, /export function audit\s*\(/, "死函数 audit() 又回来了（会让人误以为这里内建审核）");
  assert.doesNotMatch(src, /export function riskStats\s*\(/, "死函数 riskStats() 又回来了");
  const exports = [...src.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ["RISK", "riskOf"], `本文件导出物应只有 RISK 与 riskOf，实际：${exports.join(", ")}`);
});

test("文件头明确「本文件不拦截」，不再自称带审核", () => {
  const src = fs.readFileSync(API_FILE, "utf8");
  const head = src.slice(0, src.indexOf("export const RISK"));
  assert.match(head, /不做拦截|只是判定表|不拦/, "文件头没有说明「本文件不执行拦截」");
  assert.match(head, /riskOf/, "文件头没有指明真正的判定入口是 riskOf");
  // 只检查**第一句自我描述**（第一行标题），不检查后面解释「为什么改写」的段落 ——
  // 那段里必须引用旧措辞才能说清问题，把它算违规等于禁止记录历史。
  const title = head.split("\n").find((l) => l.includes("napcat-api.mjs")) ?? "";
  assert.doesNotMatch(title, /\+\s*审核/, `标题又在宣传自己带审核了：${title.trim()}`);
});

test("riskOf 的兜底是 red（未知接口一律拒绝）", () => {
  // 用子进程 import，避免把模块状态带进测试进程
  const src = fs.readFileSync(API_FILE, "utf8");
  assert.match(src, /return "red";\s*\/\/\s*未知\/规则外/, "未知接口的兜底必须仍是 red");
});

// ── 动态透传点必须过审 ────────────────────────────────────────────────

/**
 * 找出「把变量当接口名传给 api()」的位置。
 *
 * 写死的接口名（this.api("get_msg", …)）天然安全，不算透传；
 * 只有形如 .api(someVar, …) 才是危险点 —— 接口名来自运行期输入。
 */
function dynamicDispatchSites() {
  const sites = [];
  for (const file of sources(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // .api(标识符   （排除 .api("字面量" 与 .api(`模板` 里的纯静态串）
      const m = /\.api\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(line);
      if (m) sites.push({ rel, line: i + 1, arg: m[1], text: line.trim() });
    });
  }
  return sites;
}

test("所有把动态接口名透传给 OneBot 的位置，都在同一函数内做了 riskOf 判定", () => {
  const sites = dynamicDispatchSites();
  // 这两处是已知且已过审的：qq-cli 的 napcat 分支、piagent 的 RED 二次确认。
  // 若新增了第三处而没在这里登记，测试会失败 —— 这正是它的意义。
  const KNOWN = [
    { rel: "scripts/qq-cli.mjs", guard: /riskOf\(act\)/ },
    { rel: "lib/piagent.mjs", guard: /_consumeRedConfirm|riskOf\(/ },
  ];
  const unguarded = [];
  for (const s of sites) {
    const known = KNOWN.find((k) => k.rel === s.rel);
    if (!known) {
      unguarded.push(`${s.rel}:${s.line} → ${s.text}`);
      continue;
    }
    // 在同文件内确认存在对应的守卫写法
    const src = fs.readFileSync(path.join(ROOT, s.rel), "utf8");
    if (!known.guard.test(src)) unguarded.push(`${s.rel}:${s.line} 缺少守卫（应匹配 ${known.guard}）`);
  }
  assert.deepEqual(
    unguarded,
    [],
    `发现未登记的动态透传点（新增入口必须先过 riskOf，或在此登记并说明理由）：\n  ${unguarded.join("\n  ")}`,
  );
});

test("qq-cli 的 napcat 守卫同时覆盖 RED 与写接口前缀（两者取并集）", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/qq-cli.mjs"), "utf8");
  assert.match(src, /riskOf\(act\)\s*===\s*"red"/, "缺少 RED 判定");
  assert.match(src, /WRITE_API\.test\(act\)/, "缺少写接口前缀判定");
  // 判据里必须要求 admin 才放行（不能出现「非 admin 也能过」的写法）
  assert.match(src, /levelOf\(uid\)\s*<\s*PRESET_LEVEL\.admin/, "守卫没有比较权限等级");
});

test("qq-cli 正确导入了守卫所需的符号（这里曾漏过，导致守卫形同虚设）", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "qq-cli.mjs"), "utf8");
  // 注意解构名在 import( **之前**：`const { a, b } = await import(...)`。
  // 所以要取「包含 import( 的那一整行」，而不是从 import( 往后截 —— 后者抓不到解构名，
  // 会让这条测试永远失败（我第一版就是这样写错的）。
  const line = src.split("\n").find((l) => l.includes("op-policy.mjs") && l.includes("import("));
  assert.ok(line, "找不到 op-policy 的动态导入行");
  assert.match(line, /\blevelOf\b/, "levelOf 未被导入（守卫会 ReferenceError 或短路失效）");
  assert.match(line, /\bPRESET_LEVEL\b/, "PRESET_LEVEL 未被导入");
});

// ── 守卫行为（真跑一遍，不只查源码） ──────────────────────────────────

test("非 admin 调用 RED 接口会被拒绝（端到端，不只查源码）", async () => {
  const { riskOf } = await import("../lib/napcat-api.mjs");
  // 这些是曾实测能读到 QQ 凭据/搞破坏的接口，必须判 red
  for (const api of ["get_csrf_token", "get_cookies", "get_credentials", "bot_exit", "clean_cache", "delete_msg"]) {
    assert.equal(riskOf(api), "red", `${api} 应判 red`);
  }
  // 常规只读接口应放行
  for (const api of ["get_group_info", "get_friend_list"]) {
    assert.equal(riskOf(api), "green", `${api} 应判 green`);
  }
});
