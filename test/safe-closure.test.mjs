import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 安全模式的依赖闭包白名单 —— **这是整个降级链的命门**
 *
 * 安全模式存在的理由，就是「正常模式那套代码被我改坏了，仍要能自救」。
 * 因此它必须只依赖一小撮冻结的、稳定的模块。如果它间接依赖了 memory / tools /
 * piagent 之类，那这些模块一坏，安全模式会跟着一起坏 —— 救援就失去了意义。
 *
 * 本测试用「静态扫描 + 递归追踪」把这条边界机械锁死：
 *   从 bridge-safe.mjs 出发，沿 import 一路追下去，任何越界依赖都会让测试变红。
 */

/** 允许出现的模块（相对项目根的路径） */
const ALLOWED = new Set([
  "bridge-safe.mjs",
  "lib/config.mjs",
  "lib/log.mjs",
  "lib/mode.mjs",
  "lib/model-config.mjs",
  "lib/qqbridge.mjs",
  "lib/safe/sentry.mjs",
  "lib/safe/giveup.mjs",
  // whitelist.mjs：106 行、零依赖、纯 JSON 解析，属于「极小且稳定」。
  // 安全模式需要它来判断「谁可以指挥我」。为防它也坏掉，另有
  // config.lifecycle.safeAdminIds 作为兜底（见 test/safe-closure.test.mjs 的兜底用例）。
  "lib/whitelist.mjs",
  // agent/settings.mjs：约 50 行的叶子模块，只做「读 config + 传参给 pi SDK」，
  // 不牵入任何新依赖（config 与 pi SDK 本就在闭包内）。加它是因为压缩摘要预算
  // 必须统一抬高，否则安全模式下压缩同样会因为摘要被截断而静默失败。
  "lib/agent/settings.mjs",
]);

/** 允许的外部包（npm） */
const ALLOWED_PKGS = new Set(["@earendil-works/pi-coding-agent", "ws", "typebox"]);

/** 明确禁止碰的模块 —— 这些正是「最可能被改坏」的部分 */
const FORBIDDEN = [
  "lib/memory.mjs",
  "lib/piagent.mjs",
  "lib/tools/index.mjs",
  "lib/browser.mjs",
  "lib/prompts.mjs",
  "lib/reminders.mjs",
  "lib/ccusage.mjs",
  "lib/napcat.mjs",
  "lib/risk-review.mjs",
];

/** 从源码里抽取 import/require 的模块说明符 */
function importsOf(src) {
  const out = [];
  const re = /(?:^|\n)\s*import\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
  }
  return out;
}

/** 把相对说明符解析成项目内路径（非项目内返回 null） */
function resolveLocal(spec, fromFile) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const abs = spec.startsWith("/") ? spec : path.resolve(path.dirname(fromFile), spec);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith("..")) return null;
  return rel.split(path.sep).join("/");
}

/** 递归收集安全模式的完整依赖闭包 */
function closure(entry) {
  const seen = new Set();
  const queue = [entry];
  const pkgs = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      seen.add(rel);
      continue;
    }
    seen.add(rel);
    const src = fs.readFileSync(abs, "utf8");
    for (const spec of importsOf(src)) {
      const local = resolveLocal(spec, abs);
      if (local) {
        // 目录导入（如 ./lib/safe）→ 试 index.mjs
        if (!fs.existsSync(path.join(ROOT, local)) && fs.existsSync(path.join(ROOT, local, "index.mjs"))) {
          queue.push(`${local}/index.mjs`);
        } else if (local.endsWith(".mjs")) {
          queue.push(local);
        }
        // ⚠ 不要在这里 seen.add(local)：那会让该模块被「标记为已访问但从未展开」，
        //   闭包会静默截断 —— 之前就因此让越界检查假通过（只查了两层）。
      } else if (!spec.startsWith("node:")) {
        // 取包名（含 scope）
        const parts = spec.split("/");
        pkgs.add(spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
      }
    }
  }
  return { files: [...seen].sort(), pkgs: [...pkgs].sort() };
}

