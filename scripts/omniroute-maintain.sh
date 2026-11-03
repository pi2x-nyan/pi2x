#!/bin/bash
# OmniRoute 维护：按阈值判断是否需要「停机 → 裁剪库 → 重启」，顺带回收 swap。
#
# 【为什么需要】
# OmniRoute 的 sql.js(WASM) 驱动把**整个** storage.sqlite 读进内存，且不受
# --max-old-space-size 约束；它自己的堆上限又是「总内存的 35%」（本机 2617MB）。
# 结果是：库越长越大 → 内存越长越大 → 在 7.5GB 手机上被整体换出到 swap →
# 每个请求都磁盘颠簸，模型调用从几十秒劣化到 143~512 秒、偶发 ETIMEDOUT。
# 实测 2026-09-23：conversation_turn_nodes 一张表加索引就到 219MB（占库 81%），
# 进程匿名内存 ~4GB（RSS 只 67MB，swap 4006MB）。
#
# 【策略】默认**只在超阈值时**维护，避免无谓的服务中断：
#   · 库 > DB_MB_LIMIT（默认 60MB）        → 需要裁剪
#   · 进程 RSS+Swap > MEM_MB_LIMIT（默认 1200MB）→ 需要重启回收
# 加 --force 则无条件执行一次（首次修复用）。
#
# 用法：scripts/omniroute-maintain.sh [--force] [--dry]
set -u

ROOT=<PI2X_ROOT>
LOGDIR="$ROOT/private/logs"
LOG="$LOGDIR/omniroute-maintain.log"
DB=/root/.omniroute/storage.sqlite
BACKUP_DIR=/root/omniroute-db-backup
PORT=20128
DB_MB_LIMIT=${DB_MB_LIMIT:-60}
MEM_MB_LIMIT=${MEM_MB_LIMIT:-1200}
KEEP_BACKUPS=${KEEP_BACKUPS:-3}

FORCE=0; DRY=0
for a in "$@"; do
  [ "$a" = "--force" ] && FORCE=1
  [ "$a" = "--dry" ] && DRY=1
done

mkdir -p "$LOGDIR" "$BACKUP_DIR"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# ── 度量 ────────────────────────────────────────────────────────────────
db_mb=$( [ -f "$DB" ] && echo $(( $(stat -c %s "$DB") / 1048576 )) || echo 0 )
# 【内存度量陷阱】必须同时算法子两个进程：
#   · 父：node /usr/local/bin/omniroute serve --no-open
#   · 子：omniroute (v16.3.1)   ← **真正吃 4GB 的就是它**
# 早期只写 `pgrep -f "[o]mniroute serve"`，只命中父进程（~70MB），导致
# “内存 74MB” 这种严重低估，阀值判断完全失灵。用锚定正则同时命中两者，
# 又不会匹配到本脚本自身（bash 开头）。
OMNI_PATTERN='^(node /usr/local/bin/omniroute serve|omniroute \(v)'
mem_mb=0
for p in $(pgrep -f "$OMNI_PATTERN" 2>/dev/null); do
  rss=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null)
  swp=$(awk '/VmSwap/{print $2}' /proc/$p/status 2>/dev/null)
  mem_mb=$(( mem_mb + ${rss:-0}/1024 + ${swp:-0}/1024 ))
done

log "现状：库 ${db_mb}MB（阈值 ${DB_MB_LIMIT}MB）· OmniRoute 内存 ${mem_mb}MB（阈值 ${MEM_MB_LIMIT}MB）"

need_db=0; need_restart=0
[ "$db_mb" -gt "$DB_MB_LIMIT" ] && need_db=1
[ "$mem_mb" -gt "$MEM_MB_LIMIT" ] && need_restart=1
if [ "$FORCE" -eq 0 ] && [ "$need_db" -eq 0 ] && [ "$need_restart" -eq 0 ]; then
  log "未超阈值，跳过维护"
  exit 0
fi
if [ "$DRY" -eq 1 ]; then
  log "（干跑）需要裁剪=$need_db 需要重启=$need_restart —— 不执行"
  exit 0
fi

# ── 备份（保留最近 N 份）───────────────────────────────────────────────
stamp=$(date '+%Y%m%d_%H%M%S')
mkdir -p "$BACKUP_DIR/$stamp"
cp -f "$DB" "$BACKUP_DIR/$stamp/" 2>/dev/null
for f in "$DB-wal" "$DB-shm"; do [ -f "$f" ] && cp -f "$f" "$BACKUP_DIR/$stamp/"; done
log "已备份到 $BACKUP_DIR/$stamp（$(du -sh "$BACKUP_DIR/$stamp" 2>/dev/null | cut -f1)）"
ls -1dt "$BACKUP_DIR"/*/ 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
  rm -rf "$old" && log "清理旧备份 $(basename "$old")"
done

# ── 停机 ────────────────────────────────────────────────────────────────
log "停止 OmniRoute…"
pkill -TERM -f "[o]mniroute serve" 2>/dev/null
for _ in $(seq 1 20); do pgrep -f "[o]mniroute serve" >/dev/null 2>&1 || break; sleep 1; done
if pgrep -f "[o]mniroute serve" >/dev/null 2>&1; then
  log "TERM 未生效，强制结束"
  pkill -9 -f "[o]mniroute serve" 2>/dev/null
  pkill -9 -f "omniroute \(v" 2>/dev/null
  sleep 2
fi

# ── 裁剪（停机窗口内）──────────────────────────────────────────────────
if [ "$need_db" -eq 1 ] || [ "$FORCE" -eq 1 ]; then
  node "$ROOT/scripts/omniroute-prune-db.mjs" 2>&1 | tee -a "$LOG"
else
  log "库未超阈值，跳过裁剪（仅重启回收内存）"
fi

# ── 重启 ────────────────────────────────────────────────────────────────
log "启动 OmniRoute…"
cd /usr/local/lib/node_modules/omniroute || exit 1
setsid nohup /usr/local/bin/omniroute serve --no-open >> "$LOG" 2>&1 < /dev/null &
for i in $(seq 1 60); do
  sleep 2
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/models" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    after=0
    for p in $(pgrep -f "$OMNI_PATTERN" 2>/dev/null); do
      rss=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null); swp=$(awk '/VmSwap/{print $2}' /proc/$p/status 2>/dev/null)
      after=$(( after + ${rss:-0}/1024 + ${swp:-0}/1024 ))
    done
    log "已就绪（HTTP $code，用时 $((i*2))s）· 内存 ${mem_mb}MB → ${after}MB · 库 ${db_mb}MB → $(( $(stat -c %s "$DB") / 1048576 ))MB"
    exit 0
  fi
done
log "启动超时（120s），请查 $LOG"
exit 1
