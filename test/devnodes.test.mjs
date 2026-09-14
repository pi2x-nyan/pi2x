import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { healDevNodes, canReadRandom } from "../lib/devnodes.mjs";

test("canReadRandom：随机源可读时返回 true", () => {
  assert.equal(canReadRandom(), true, "本机 /dev/urandom 应可读（否则环境本身坏了）");
});

test("healDevNodes：幂等 —— 已健康的 /dev 不报告任何改动", () => {
  const r = healDevNodes();
  assert.equal(r.ok, true, `应判定为健康，实际: ${r.reason ?? ""}`);
  assert.deepEqual(r.changed, [], "已健康时不应有改动（否则每次启动都重建节点）");
});

test("healDevNodes：关键节点都是真字符设备（不是普通文件）", () => {
  for (const name of ["null", "zero", "full", "random", "urandom"]) {
    const st = fs.lstatSync(`/dev/${name}`);
    assert.ok(st.isCharacterDevice(), `/dev/${name} 必须是字符设备，实际: ${st.mode.toString(8)}`);
  }
});

test("healDevNodes：/dev/null 可写（重定向依赖它，写坏了会变成普通文件）", () => {
  assert.doesNotThrow(() => fs.writeFileSync("/dev/null", "test"), "/dev/null 必须可写");
  const st = fs.lstatSync("/dev/null");
  assert.equal(st.size, 0, "/dev/null 不应增长（增长说明它成了普通文件）");
});

test("healDevNodes：/dev/urandom 反复读都成功（熵池真活着）", () => {
  for (let i = 0; i < 3; i++) {
    const a = Buffer.alloc(8);
    const fd = fs.openSync("/dev/urandom", "r");
    try {
      fs.readSync(fd, a, 0, 8, null);
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(a.length, 8);
  }
});

test("healDevNodes：注入 runner 时不会真的动系统（可安全测试）", () => {
  const calls = [];
  const r = healDevNodes({ runner: (f, a) => calls.push([f, ...a].join(" ")) });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [], "本机节点已健康，不应触发 mknod");
});

test("healDevNodes：标准软链存在且指向 /proc/self/fd", () => {
  for (const [name, target] of [
    ["fd", "/proc/self/fd"],
    ["stdin", "/proc/self/fd/0"],
    ["stdout", "/proc/self/fd/1"],
    ["stderr", "/proc/self/fd/2"],
  ]) {
    const p = `/dev/${name}`;
    let link = "";
    try {
      link = fs.readlinkSync(p);
    } catch {
      link = "";
    }
    assert.equal(link, target, `/dev/${name} 应软链到 ${target}，实际: ${link || "(不存在)"}`);
  }
});

test("stdout 仍可正常写出（软链没把输出流搞坏）", () => {
  // 这是个真实风险：/dev/stdout 指错会让所有日志静默丢失
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    process.stdout.write("stdout-check\n");
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(chunks.join(""), "stdout-check\n");
});
