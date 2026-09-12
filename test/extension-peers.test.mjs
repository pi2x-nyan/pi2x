/**
 * pi 扩展 peer 依赖的自愈逻辑测试。
 *
 * 背景（真实故障）：pi-web-access 扩展把 @earendil-works/* 声明为 peerDependencies，
 * 但 pi 的包管理器不装 peer；而 pi 用 jiti + alias 加载扩展，alias 只覆盖静态
 * import —— 扩展里用动态 import() 懒加载的模块会绕过 alias、回退 Node 原生解析，
 * 于是抛 "Cannot find module '@earendil-works/pi-coding-agent'"。
 * 症状是「pi 一切正常，只有某个工具（如 fetch_content）莫名不可用」。
 *
 * 修法是在扩展的 node_modules 下软链三个 peer，由 preflight 每次幂等执行。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PREFLIGHT = path.join(ROOT, "scripts", "preflight.mjs");

test("preflight 包含 peer 依赖自愈步骤", () => {
  const src = fs.readFileSync(PREFLIGHT, "utf8");
  assert.match(src, /function healExtensionPeers/, "必须有 healExtensionPeers 实现");
  assert.match(src, /step\("pi 扩展 peer 依赖自愈"/, "必须注册为冒烟检查步骤");
});

test("自愈覆盖三个 peer 且指向 pi 自带包", () => {
  const src = fs.readFileSync(PREFLIGHT, "utf8");
  for (const p of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
    assert.match(src, new RegExp(`"@earendil-works/${p}"`), `必须处理 ${p}`);
  }
  // 目标必须是 pi 自带的那份（而不是再指向别处）
  assert.match(src, /pi-coding-agent\/node_modules\/@earendil-works\/pi-ai/, "pi-ai 应指向 pi 内部那份");
  assert.match(src, /pi-coding-agent\/node_modules\/@earendil-works\/pi-tui/, "pi-tui 应指向 pi 内部那份");
});

test("自愈不能拦住重启（软链失败不是致命故障）", () => {
  const src = fs.readFileSync(PREFLIGHT, "utf8");
  // 函数体里所有 return 的 ok 都应为 true
  const fn = src.slice(src.indexOf("function healExtensionPeers"), src.indexOf("console.log(`── PI2X 冒烟检查"));
  const returns = [...fn.matchAll(/return\s+\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(returns.length > 0, "应有 return 语句");
  for (const r of returns) {
    assert.match(r, /ok:\s*true/, `不该因软链问题失败：${r}`);
  }
});

test("自愈是幂等的（已存在的正确软链不重复动）", () => {
  const src = fs.readFileSync(PREFLIGHT, "utf8");
  assert.match(src, /readlinkSync/, "应读取现有链接目标以判断是否已正确");
  assert.match(src, /if \(cur === target\) continue/, "目标一致时应直接跳过");
});

test("真实环境下三个 peer 均可解析（修复生效）", () => {
  const nm = "/root/.pi/agent/npm/node_modules/@earendil-works";
  if (!fs.existsSync(nm)) {
    // 未部署扩展的环境跳过（不应因此失败）
    return;
  }
  for (const p of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
    const link = path.join(nm, p);
    assert.ok(fs.existsSync(link), `${p} 应可解析（软链存在且目标有效）`);
  }
});
