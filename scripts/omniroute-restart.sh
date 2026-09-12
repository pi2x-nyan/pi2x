#!/bin/bash
# OmniRoute 重启脚本（含内存回收）—— 改 .env 后调用生效
# 说明：OmniRoute 无 systemd/cron 管理，原启动方式为 setsid nohup。
set -u
ENV_FILE=/root/.omniroute/.env
LOG=/opt/omniroute-logs/server.log
PORT=20128

echo "[omniroute-restart] 停止旧实例…"
# 只杀 omniroute 相关（[o] 括号写法避免匹配本脚本）
pkill -TERM -f "[o]mniroute serve" 2>/dev/null
pkill -TERM -f "omniroute \(v" 2>/dev/null
for i in $(seq 1 20); do
  pgrep -f "[o]mniroute serve" >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -f "[o]mniroute serve" >/dev/null 2>&1; then
  echo "[omniroute-restart] 优雅退出超时，强制终止"
  pkill -9 -f "[o]mniroute serve" 2>/dev/null
  pkill -9 -f "omniroute \(v" 2>/dev/null
  sleep 2
fi

echo "[omniroute-restart] 启动新实例（加载 $ENV_FILE）…"
cd /usr/local/lib/node_modules/omniroute || exit 1
setsid nohup /usr/local/bin/omniroute serve --no-open >> "$LOG" 2>&1 < /dev/null &

# 等待就绪（最长 120s）
for i in $(seq 1 60); do
  sleep 2
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/models" 2>/dev/null)
  if [ "$code" != "000" ] && [ -n "$code" ]; then
    echo "[omniroute-restart] 已就绪（HTTP $code，用时 $((i*2))s）"
    pgrep -af "[o]mniroute serve" | head -2 | cut -c1-110
    exit 0
  fi
done
echo "[omniroute-restart] 启动超时，请查 $LOG"
exit 1
