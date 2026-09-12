#!/bin/bash
# PI2X 全量启动（开机/重启后调用；幂等，可重复执行）
# 顺序：ffmpeg/Xvfb+NapCat → cc-go 代理 → OmniRoute → bridge
# 说明：OmniRoute 无 systemd，必须显式启动（原先只手工 setsid，重启后会漏）
set -u

LOG=/var/log/pi2x-startall.log
say() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

# 0) 清理僵尸 screen
screen -wipe >/dev/null 2>&1

# 0.5) cron 守护进程（所有定时任务的前提：watchdog/提醒）
# 坑：本机是 chroot/Android 环境，无 systemd，cron 不会自启；不显式拉起则 crontab 全部静默失效
if pgrep -x cron >/dev/null 2>&1; then
  say "cron 已在运行"
else
  say "启动 cron..."
  /usr/sbin/cron
  sleep 2
  say "cron pid: $(pgrep -x cron | head -1)"
fi

# 1) NapCat（QQ）
if pgrep -f "[o]pt/QQ/qq" >/dev/null 2>&1; then
  say "NapCat 已在运行"
else
  say "启动 NapCat..."
  screen -dmS napcat bash /root/start-napcat.sh
  for i in $(seq 1 30); do sleep 5; pgrep -f "[o]pt/QQ/qq" >/dev/null 2>&1 && break; done
  say "NapCat qq 进程: $(pgrep -cf '[o]pt/QQ/qq' 2>/dev/null || echo 0)"
fi

# 2) cc-go 适配代理（:20228）
if curl -s -m 5 -o /dev/null http://127.0.0.1:20228/v1/models 2>/dev/null; then
  say "cc-go 代理已就绪"
else
  say "启动 cc-go 代理..."
  bash <PI2X_ROOT>/scripts/cc-go-start.sh >> "$LOG" 2>&1
fi

# 3) OmniRoute（:20128）—— 关键：原先无任何自启入口
if curl -s -m 5 -o /dev/null http://127.0.0.1:20128/v1/models 2>/dev/null; then
  say "OmniRoute 已就绪"
else
  say "启动 OmniRoute..."
  bash <PI2X_ROOT>/scripts/omniroute-restart.sh >> "$LOG" 2>&1
fi

# 4) bridge（pi agent）
if pgrep -f "[b]ridge.mjs" >/dev/null 2>&1; then
  say "bridge 已在运行"
else
  say "启动 bridge..."
  bash <PI2X_ROOT>/scripts/restart-pi2x.sh >> "$LOG" 2>&1 &
fi

say "start-all 完成：NapCat=$(pgrep -cf '[o]pt/QQ/qq' 2>/dev/null || echo 0) ccgo=$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:20228/v1/models 2>/dev/null) omni=$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:20128/v1/models 2>/dev/null) bridge=$(pgrep -f '[b]ridge.mjs' | head -1)"
