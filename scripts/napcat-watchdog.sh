#!/bin/bash
# NapCat 掉线自动重登守护 —— cron 每 5 分钟
# 逻辑：连续 3 次检测到 online!=true（约 15 分钟）才重启，避免误杀。
#   1) 重启 NapCat（screen napcat）并等待登录
#   2) 杀掉卡住的 bridge 重连循环，用 restart-pi2x.sh 重新拉起
#   3) 通知 admin
LOG=/var/log/pi2x-napcat-watchdog.log
STATE=<PI2X_ROOT>/.napcat-offline-count
ADMIN="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync("<PI2X_ROOT>/whitelist.json","utf8"));console.log(Object.entries(c.users||{}).find(([,v])=>v==="admin")?.[0]||"")}catch(e){}' 2>/dev/null)"
ROOT=<PI2X_ROOT>

cd "$ROOT" || exit 0
ST=$(timeout 25 node scripts/napcat-status.mjs 2>/dev/null | tail -1)
ONLINE=$(printf '%s' "$ST" | grep -o '"online":true' | head -1)

if [ -n "$ONLINE" ]; then
  echo 0 > "$STATE"
  exit 0
fi

N=$(cat "$STATE" 2>/dev/null || echo 0)
N=$((N + 1))
echo "$N" > "$STATE"
echo "[$(date '+%F %T')] 检测到不在线（第 $N/3 次）: $ST" >> "$LOG"
[ "$N" -lt 3 ] && exit 0

echo "[$(date '+%F %T')] 连续 3 次不在线，执行 NapCat 重登 + bridge 重启..." >> "$LOG"
# 1) 重启 NapCat（注意：[o] 括号技巧避免 pkill 匹配到本脚本自身）
screen -S napcat -X quit >/dev/null 2>&1
pkill -9 -f "[o]pt/QQ/qq" >/dev/null 2>&1
pkill -9 -f "[n]apcat_launcher" >/dev/null 2>&1
sleep 3
screen -wipe >/dev/null 2>&1
screen -dmS napcat bash /root/start-napcat.sh
# 2) 等登录（最多 150s）
OK=0
for i in $(seq 1 30); do
  sleep 5
  S=$(timeout 20 node scripts/napcat-status.mjs 2>/dev/null | tail -1)
  case "$S" in *'"online":true'*) OK=1; break;; esac
done
echo "[$(date '+%F %T')] 重登结果: online=$OK ($S)" >> "$LOG"
if [ "$OK" = "1" ]; then
  echo 0 > "$STATE"
  bash scripts/restart-pi2x.sh >> "$LOG" 2>&1 &
  sleep 45
  timeout 30 node scripts/send-notify.mjs "$ADMIN" "喵～NapCat 掉线了，我已自动重新登录上线（账号 PI2X），bridge 也重启完毕，可以继续聊天喵～" >> "$LOG" 2>&1
  echo "[$(date '+%F %T')] 已恢复并通知 admin" >> "$LOG"
else
  timeout 30 node scripts/send-notify.mjs "$ADMIN" "主人，NapCat 掉线了，自动重登失败（可能需要扫码/验证），请看一下喵～" >> "$LOG" 2>&1
  echo "[$(date '+%F %T')] 重登失败，已通知 admin" >> "$LOG"
fi
