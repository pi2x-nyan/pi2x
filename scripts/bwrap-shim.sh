#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# bwrap 兼容垫片
#
# 【为什么需要它】
# 本机是跑在安卓手机上的 Ubuntu（内核 5.10.136-android12，PID 1 是 Android init），
# 根文件系统是只读的 erofs 镜像（/dev/block/dm-10）。这类「真实块设备」挂载点
# **改不了挂载传播属性** —— 对 / 做 make-slave / make-private / make-shared
# 一律返回 EINVAL（实测：对 / 和 /tmp 全失败，对 /dev、/proc 全部成功）。
#
# 而 bubblewrap 启动时必做一步 `mount --make-slave /`（隔离挂载传播，防止沙盒内外
# 互相污染）。它一碰 / 就死，进程连一个子进程都没起就退出，表现为：
#     bwrap: Failed to make / slave: Invalid argument
# 于是所有走 bwrap 的沙盒 bash 全灭。
#
# 【怎么绕】
# 换个可改传播的挂载点当新根：先建私有 mount ns，把真实的 / 递归 bind 到临时目录，
# 在**这个 bind 挂载点**上做 rslave（bind 出来的挂载点允许改，实测通过），
# 再 chroot 进去执行 bwrap。此时 bwrap 眼里的 / 就是那个可改的挂载点，make-slave 通过。
#
# 【安全性没有被削弱】bwrap 仍按原参数自建全新根树，不继承本垫片 rbinit 出来的内容 ——
# 实测沙盒内 <PI2X_ROOT> 只有显式 --ro-bind 的那几项，sessions/logs/state 依然不可见。
# 垫片只影响「bwrap 自己在哪个挂载点上做传播属性设置」，不改变它给沙盒建的根。
#
# 【何时可以不经过它】原生 Linux（根挂载点传播属性可改）上探测会走原生 bwrap，
# 本脚本只作回退；两边产物路径与参数完全一致。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# 自举：先把自己放进私有 mount ns（unshare -m 可用；显式 --propagation unchanged，
# 否则 unshare 自己也会去改 / 的传播属性、同样 EINVAL）
if [ "${PI2X_BWRAP_SHIM_NS:-}" != "1" ]; then
  export PI2X_BWRAP_SHIM_NS=1
  exec unshare -m --propagation unchanged bash "$0" "$@"
fi

TMPROOT="$(mktemp -d /tmp/.pi2x-bwrap-root.XXXXXX)" || {
  echo "bwrap-shim: 无法创建临时挂载点" >&2
  exit 1
}

cleanup() {
  for _ in 1 2 3 4; do umount -R "$TMPROOT" 2>/dev/null || break; done
  umount -l "$TMPROOT" 2>/dev/null
  rmdir "$TMPROOT" 2>/dev/null
}
trap cleanup EXIT INT TERM

mount --rbind / "$TMPROOT" 2>/dev/null || {
  echo "bwrap-shim: 无法 bind 根到 $TMPROOT" >&2
  exit 1
}
mount --make-rslave "$TMPROOT" 2>/dev/null || {
  echo "bwrap-shim: 无法把 $TMPROOT 设为 rslave" >&2
  exit 1
}

# 不用 exec：要留在这一层好让 EXIT trap 把临时挂载拆干净
/usr/sbin/chroot "$TMPROOT" /usr/bin/bwrap "$@"
rc=$?
exit $rc