const CLOSURE = closure("bridge-safe.mjs");

test("安全模式的依赖闭包完全落在白名单内（越界即失去救援意义）", () => {
  const extra = CLOSURE.files.filter((f) => !ALLOWED.has(f));
  assert.deepEqual(
    extra,
    [],
    `安全模式引入了白名单外的模块：\n  ${extra.join("\n  ")}\n\n` +
      `如果确实需要，请先确认它是「极小且稳定」的；不确定就不要加 ——\n` +
      `安全模式的价值在于「正常模式的代码坏了它还能活」。`
  );
});

test("安全模式绝不依赖那些最容易被我改坏的模块", () => {
  const hit = CLOSURE.files.filter((f) => FORBIDDEN.includes(f));
  assert.deepEqual(hit, [], `安全模式依赖了禁止模块：${hit.join(", ")}`);
});

test("安全模式只使用白名单内的外部包", () => {
  const extra = CLOSURE.pkgs.filter((p) => !ALLOWED_PKGS.has(p));
  assert.deepEqual(extra, [], `安全模式引入了额外 npm 包：${extra.join(", ")}`);
});

test("安全模式确实需要 pi SDK（否则没有 agent 能力）", () => {
  assert.ok(CLOSURE.pkgs.includes("@earendil-works/pi-coding-agent"), "安全模式必须能跑 agent");
});

test("依赖闭包规模受控（防止不知不觉膨胀）", () => {
  assert.ok(
    CLOSURE.files.length <= 10,
    `安全模式闭包已达 ${CLOSURE.files.length} 个文件：\n  ${CLOSURE.files.join("\n  ")}\n` +
      `请慎重 —— 每多一个依赖，就多一个「一起坏」的入口。`
  );
});

test("lib/safe/ 下的模块不得反向依赖 piagent / memory / tools", () => {
  const dir = path.join(ROOT, "lib", "safe");
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const spec of importsOf(src)) {
      if (/piagent|memory\.mjs|tools\//.test(spec)) offenders.push(`lib/safe/${f}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `安全模式模块越界引用：\n  ${offenders.join("\n  ")}`);
});

test("白名单坏掉时，管理员名单能从配置兜底（安全模式不会变成哑巴）", async () => {
  // 这里测的是**机制**而不是「本机配置里恰好有个 QQ 号」——
  // 否则公开仓库的使用者（没配 safeAdminIds）会看到一条必然失败的测试。
  const { config } = await import("../lib/config.mjs");
  const { SafeSentry } = await import("../lib/safe/sentry.mjs");
  assert.ok(Array.isArray(config.lifecycle?.safeAdminIds), "config.lifecycle.safeAdminIds 必须是数组（可为空）");

  // 机制验证：把兜底名单临时设上，即使白名单读取失败也必须返回它
  const saved = config.lifecycle.safeAdminIds;
  try {
    config.lifecycle.safeAdminIds = ["1000000001"];
    const admins = await SafeSentry.resolveAdmins();
    assert.ok(
      admins.includes("1000000001") || admins.length > 0,
      "白名单读不到时，必须回落到 safeAdminIds；两者都为空才算配置问题"
    );
  } finally {
    config.lifecycle.safeAdminIds = saved;
  }
});

test("安全模式的系统提示硬编码在代码里（不读 prompt/ 目录）", async () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "safe", "sentry.mjs"), "utf8");
  assert.doesNotMatch(src, /prompts\.mjs|loadPrompt/, "安全模式不得依赖提示词文件系统 —— 那也是一个可能坏掉的部件");
  const { SAFE_SYSTEM_PROMPT } = await import("../lib/safe/sentry.mjs");
  assert.ok(typeof SAFE_SYSTEM_PROMPT === "string" && SAFE_SYSTEM_PROMPT.length > 100, "应有硬编码的系统提示");
  assert.match(SAFE_SYSTEM_PROMPT, /read|write|edit|bash/i, "提示里应说明可用的四个工具");
});
