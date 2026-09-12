#!/bin/bash
# 启动 commandcode Go 适配代理（screen 常驻；watchdog 也调用本脚本）
# 重启策略：先 SIGTERM 让代理优雅收尾（等在途流式请求结束），避免打断下游请求造成 502。
# 注：pkill 用 [c] 括号写法，避免匹配到本脚本自身命令行。
PATTERN="[c]ommandcode-proxy"

if pgrep -f "$PATTERN" >/dev/null 2>&1; then
  echo "旧代理在运行，发送 SIGTERM 优雅退出…"
  pkill -TERM -f "$PATTERN" 2>/dev/null
  for i in $(seq 1 25); do
    pgrep -f "$PATTERN" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "$PATTERN" >/dev/null 2>&1; then
    echo "优雅退出超时(25s)，强制终止"
    pkill -9 -f "$PATTERN" 2>/dev/null
    sleep 1
  else
    echo "已优雅退出"
  fi
fi

screen -wipe >/dev/null 2>&1
screen -dmS ccgo bash -c 'source /etc/profile.d/cred.sh 2>/dev/null; cd <PI2X_ROOT> && exec node scripts/commandcode-proxy.mjs >> logs/cc-go-proxy.log 2>&1'
sleep 3
echo "ccgo pid: $(pgrep -f "$PATTERN" | head -1)"
echo "curl: $(curl -s -m 12 -o /dev/null -w '%{http_code}' http://127.0.0.1:20228/v1/models)"
