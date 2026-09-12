import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCAN = path.join(ROOT, "scripts", "scan-secrets.mjs");

/**
 * 构造「看起来像密钥」的字符串时一律运行时拼接。
 * 若直接写成字面量，本测试文件自己就会被扫描器命中 ——
 * 要么误报，要么不得不在白名单里开一个口子，两者都不可接受。
 */
const S = {
  wsToken: "FAKEWSTOKEN" + "00000000",        // 纯合成，形似 OneBot token（不含任何真实片段）
  ghToken: "ghp_" + "A".repeat(36),           // 形似 GitHub PAT（ghp_ 是固定前缀，非真实值）
  ccKey: "user_" + "B".repeat(50),            // 形似账号池密钥（user_ 是固定前缀，非真实值）
  omniKey: "or_" + "c".repeat(40),            // 形似网关 key（or_ 是固定前缀，非真实值）
  hostname: "LAPTOP-" + "FAKE01",             // 形似主机名
  jsonToken: (v) => '{"token": "' + v + '"}\n',
};

/** 在一个临时目录里放若干文件，跑扫描器，返回输出 */
function scanFiles(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  const r = spawnSync(process.execPath, [SCAN], {
    encoding: "utf8",
    env: { ...process.env, PI2X_SCAN_ROOT: dir, FORCE_COLOR: "0" },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

test("扫描器能捕获各类密钥", () => {
  const out = scanFiles({
    "a.mjs": 'const k = process.env.X || "' + S.wsToken + '";\n',
    "b.json": S.jsonToken("abcdefgh12345678"),
    "c.mjs": 'const key = "' + S.ghToken + '";\n',
    "d.json": '{"accounts":[{"key":"' + S.ccKey + '"}]}\n',
  });
  assert.match(out, /高危 [1-9]/, "应报出高危");
  assert.match(out, /token-default-literal|OneBot|GitHub|账号池/, "应命中密钥规则");
});

test("扫描器不误报常规代码（超时值、短字符串、假号）", () => {
  const out = scanFiles({
    "a.mjs": "const t = process.env.T || 180000;\nconst name = 'PI2X';\nconst id = '1000000001';\n",
    "b.json": '{"submitTimeoutMs": 600000, "compactWaitMs": 120000}\n',
  });
  assert.match(out, /高危\s+0/, `不该报高危，实际输出：\n${out}`);
});

test("扫描器能识别内网 IP 与主机名", () => {
  const out = scanFiles({ "doc.md": "服务在 " + "10.208" + "." + "1.2" + "，主机 " + S.hostname + "\n" });
  assert.match(out, /中危 [1-9]/, "应报中危");
});

test("当前仓库扫描结果为全零（推公开仓库的前置条件）", () => {
  const out = execFileSync(process.execPath, [SCAN], { encoding: "utf8", cwd: ROOT, env: { ...process.env, FORCE_COLOR: "0" } });
  assert.match(out, /高危\s+0/, `仓库里有高危项，不可推送：\n${out}`);
  assert.match(out, /中危\s+0/, `仓库里有中危项：\n${out}`);
});

test("扫描器会把历史提交一起算上（能从历史里发现泄露）", () => {
  // 造一个带敏感内容的小仓库，确认 --history 能扫出历史版本
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanhist-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    g(["init", "-q"]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(dir, "x.json"), S.jsonToken("abcdefgh12345678"), "utf8");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "leak"]);
    fs.writeFileSync(path.join(dir, "x.json"), S.jsonToken(""), "utf8");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "fix"]);

    const noHist = spawnSync(process.execPath, [SCAN], { encoding: "utf8", env: { ...process.env, PI2X_SCAN_ROOT: dir, FORCE_COLOR: "0" } });
    const withHist = spawnSync(process.execPath, [SCAN, "--history"], { encoding: "utf8", env: { ...process.env, PI2X_SCAN_ROOT: dir, FORCE_COLOR: "0" } });
    assert.match(`${noHist.stdout}`, /高危\s+0/, "工作区已修好，应无高危");
    assert.match(`${withHist.stdout}`, /存在于历史提交/, "历史扫描应指出历史里仍有泄露");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
