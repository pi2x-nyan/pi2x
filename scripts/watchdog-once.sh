#!/bin/bash
# PI2X watchdog — 每分钟由 crontab 调用；检测 NapCat/QQ 异常并恢复
#
# 【尽量不重启原则】NapCat 重启会触发登录风控/短信验证，必须节制：
#   1) 二次确认：检测异常后等待 20s 复检，瞬时抖动不触发
#   2) 重启节流：距上次重启 < 10 分钟则跳过（只记录日志）
#   3) 连续失败：(总失败次数 >= 3) 或 NEED_HUMAN 已置位 -> 只告警不重启
#
LOG=/var/log/pi2x-watchdog.log
NAPCAT="screen -dmS napcat bash /root/start-napcat.sh"
FLAG=/tmp/pi2x-need-human
TS_FILE=/tmp/pi2x-napcat-restart-ts
MIN_INTERVAL=600          # 两次重启最小间隔（秒）
MAX_CONSECUTIVE=3

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

restart_napcat() {
  log "!! 重启 NapCat（节流内允许）"
  screen -S napcat -X quit 2>/dev/null
  pkill -9 -x qq 2>/dev/null
  sleep 3
  screen -wipe >/dev/null 2>&1
  $NAPCAT
  date +%s > "$TS_FILE"
  echo 0 > /tmp/pi2x-consecutive-fail
}

# --- 节流闸门 ---
if [ -f "$TS_FILE" ]; then
  last=$(cat "$TS_FILE")
  now=$(date +%s)
  if [ $((now - last)) -lt $MIN_INTERVAL ]; then
    log "问题检测但距上次重启仅 $((now-last))s，跳过（节流 $((MIN_INTERVAL/60)) 分钟）"
    exit 0
  fi
fi

# --- 连续失败计数 ---
CONSEC=$(cat /tmp/pi2x-consecutive-fail 2>/dev/null || echo 0)
if [ "$CONSEC" -ge "$MAX_CONSECUTIVE" ]; then
  log "连续失败 $CONSEC 次，停止自动重启（避免风控），需人工处置"
  touch "$FLAG"
  exit 0
fi

check_ok() {
  ss -tln 2>/dev/null | grep -q ':3001' || return 1
  node <PI2X_ROOT>/scripts/check-login.mjs >/dev/null 2>&1 || return 1
  return 0
}

# --- 1) 首次检测（不满足 -> 二次确认） ---
if check_ok; then
  rm -f "$FLAG"
  echo 0 > /tmp/pi2x-consecutive-fail
  exit 0
fi

log "异常：3001/登录态未就绪，等待 20s 二次确认..."
sleep 20

if check_ok; then
  echo 0 > /tmp/pi2x-consecutive-fail
  exit 0
fi

CONSEC=$((CONSEC + 1))
echo "$CONSEC" > /tmp/pi2x-consecutive-fail
log "二次确认仍异常（连续 $CONSEC 次）-> 重启 NapCat"
restart_napcat

# 等就绪（最多 90s）
for i in $(seq 1 18); do
  sleep 5
  check_ok && { log "重启后恢复 OK"; rm -f "$FLAG"; exit 0; }
done
log "重启后仍未恢复，需人工验证！"
touch "$FLAG"
exit 0