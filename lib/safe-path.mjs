/**
 * 路径包含校验（防符号链接逃逸）
 *
 * 为什么不能只用 path.resolve 前缀判断：
 *   sandbox/link -> <PI2X_ROOT>/prompt/agent/system.md 这样的软链接，
 *   path.resolve 只做字符串规范化，认为它在沙盒里；而 fs.readFileSync 会跟随软链接，
 *   于是非 admin 用户能读到提示词、配置、别人的会话。这是实打实的越权读。
 *
 * 做法：先 realpath（跟随软链接）得到真实路径，再做前缀判断；
 *   目标不存在（准备新建）时解析父目录，避免「写新文件」被误拒。
 *   返回真实路径（调用方必须用它做 IO，否则校验与读写不同源，等于没校验）。
 */
import fs from "node:fs";
import path from "node:path";

/** 解析真实路径（允许末段不存在，如准备新建的文件）；失败返回 null */
function realOrNull(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const r = fs.realpathSync(cur);
      return tail.length ? path.join(r, ...tail.reverse()) : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;   // 到根都没有可解析的祖先
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * @param {string} p        用户给的路径
 * @param {string[]} bases  允许的根目录
 * @returns {string|null}   真实路径（在允许范围内）或 null（越界/无法解析）
 */
export function containedPath(p, bases) {
  const abs = path.resolve(String(p ?? ""));
  const real = realOrNull(abs);
  if (!real) return null;
  for (const b of bases) {
    const rb = realOrNull(path.resolve(String(b)));
    if (!rb) continue;
    if (real === rb || real.startsWith(rb + path.sep)) return real;
  }
  return null;
}

/** 目标本身是否是符号链接（写文件时用来拒绝「借链接写到别处」） */
export function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
