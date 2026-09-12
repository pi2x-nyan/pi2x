import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 沙盒白名单约束 —— 机械锁死「operator 能看到什么」
 *
 * 【为什么需要这个测试】
 * 沙盒原先是黑名单（整个文件系统只读 + 遮几个敏感路径），漏了 sessions/、logs/、
 * state/、browser-profile/，实测 operator 能读到**所有人的聊天记录**。
 * 黑名单永远会漏，所以改成白名单。但白名单也可能被后人改回黑名单，
 * 或者不小心 `--ro-bind / /` 加回来。这个测试用静态扫描守住这条线。
 */

const SANDBOX_SRC = path.join(ROOT, "lib", "piagent.mjs");

function sandboxBlock() {
  const src = fs.readFileSync(SANDBOX_SRC, "utf8");
  const start = src.indexOf('const bwrap = [');
  assert.ok(start > 0, "找不到 bwrap 定义");
  const end = src.indexOf('"bash", "-c", cmd,', start);
  assert.ok(end > start, "找不到 bwrap 定义结尾");
  return src.slice(start, end);
}

test("沙盒必须使用白名单挂载，不得出现「整根挂载 + 遮蔽」的黑名单写法", () => {
  const block = sandboxBlock();
  // 黑名单特征：把 / 整个只读挂进来
  assert.doesNotMatch(
    block,
    /"--ro-bind",\s*"\/",\s*"\/"/,
    "不得再整根挂载 / —— 那是黑名单模式，必然漏掉敏感目录（曾漏 sessions/logs/browser-profile）"
  );
});

test("沙盒必须挂载 /usr 与标准软链（否则 node/bash 起不来）", () => {
  const block = sandboxBlock();
  assert.match(block, /"--ro-bind",\s*"\/usr",\s*"\/usr"/, "必须挂 /usr");
  for (const [target, link] of [["usr/bin", "/bin"], ["usr/lib", "/lib"]]) {
    assert.match(
      block,
      new RegExp(`"--symlink",\\s*"${target.replace("/", "\\/")}",\\s*"${link}"`),
      `必须补 ${link} → ${target} 软链，否则动态链接器找不到`
    );
  }
});

test("沙盒不得挂载整个 /etc（里面有密钥文件）", () => {
  const block = sandboxBlock();
  assert.doesNotMatch(block, /"--ro-bind",\s*"\/etc",\s*"\/etc"/, "不得整挂 /etc：profile.d/cred.sh 等含密钥");
  // 只允许挂这几个单文件/目录
  const allowed = /^\/etc\/(resolv\.conf|hosts|nsswitch\.conf|passwd|group|ssl|localtime|terminfo)$/;
  for (const m of block.matchAll(/"--ro-bind",\s*"(\/etc\/[^"]+)"/g)) {
    assert.match(m[1], allowed, `不允许挂载 ${m[1]}（不在白名单内）`);
  }
});

test("沙盒不得挂载任何隐私目录（会话/日志/状态/浏览器 profile/记忆库/项目根）", () => {
  const block = sandboxBlock();
  const forbidden = [
    "<PI2X_ROOT>/sessions",
    "<PI2X_ROOT>/logs",
    "<PI2X_ROOT>/state",
    "<PI2X_ROOT>/browser-profile",
    "<PI2X_ROOT>/workspace",
    "<PI2X_ROOT>/agent-dir",
    "<PI2X_ROOT>/tmp",
    "/root",
  ];
  for (const p of forbidden) {
    assert.doesNotMatch(
      block,
      new RegExp(`"--(?:ro-)?bind",\\s*"${p.replace(/\//g, "\\/")}"`),
      `不得挂载 ${p}`
    );
  }
});

test("沙盒必须挂载自己的沙盒目录与 shared（唯一可写处）", () => {
  const block = sandboxBlock();
  assert.match(block, /"--bind",\s*sandbox,\s*sandbox/, "自己的沙盒必须可写");
  assert.match(block, /"--bind",\s*shared,\s*shared/, "shared 必须可写（协作目录）");
});

test("沙盒 bash 会注入沙盒目录环境变量（供截图等产物选落点）", () => {
  const src = fs.readFileSync(SANDBOX_SRC, "utf8");
  assert.match(src, /PI2X_SANDBOX_DIR=/, "应注入 PI2X_SANDBOX_DIR");
  assert.match(src, /PI2X_SHARED_DIR=/, "应注入 PI2X_SHARED_DIR");
});

test("截图默认落点会尊重沙盒目录（否则沙盒内写不进去）", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "browser-lib.mjs"), "utf8");
  assert.match(src, /PI2X_SANDBOX_DIR/, "browser-lib 应识别 PI2X_SANDBOX_DIR");
});

// ── 提权后门的机械约束 ────────────────────────────────────────────────────

test("不得存在 allowOpEscalation 这类「跳过安全检查」的开关", () => {
  const files = [
    path.join(ROOT, "config.json"),
    path.join(ROOT, "lib", "config.mjs"),
    path.join(ROOT, "scripts", "qq-cli.mjs"),
    path.join(ROOT, "lib", "piagent.mjs"),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    // 允许在注释里提到（记录历史教训），但不允许出现在可执行代码/配置里
    const executable = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.doesNotMatch(
      executable,
      /allowOpEscalation/,
      `${path.relative(ROOT, f)} 里仍有 allowOpEscalation —— 它能整个跳过等级校验，是提权后门`
    );
  }
});

test("/op 与 qq-cli 的权限校验必须共用同一实现（防两侧漂移出缺口）", () => {
  const piagent = fs.readFileSync(path.join(ROOT, "lib", "piagent.mjs"), "utf8");
  const qqcli = fs.readFileSync(path.join(ROOT, "scripts", "qq-cli.mjs"), "utf8");
  for (const [name, src] of [["piagent", piagent], ["qq-cli", qqcli]]) {
    assert.match(src, /op-policy\.mjs/, `${name} 应引用 lib/op-policy.mjs`);
    assert.doesNotMatch(src, /PRESET_LEVEL\s*=\s*\{\s*dialog:/, `${name} 不得再自行定义 PRESET_LEVEL（会漂移）`);
  }
});

test("提权后门回归：qq-cli 在 operator 身份下无法自我提权（子进程实测）", () => {
  const wlFile = path.join(ROOT, "whitelist.json");
  const backup = fs.readFileSync(wlFile, "utf8");
  try {
    // 找一个 operator 用户（用临时白名单更稳妥，但这里只读不改文件更安全）：
    // 直接调用 qq-cli 的 op 动作，预期被拒（不依赖真实写盘 —— 被拒就不会写）
    const wl = JSON.parse(backup);
    const operatorId = Object.entries(wl.users ?? {}).find(([, v]) => v === "operator")?.[0];
    if (!operatorId) {
      // 没有 operator 用户时跳过（不影响其他断言）
      return;
    }
    let out = "";
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "qq-cli.mjs"), "--as", operatorId, "op", operatorId, "admin"], {
        encoding: "utf8",
        timeout: 30000,
      });
    } catch (e) {
      out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
    }
    assert.match(out, /拒绝|不能/, `operator 自我提权必须被拒，实际输出：${out.slice(-200)}`);
    assert.equal(fs.readFileSync(wlFile, "utf8"), backup, "被拒后白名单不得有任何改动");
  } finally {
    fs.writeFileSync(wlFile, backup, "utf8");
  }
});
