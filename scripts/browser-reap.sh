#!/bin/bash
# 回收闲置/僵死的 headless Chrome —— 修「浏览器实例泄漏把 CPU 烧满」。
#
# 【事故】2026-09-23：浏览器技能一天启动了 4 个 Chrome 实例（15:14/16:21/16:35/17:06），
# 旧实例从不关闭，累积成 3 棵进程树、39 个进程；其中一棵的 gpu-process 烧 67.6% +
# renderer 37.6% ≈ **105% CPU 连续 15.7 小时**，把 load 顶到 13，导致模型调用从
# 2 秒劣化到 **882 秒**并返回空回复（bridge 日志 t19：模型调用 882626ms · 回复 0 字）。
# 另外两棵树分别存活 2 天 20 小时、1 天 13 小时。
#
# 【策略】两道闸，任一命中就回收（下次使用浏览器时技能会自动重启，代价 2~5 秒）：
#   ① 闲置：浏览器 profile 最后活动距今 > IDLE_MIN（默认 30 分钟）
#      （profile 里的 History/Cookies mtime 随导航更新，是可靠的"有人在用"信号）
#   ② 硬上限：任一 Chrome 主进程存活 > MAX_AGE_MIN（默认 360 分钟）
#
# 用法：scripts/browser-reap.sh [--dry] [--idle-min N] [--max-age-min N]
set -u

ROOT=<PI2X_ROOT>
LOG="$ROOT/private/logs/browser-reap.log"
IDLE_MIN=${IDLE_MIN:-30}
MAX_AGE_MIN=${MAX_AGE_MIN:-360}
DRY=0
prev=""
for a in "$@"; do
  [ "$a" = "--dry" ] && DRY=1
  case "$prev" in
    --idle-min) IDLE_MIN="$a" ;;
    --max-age-min) MAX_AGE_MIN="$a" ;;
  esac
  prev="$a"
done

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# 只认「headless Chrome 主进程」：带 --remote-debugging-port 的那个（子进程不算）
mains=$(ps -eo pid,args 2>/dev/null | grep -a "chrome-linux-arm64" | grep -a "remote-debugging-port" | grep -av grep | awk '{print $1}')
[ -z "$mains" ] && exit 0   # 没在跑，什么都不做（常态）

now=$(date +%s)

# ── ① 闲置判定：profile 最后活动时间 ────────────────────────────────────
newest=0
for f in "$ROOT/private/browser-profile/Default/History" "$ROOT/private/browser-profile/Default/Cookies" \
         "$ROOT/private/browser-profile-op/Default/History" "$ROOT/private/browser-profile-op/Default/Cookies"; do
  [ -f "$f" ] || continue
  t=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  [ "$t" -gt "$newest" ] && newest=$t
done
idle_min=$(( newest > 0 ? (now - newest) / 60 : 99999 ))

# ── ② 硬上限判定：最老的 Chrome 主进程存活多久 ──────────────────────────
oldest_min=0
for p in $mains; do
  et=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
  [ -n "$et" ] || continue
  m=$(( et / 60 ))
  [ "$m" -gt "$oldest_min" ] && oldest_min=$m
done

reason=""
[ "$idle_min" -gt "$IDLE_MIN" ] && reason="闲置 ${idle_min} 分钟（> ${IDLE_MIN}）"
[ "$oldest_min" -gt "$MAX_AGE_MIN" ] && reason="${reason:+$reason；}存活 ${oldest_min} 分钟（> ${MAX_AGE_MIN}）"
[ -z "$reason" ] && exit 0   # 两闸都没触发 → 有人在用，别动

n_proc=$(ps -eo args 2>/dev/null | grep -ac "chrome-linux-arm64")
if [ "$DRY" -eq 1 ]; then
  log "（干跑）应回收：$reason —— Chrome 实例 $(echo "$mains" | wc -l) 棵 / 进程 $n_proc 个"
  exit 0
fi

log "回收 Chrome：$reason —— 杀掉 $(echo "$mains" | wc -l) 棵实例 / $n_proc 个进程"
pkill -TERM -f "chrome-linux-arm64" 2>/dev/null
sleep 4
pkill -9 -f "chrome-linux-arm64" 2>/dev/null
sleep 2
left=$(ps -eo args 2>/dev/null | grep -ac "chrome-linux-arm64")
log "回收完成，残余 $left 个（技能下次使用时自动重启）"
exit 0
