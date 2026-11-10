#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# dialog 共享沙盒的硬容量闸
#
# 【为什么需要】
# 目录总量原先只在 write / bash 入口量一次，属于「事后看着办」：
# 一条命令里 dd 一下就能写穿 200MB，量的时候才发现已经超了。
# 做成 tmpfs 挂上去之后，写满由内核直接回 ENOSPC —— 这才是硬杠杠。
#
# 代价：数据在内存里，机器重启就没了；上限吃掉的也是内存。
# 共享沙盒本来就是访客的临时周转区，这个代价可接受。
#
# 用法：dialog-sandbox-mount.sh <目录> [MB]
#    已挂载则什么都不做（并打印现状）；挂载成功后打印挂载信息。
# ─────────────────────────────────────────────────────────────────────────────
set -u

DIR="${1:?需要目录}"
MB="${2:-200}"
BACKUP="<PI2X_ROOT>/tmp/dialog-shared-backup"

mkdir -p "$DIR"

# 已经是独立挂载点 → 就绪
if mountpoint -q "$DIR" 2>/dev/null; then
  df -h "$DIR" | tail -1
  exit 0
fi

# 挂载前把已有内容挪出去（tmpfs 会遮蔽原目录）
HAD=""
if [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  mkdir -p "$BACKUP"
  rm -rf "$BACKUP"/* 2>/dev/null
  cp -a "$DIR"/. "$BACKUP"/ 2>/dev/null && HAD=1
fi

if ! mount -t tmpfs -o "size=${MB}M,mode=0777,nosuid,nodev" tmpfs "$DIR" 2>/dev/null; then
  echo "挂载失败，回退普通目录" >&2
  exit 1
fi
chmod 0777 "$DIR" 2>/dev/null

# 把原内容搬回去（总量本来就该在限额内，超了会被内核截住）
if [ -n "$HAD" ]; then
  cp -a "$BACKUP"/. "$DIR"/ 2>/dev/null
  rm -rf "$BACKUP"/* 2>/dev/null
fi

df -h "$DIR" | tail -1
