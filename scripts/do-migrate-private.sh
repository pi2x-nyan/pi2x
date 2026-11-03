#!/bin/bash
# 一次性：完成 private/ 迁移（停服务 → 搬数据 → 预检 → 重启）
#
# 【为什么必须做成独立脚本 + setsid】
# agent 的 bash 工具是 bridge 的**子进程**（实测 PPID=bridge PID）。
# 因此「在这条链上直接 pkill bridge」＝ 连自己一起杀（自杀式停止，
# 2026-09-21 凌晨连续两次都是这个原因）。
# 本脚本由调用方用 setsid 启动，脱离父进程树后自带完整流程，不依赖调用方存活。
set -u

ROOT=<PI2X_ROOT>
cd "$ROOT" || exit 1
export PATH=/usr/local/bin:/usr/bin:/bin
source /etc/profile.d/deepseek.sh 2>/dev/null
source /etc/profile.d/cred.sh 2>/dev/null

# 日志写在**仓库外**/tmp —— 因为本次任务就是把 logs/ 搬走，
# 写在被搬目录里会跟着“消失”（后续找不到输出，排查很痛苦）。
MIG_LOG=/tmp/pi2x-migrate-private.log

say() { echo "[$(date '+%F %T')] $*" | tee -a "$MIG_LOG"; }

say "════ 开始迁移到 private/ ════"

# ── 0) 上重启锁：让看门狗本轮跳过探活（语义：同锁只跳一轮，约 2 分钟缓冲）──
mkdir -p "$ROOT/state" 2>/dev/null
echo "$$ $(date +%s%3N)" > "$ROOT/state/restart.lock" 2>/dev/null
rm -f "$ROOT/state/restart.lock.seen" 2>/dev/null   # 清掉旧标记，确保本轮会跳过
say "已上重启锁"

# ── 1) 停服务 ──
say "停止 bridge…"
pkill -f 'bridge[.]mjs' 2>/dev/null
for _ in $(seq 1 15); do
  pgrep -f 'bridge[.]mjs' >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -f 'bridge[.]mjs' >/dev/null 2>&1; then
  say "⚠️ bridge 未退出，强制 kill"
  pkill -9 -f 'bridge[.]mjs' 2>/dev/null
  sleep 2
fi
say "bridge 已停"

# ── 2) 迁移数据 ──
say "迁移数据（16 项 / 约 1.7GB）…"
node scripts/migrate-to-private.mjs --apply >> "$MIG_LOG" 2>&1
MIG_RC=$?
if [ "$MIG_RC" != "0" ]; then
  say "❌ 迁移失败（rc=$MIG_RC），日志见 $MIG_LOG"
  say "   尝试用旧布局重启，保证服务先活着…"
  nohup node bridge.mjs >> "$ROOT/logs/bridge.log" 2>&1 &
  disown 2>/dev/null
  rm -f "$ROOT/state/restart.lock" 2>/dev/null
  exit 1
fi
say "✅ 迁移完成"

# ── 3) 预检 ──
PRE_LOG=/tmp/pi2x-preflight-after-migrate.log
say "冒烟检查…"
if ! node scripts/preflight.mjs >> "$PRE_LOG" 2>&1; then
  say "❌ 预检未通过，日志见 $PRE_LOG"
  say "   仍尝试启动（新布局），请人工检查"
fi

# ── 4) 起服务（日志改到 private/logs）──
BLOG="$ROOT/private/logs/bridge.log"
mkdir -p "$ROOT/private/logs" 2>/dev/null
say "启动 bridge（日志 → $BLOG）…"
BEFORE=$(wc -l < "$BLOG" 2>/dev/null || echo 0)
nohup node bridge.mjs >> "$BLOG" 2>&1 &
disown 2>/dev/null

READY=0
for _ in $(seq 1 40); do
  if tail -n +"$((BEFORE + 1))" "$BLOG" 2>/dev/null | grep -q 'pi agent 就绪'; then
    READY=1; break
  fi
  pgrep -f 'bridge[.]mjs' >/dev/null 2>&1 || break
  sleep 1
done

rm -f "$ROOT/state/restart.lock" 2>/dev/null
rm -f "$ROOT/private/state/restart.lock" 2>/dev/null

if [ "$READY" = "1" ]; then
  say "✅ 服务已就绪（新 private/ 布局）"
  node scripts/send-notify.mjs 3573297011 "✅ 私人目录迁移完成，PI2X 已用新布局上线（数据全部收进 private/）。" 2>/dev/null
  exit 0
else
  say "❌ 启动未就绪，最近日志："
  tail -n 25 "$BLOG" 2>/dev/null | sed 's/^/   | /' | tee -a "$MIG_LOG"
  node scripts/send-notify.mjs 3573297011 "⚠️ 迁移后服务未就绪，请检查 private/logs/bridge.log" 2>/dev/null
  exit 1
fi
