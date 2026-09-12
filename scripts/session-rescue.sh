#!/bin/bash
# 会话急救 —— 修复「上下文膨胀导致的会话卡死」
#
# 【为什么必须串成一步】
# bridge 进程会把内存中的会话状态写回文件。若在它活着的时候直接改会话文件，
# 改动可能被内存状态覆盖掉 —— 白做。所以顺序必须是：
#     停进程 → 压缩 → 瘦身 → 起进程
#
# 【它解决什么问题】
# 见 REFACTOR 记录：私聊会话活跃上下文涨到 1500+ 条 / 1.9MB 请求体后，
# 上游扛不住，单轮跑满超时；而超时后队列不释放，该会话所有消息静默排队。
# 光瘦身（删磁盘旧历史）没用 —— 请求大小只由**活跃上下文**决定，只有压缩能治。
#
# 用法：
#   bash scripts/session-rescue.sh <会话名> [提示QQ]
#     <会话名>  如 private_3573297011（sessions/ 下的文件名，不含 .jsonl）
#     [提示QQ]  完成后给它发一条通知（可选）
#
# 例：
#   bash scripts/session-rescue.sh private_3573297011 3573297011
set -uo pipefail

ROOT_DIR="/opt/pi2x"
cd "$ROOT_DIR" || exit 1
export PATH=/usr/local/bin:/usr/bin:/bin

NAME="${1:-}"
NOTIFY_TO="${2:-}"
if [ -z "$NAME" ]; then
  echo "用法: $0 <会话名> [提示QQ]"
  echo "可用会话："
  ls sessions/*.jsonl 2>/dev/null | xargs -n1 basename | sed 's/\.jsonl$//' | sed 's/^/  /'
  exit 2
fi

FILE="sessions/${NAME}.jsonl"
[ -f "$FILE" ] || { echo "会话文件不存在: $FILE"; exit 1; }

log() { echo "[rescue $(date '+%H:%M:%S')] $*"; }

# 等待参数：给调用方留出把回复发出去的时间
DELAY="${PI2X_RESCUE_DELAY:-0}"
[ "$DELAY" -gt 0 ] && { log "等待 ${DELAY}s（让当前回复先送出）"; sleep "$DELAY"; }

echo "===== 会话急救: $NAME ====="
BEFORE=$(stat -c %s "$FILE")
log "处理前: $(echo "scale=2; $BEFORE/1048576" | bc)MB"

# ── 1) 停进程（必须，否则内存状态会覆盖文件改动）──────────────────────
log "停止 bridge…"
pkill -f 'bridge[.]mjs' 2>/dev/null
for _ in $(seq 1 15); do
  pgrep -f 'bridge[.]mjs' >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -f 'bridge[.]mjs' >/dev/null 2>&1; then
  log "⚠ 进程未在 15s 内退出，强制结束"
  pkill -9 -f 'bridge[.]mjs' 2>/dev/null
  sleep 2
fi

# ── 2) 备份 ──────────────────────────────────────────────────────────
mkdir -p tmp/archive
BAK="tmp/archive/${NAME}.jsonl.bak-$(date +%F_%T)"
cp "$FILE" "$BAK"
log "已备份 → $BAK"

# ── 3) 压缩活跃上下文（真正能降低请求体的那一步）────────────────────
log "压缩上下文（可能要几分钟）…"
source /etc/profile.d/deepseek.sh 2>/dev/null
source /etc/profile.d/cred.sh 2>/dev/null
node scripts/compact-sessions.mjs "$FILE" 2>&1 | grep -vE "ExperimentalWarning|trace-warnings" | sed 's/^/   /'

# ── 4) 瘦身（丢弃已压缩掉的旧历史，减小磁盘占用与加载耗时）──────────
log "瘦身…"
node scripts/sessions-maint.mjs --slim --min-idle 0 2>&1 | grep -E "private_${NAME#private_}|已处理|跳过|${NAME}" | sed 's/^/   /' || true

AFTER=$(stat -c %s "$FILE")
log "处理后: $(echo "scale=2; $AFTER/1048576" | bc)MB"

# ── 5) 起进程 ────────────────────────────────────────────────────────
log "启动 bridge…"
LOGLINES=$(wc -l < logs/bridge.log 2>/dev/null || echo 0)
nohup node bridge.mjs >> logs/bridge.log 2>&1 &
disown 2>/dev/null

READY=0
for _ in $(seq 1 30); do
  if tail -n +"$((LOGLINES + 1))" logs/bridge.log 2>/dev/null | grep -q 'pi agent 就绪'; then
    READY=1; break
  fi
  pgrep -f 'bridge[.]mjs' >/dev/null 2>&1 || break
  sleep 1
done

if [ "$READY" = "1" ]; then
  log "✅ 已就绪"
  if [ -n "$NOTIFY_TO" ]; then
    node scripts/send-notify.mjs "$NOTIFY_TO" "会话急救完成：$NAME 已压缩并重启，上下文应已显著下降。" 2>/dev/null
  fi
else
  log "❌ 启动失败，最近日志："
  tail -n 20 logs/bridge.log | sed 's/^/   | /'
  if [ -n "$NOTIFY_TO" ]; then
    node scripts/send-notify.mjs "$NOTIFY_TO" "⚠️ 会话急救后 bridge 未就绪，需人工检查 logs/bridge.log" 2>/dev/null
  fi
  exit 1
fi

# ── 6) 报告新上下文规模 ─────────────────────────────────────────────
log "等 20s 让首轮统计落盘…"
sleep 20
grep -E "上下文|compact" logs/bridge.log | tail -3 | sed 's/^/   /'
exit 0
