#!/bin/bash
# 抢血通报守护 —— cron 每分钟；进程不在就拉起
# 注意：pgrep 用 [c] 括号写法避免匹配本脚本自身
PATTERN="[c]tf-blood.mjs"
LOG=/var/log/pi2x-ctfblood.log

if pgrep -f "$PATTERN" >/dev/null 2>&1; then
  exit 0
fi

echo "[$(date '+%F %T')] ctf-blood 不在，拉起..." >> "$LOG"
bash <PI2X_ROOT>/scripts/ctf-blood-start.sh >> "$LOG" 2>&1
