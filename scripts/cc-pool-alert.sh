#!/bin/bash
# Command Code 号池告警 —— cron 每 5 分钟
#
# 背景：三个 Go 账号余额见底（只剩 $0.1~$0.9）后，每个请求都会白试一遍再切到
#       还有额度的账号；若四个账号全不可用，bot 只会回一句通用错误，没人知道是「需要充值」。
# 本脚本读代理写的状态文件，做到：
#   · 全池不可用 → 私聊通知管理员（**每小时最多一次**，不刷屏）
#   · 从不可用恢复 → 通知一次「已恢复」
#
# 状态文件由 scripts/commandcode-proxy.mjs 的 writePoolState() 写入：
#   private/state/cc-pool-state.json  {"ok":bool,"reason":"...","at":"ISO"}
set -u
cd <PI2X_ROOT> || exit 0
STATE=private/state/cc-pool-state.json
MARK=private/state/cc-pool-alert.json
LOG=/var/log/pi2x-pool-alert.log
ADMIN=3573297011
COOLDOWN_SEC=$((60 * 60))   # 告警冷却：1 小时

[ -f "$STATE" ] || exit 0

ok=$(node -e 'try{const j=require("<PI2X_ROOT>/private/state/cc-pool-state.json");console.log(j.ok===true?"1":"0")}catch{console.log("1")}' 2>/dev/null)
reason=$(node -e 'try{const j=require("<PI2X_ROOT>/private/state/cc-pool-state.json");console.log(String(j.reason||"").slice(0,200))}catch{console.log("")}' 2>/dev/null)
now=$(date +%s)

last_alert=0
last_ok="1"
if [ -f "$MARK" ]; then
  last_alert=$(node -e 'try{console.log(require("<PI2X_ROOT>/private/state/cc-pool-alert.json").at||0)}catch{console.log(0)}' 2>/dev/null)
  last_ok=$(node -e 'try{console.log(require("<PI2X_ROOT>/private/state/cc-pool-alert.json").ok===true?"1":"0")}catch{console.log("1")}' 2>/dev/null)
fi

write_mark() {
  # 注意：必须写布尔值。读取端用的是严格比较 j.ok===true，
  # 早先写数字 1 会让 last_ok 永远取到 0，导致「恢复」通知每轮都重复发。
  node -e "require('fs').writeFileSync('<PI2X_ROOT>/private/state/cc-pool-alert.json', JSON.stringify({at:$now, ok:${1}===1}))" 2>/dev/null
}

if [ "$ok" = "1" ]; then
  # 恢复了：只有之前是「已告警过不可用」才发一次恢复通知
  if [ "$last_ok" = "0" ]; then
    node scripts/send-notify.mjs "$ADMIN" "喵～ 好消息喵～ Command Code 号池恢复了，模型又能正常干活了！" >> "$LOG" 2>&1
    echo "[$(date '+%F %T')] 已通知管理员：号池恢复" >> "$LOG"
    write_mark 1
  fi
  exit 0
fi

# 不可用：按冷却间隔告警
if [ $((now - last_alert)) -lt "$COOLDOWN_SEC" ]; then
  exit 0
fi
node scripts/send-notify.mjs "$ADMIN" "喵… 主人，Command Code 号池现在不可用了喵（四个账号都没额度/被限流）。bot 还能用，但相关模型调用会失败，需要充值或者等额度重置喵～
原因：${reason:-未知}" >> "$LOG" 2>&1
echo "[$(date '+%F %T')] 已通知管理员：号池不可用（$reason）" >> "$LOG"
write_mark 0
