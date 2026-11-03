/**
 * 路径包含校验的回归测试
 *
 * 背景：非 admin 的文件工具原先只做字符串前缀判断（path.resolve），
 * 沙盒里放一个软链接就能读到提示词/配置/别人的会话。这里锁住行为。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containedPath, isSymlink } from "../lib/safe-path.mjs";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi2x-${tag}-`));
}

test("沙盒内的普通文件：允许", () => {
  const sb = tmpDir("ok");
  const f = path.join(sb, "a.txt");
  fs.writeFileSync(f, "hi");
  assert.equal(containedPath(f, [sb]), fs.realpathSync(f));
});

test("软链接指向沙盒外：拒绝", () => {
  const sb = tmpDir("link");
  const outside = path.join(tmpDir("out"), "secret.txt");
  fs.writeFileSync(outside, "secret");
  const link = path.join(sb, "evil");
  fs.symlinkSync(outside, link);
  assert.equal(containedPath(link, [sb]), null);
});

test("父目录软链接指向沙盒外：拒绝", () => {
  const sb = tmpDir("linkdir");
  const outsideDir = tmpDir("outdir");
  fs.symlinkSync(outsideDir, path.join(sb, "up"));
  assert.equal(containedPath(path.join(sb, "up", "new.txt"), [sb]), null);
});

test(".. 跳出沙盒：拒绝", () => {
  const sb = tmpDir("dotdot");
  assert.equal(containedPath(path.join(sb, "..", "x"), [sb]), null);
});

test("绝对路径指向别处：拒绝", () => {
  const sb = tmpDir("abs");
  assert.equal(containedPath("/etc/passwd", [sb]), null);
});

test("沙盒内尚不存在的文件（准备新建）：允许", () => {
  const sb = tmpDir("new");
  const p = path.join(sb, "sub", "deep", "n.txt");
  const r = containedPath(p, [sb]);
  assert.ok(r && r.startsWith(fs.realpathSync(sb)));
});

test("多个根目录：命中任意一个即可", () => {
  const a = tmpDir("m1");
  const b = tmpDir("m2");
  const f = path.join(b, "x.txt");
  fs.writeFileSync(f, "1");
  assert.equal(containedPath(f, [a, b]), fs.realpathSync(f));
});

test("isSymlink: 能识别软链接，普通文件返回 false", () => {
  const sb = tmpDir("sym");
  const f = path.join(sb, "real.txt");
  fs.writeFileSync(f, "x");
  const l = path.join(sb, "l");
  fs.symlinkSync(f, l);
  assert.equal(isSymlink(l), true);
  assert.equal(isSymlink(f), false);
  assert.equal(isSymlink(path.join(sb, "nope")), false);
});
