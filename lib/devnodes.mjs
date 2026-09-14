/**
 * /dev 设备节点自愈 —— chroot 环境必备
 *
 * 【为什么需要】
 * 本机跑在 Android chroot 里（无 systemd）。真实 rootfs 的 /dev 由 devtmpfs 提供，
 * 而 chroot 的 /dev 只是 f2fs 上的一个**普通空目录**。一旦它被清空：
 *   · `/dev/urandom` 消失 → git 提交报 `unable to get random bytes for temporary file`；
 *     Node/OpenSSL 取不到熵；某些库直接崩。
 *   · `/dev/null` 消失 → 无数 `> /dev/null` 静默写成普通文件，磁盘悄悄膨胀。
 *
 * 2026-09-14 实际踩到：/dev 被清空后 git add/commit 全失败，而且一个测试
 * （scan-secrets 里要跑 `git add -A`）长期红灯 —— 报错信息完全指不到根因。
 *
 * 【做法】
 *  1. 重建必要字符设备节点（mknod）+ 标准软链；
 *  2. **校验随机源真的可读** —— 只建节点不算成功：在 f2fs 上 mknod 出的节点
 *     看起来正常，读的时候却 EACCES。这一点是本模块存在的关键理由。
 *
 * 注：Node 的 fs 没有 mknod（只在 fs.constants 里给 S_IFCHR），所以走 shell 命令。
 * 全程尽力而为：任何一步失败都不抛异常（启动流程优先），只用返回值报告。
 * 幂等：已正常的节点不重建。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/** 需要存在的字符设备：name → [major, minor, mode] */
const CHARS = Object.freeze({
  null: [1, 3, 0o666],
  zero: [1, 5, 0o666],
  full: [1, 7, 0o666],
  random: [1, 8, 0o666],
  urandom: [1, 9, 0o666],
  tty: [5, 0, 0o666],
});

/** 标准软链：link → target */
const LINKS = Object.freeze({
  fd: "/proc/self/fd",
  stdin: "/proc/self/fd/0",
  stdout: "/proc/self/fd/1",
  stderr: "/proc/self/fd/2",
});

/** 随机源是否真的能读到字节（唯一可信的健康判据） */
export function canReadRandom() {
  try {
    const buf = Buffer.alloc(4);
    const fd = fs.openSync("/dev/urandom", "r");
    try {
      fs.readSync(fd, buf, 0, 4, null);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 修复 /dev（幂等、尽力而为）。
 * @param {{runner?: (file:string, args:string[]) => unknown}} [opts] 便于测试注入
 * @returns {{ok:boolean, changed:string[], reason?:string}}
 */
export function healDevNodes({ runner } = {}) {
  const changed = [];
  const run = runner ?? ((file, args) => execFileSync(file, args, { stdio: "ignore" }));

  // 1) 重建字符设备节点（已存在且仍是字符设备则跳过）
  for (const [name, [major, minor, mode]] of Object.entries(CHARS)) {
    const p = `/dev/${name}`;
    let st = null;
    try {
      st = fs.lstatSync(p);
    } catch {
      st = null;
    }
    if (st && st.isCharacterDevice()) continue;
    try {
      if (st) fs.unlinkSync(p);
      run("mknod", [p, "c", String(major), String(minor)]);
      fs.chmodSync(p, mode);
      changed.push(name);
    } catch {
      /* 交给第 3 步的健康校验统一判定 */
    }
  }

  // 2) 标准软链
  for (const [name, target] of Object.entries(LINKS)) {
    const p = `/dev/${name}`;
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() && fs.readlinkSync(p) === target) continue;
      fs.unlinkSync(p);
    } catch {
      /* 不存在则直接建 */
    }
    try {
      fs.symlinkSync(target, p);
      changed.push(name);
    } catch {
      /* 尽力而为 */
    }
  }

  // 2.5) 目录
  for (const d of ["/dev/shm", "/dev/pts"]) {
    try {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
        changed.push(d);
      }
    } catch {
      /* 尽力而为 */
    }
  }

  // 3) 健康校验：随机源必须真能读
  if (!canReadRandom()) {
    return {
      ok: false,
      changed,
      reason:
        "/dev/urandom 不可读（节点可能存在但设备层拒绝；chroot 下 mknod 在 f2fs 上无效，需把 tmpfs 挂到 /dev，见 scripts/devnodes-selfheal.sh）",
    };
  }
  // 顺带确认 /dev/null 是真字符设备（否则重定向会写坏文件）
  try {
    if (!fs.lstatSync("/dev/null").isCharacterDevice()) {
      return { ok: false, changed, reason: "/dev/null 不是字符设备" };
    }
  } catch {
    return { ok: false, changed, reason: "/dev/null 不存在" };
  }

  return { ok: true, changed };
}

export default healDevNodes;
