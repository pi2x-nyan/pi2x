#!/bin/bash
# bridge 进程守护 —— 每分钟由 crontab 调用；bridge 不在则拉起（NapCat 不动）

# 运行期目录（private/ 优先）
PI2X_ROOT="${PI2X_ROOT:-<PI2X_ROOT>}"
# shellcheck source=/dev/null
source "$PI2X_ROOT/scripts/private-paths.sh" 2>/dev/null || P_LOGS_DIR="$PI2X_ROOT/logs"
LOG=/var/log/pi2x-bridge-watchdog.log
pid=$(pgrep -f "bridge[.]mjs" | head -1)
if [ -n "$pid" ]; then exit 0; fi
echo "[$(date "+%F %T")] bridge 不在，拉起..." >> "$LOG"
cd <PI2X_ROOT> && export PATH=/usr/local/bin:/usr/bin:/bin
source /etc/profile.d/deepseek.sh 2>/dev/null
source /etc/profile.d/cred.sh 2>/dev/null
nohup node bridge.mjs >> "$P_LOGS_DIR"/bridge.log 2>&1 &
disown 2>/dev/null
echo "[$(date "+%F %T")] 已拉起 pid $(pgrep -f "bridge[.]mjs" | head -1)" >> "$LOG"
