#!/bin/bash
# 启动 SUSCTF 抢血通报（screen 常驻；watchdog 也调用本脚本）
# 注：pkill/pgrep 用 [c] 括号写法，避免匹配到本脚本自身
PATTERN="[c]tf-blood.mjs"
cd <PI2X_ROOT> || exit 1

if pgrep -f "$PATTERN" >/dev/null 2>&1; then
  echo "ctf-blood 已在运行: $(pgrep -f "$PATTERN" | head -1)"
  exit 0
fi

mkdir -p private/logs
screen -wipe >/dev/null 2>&1
screen -dmS ctfblood bash -c 'cd <PI2X_ROOT> && exec node scripts/ctf-blood.mjs >> private/logs/ctf-blood-stdout.log 2>&1'
sleep 3
echo "ctf-blood pid: $(pgrep -f "$PATTERN" | head -1)"
