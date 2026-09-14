#!/bin/bash
# /dev 设备节点自愈 —— chroot 环境必备
#
# 【背景】本机是 Android chroot（无 systemd）。chroot 的 /dev 只是 f2fs 上的**空目录**，
# 不像真实 rootfs 那样有 devtmpfs。后果：
#   · /dev/urandom 缺失 → git 提交报 "unable to get random bytes for temporary file"
#     （git 建临时文件要随机字节）；Node/OpenSSL 也会取不到熵
#   · /dev/null 缺失 → 大量重定向静默写坏文件
# 2026-09-14 实测：/dev 被清空后 git add/commit 全失败，且一个测试长期因此红灯。
#
# 【做法】把 tmpfs 挂到 /dev（与真实 rootfs 一致），再重建必要节点。幂等。
set -u

if mountpoint -q /dev 2>/dev/null; then
  : # 已挂载
else
  mount -t tmpfs -o mode=755,size=8M tmpfs /dev 2>/dev/null || true
fi

mkdir -p /dev/shm /dev/pts 2>/dev/null

mk() { # mk <name> <major> <minor> <mode>
  local n="$1" M="$2" m="$3" mode="$4"
  [ -e "/dev/$n" ] && [ -c "/dev/$n" ] && return 0
  rm -f "/dev/$n" 2>/dev/null
  mknod "/dev/$n" c "$M" "$m" 2>/dev/null && chmod "$mode" "/dev/$n" 2>/dev/null
}

mk null    1 3 666
mk zero    1 5 666
mk full    1 7 666
mk random  1 8 666
mk urandom 1 9 666
mk tty     5 0 666

# 标准软链（很多脚本依赖 /dev/stdout、/dev/fd）
[ -e /dev/fd ]     || ln -sf /proc/self/fd   /dev/fd     2>/dev/null
[ -e /dev/stdin ]  || ln -sf /proc/self/fd/0 /dev/stdin  2>/dev/null
[ -e /dev/stdout ] || ln -sf /proc/self/fd/1 /dev/stdout 2>/dev/null
[ -e /dev/stderr ] || ln -sf /proc/self/fd/2 /dev/stderr 2>/dev/null

# 校验：随机源必须真的能读（建了节点但读不了也算失败）
if head -c 8 /dev/urandom >/dev/null 2>&1; then
  echo "[/dev] OK · urandom 可读"
  exit 0
else
  echo "[/dev] ⚠ urandom 不可读（节点存在但设备层拒绝）" >&2
  exit 1
fi
