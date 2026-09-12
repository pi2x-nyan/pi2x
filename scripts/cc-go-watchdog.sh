#!/bin/bash
# commandcode 代理守护 —— cron 每分钟；屏幕会话/服务不在则拉起
LOG=/var/log/pi2x-ccgo.log
if screen -ls 2>/dev/null | grep -q "ccgo" && curl -s -m 8 -o /dev/null http://127.0.0.1:20228/v1/models; then exit 0; fi
echo "[$(date "+%F %T")] cc-go 不在/不可用，拉起..." >> "$LOG"
bash /opt/pi2x/scripts/cc-go-start.sh >> "$LOG" 2>&1
