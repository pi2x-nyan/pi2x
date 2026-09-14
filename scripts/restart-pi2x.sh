#!/bin/bash
# PI2X 服务重启（带保险）—— 由内置命令 /restart 触发（仅 admin）
#
# ─────────────────────────────────────────────────────────────────────────
# 【设计原则：重启是有风险的动作，必须先验证、再执行、失败能回滚】
#
# 顺序严格如下，且「只读模式」必须在**任何有副作用的动作之前**返回：
#   0) 参数解析 / --print-target / --dry-run  ← 只读，绝不杀进程
#   1) 冒烟检查：语法 + 关键模块导入 + 快速测试  ← 不通过就拒绝重启（旧进程继续活着）
#   2) 快照：把当前工作区状态 commit 一份 WIP（回滚点永远存在）
#   3) pkill 旧进程 → 等待退出
#   4) 拉起新进程 → 等待「pi agent 就绪」
#   5) 失败 → 自动回滚到上一个可用 commit 并重启（见 scripts/rescue.mjs）
#   6) 成功 → 给触发者发上线提醒
#
# 【踩过的坑（务必不要改回去）】
#   这里原先把参数解析放在 pkill 之后，导致手工用 `--print-target` 做参数自测时，
#   脚本已经把 bridge 杀了 —— 连续自测 = 连续自杀重启，把调用方（agent 自己）卡死。
#   「只读模式必须最先返回」这条不是洁癖，是血的教训。
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 0) 参数解析（只读，先于一切副作用）────────────────────────────────────
#   $1 = private|group（可省，默认 private）  $2 = QQ号/群号
#   只给一个参数且它不是 private/group 时，视为 target。
Arg1="${1:-}"
Arg2="${2:-}"
Chat="${PI2X_RESTART_CHAT:-}"
Target="${PI2X_RESTART_TARGET:-}"
if [ -z "$Target" ]; then
  case "$Arg1" in
    private|group) Chat="${Chat:-$Arg1}"; Target="$Arg2" ;;
    "") ;;
    *) if [ -z "$Arg2" ]; then Target="$Arg1"; else Chat="${Chat:-$Arg1}"; Target="$Arg2"; fi ;;
  esac
fi
Chat="${Chat:-private}"
Uid="${PI2X_RESTART_UID:-$Target}"

ONLY_READ=0
SKIP_CHECK=0
for a in "$@"; do
  case "$a" in
    --print-target) ONLY_READ=1 ;;
    --dry-run)      ONLY_READ=1 ;;
    --no-check)     SKIP_CHECK=1 ;;
  esac
done

if [ "$ONLY_READ" = "1" ]; then
  echo "chat=$Chat target=$Target uid=$Uid"
  if [ "$Arg1" = "--dry-run" ] || [ "$Arg2" = "--dry-run" ]; then
    echo "（dry-run：仅解析参数，不会触碰任何进程）"
  fi
  exit 0
fi

cd "$ROOT_DIR" || exit 1
export PATH=/usr/local/bin:/usr/bin:/bin

log() { echo "[restart] $*"; }

# ── 1) 冒烟检查：不通过就拒绝重启 ─────────────────────────────────────────
# 核心保险：宁可不重启（旧进程还能服务），也不要拉起一个起不来的新进程。
if [ "$SKIP_CHECK" = "0" ]; then
  log "冒烟检查：语法 + 模块导入 + 快速测试（跳过用 --no-check）"
  if ! node scripts/preflight.mjs >> logs/preflight.log 2>&1; then
    log "❌ 冒烟检查未通过，已**拒绝重启**（旧进程继续服务）。"
    log "   详情：logs/preflight.log"
    tail -n 20 logs/preflight.log | sed 's/^/   | /'
    if [ -n "$Uid" ]; then
      node scripts/send-notify.mjs "$Uid" "⚠️ 重启已中止：改动未通过冒烟检查，旧版本继续运行。详情见 logs/preflight.log" 2>/dev/null
    fi
    exit 1
  fi
  log "✅ 冒烟检查通过"
fi

# ── 2) 快照：留一个回滚点（失败不阻塞重启）────────────────────────────────
if [ -d .git ]; then
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    git add -A 2>/dev/null
    git -c user.email=pi2x@localhost -c user.name=PI2X commit -q -m "wip: 重启前自动快照 $(date '+%F %T')" 2>/dev/null \
      && log "已创建回滚点 $(git rev-parse --short HEAD)"
  fi
fi
PREV_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "")"

# ── 3) 停旧进程 ───────────────────────────────────────────────────────────
#
# 【为什么必须先上「重启锁」】
# 看门狗由 cron **每分钟**巡检一次（见 crontab：*/1 * * * * watchdog.mjs），
# 它只看「进程是否存活 + 心跳是否新鲜」，并不知道此刻有人正在重启。
# 而本脚本从杀进程到新进程就绪之间有一段空窗（实测 20:28:11 停 → 20:29:05 起，约 54 秒）。
# 若 cron 恰好落在这个窗口里，看门狗会判定「正常模式挂了」并抢先拉起，
# 于是用户收到的是「🔧 被看门狗自动拉起」而不是「已重启完成」——
# 两次真实重启都撞上了这个竞态。
#
# 锁的语义（**不是**「锁存在就一直跳过」）：
#   · 看门狗只在**第一次**看到这把锁时跳过一轮，并把 lockId 记进 state/restart.lock.seen；
#   · 第二轮起即便锁还在，它也照常探活 —— 一把残留死锁不该让探活永久失效。
# 于是等价于「重启最多被容忍 120 秒」（config.lifecycle.restartLockTtlMs）：
# 锁过期后看门狗立刻接管；脚本被 kill、锁没清掉，也不会挡住探活。
LOCK="$ROOT_DIR/state/restart.lock"
mkdir -p "$ROOT_DIR/state" 2>/dev/null
# ⚠ 时间戳必须用**毫秒**（`date +%s%3N`），不能是 `date +%s`（秒）。
# 看门狗那边用 Node 的 Date.now()（毫秒）做差值；量纲不一致会差 1000 倍，
# 于是刚写的锁被判定「过期 56 年」形同虚设 —— 踩过一次（2026-09-13）。
echo "$$ $(date +%s%3N)" > "$LOCK" 2>/dev/null
cleanup_lock() { rm -f "$LOCK" 2>/dev/null; }
trap cleanup_lock EXIT INT TERM

sleep 1
pkill -f 'bridge[.]mjs' 2>/dev/null
for _ in $(seq 1 10); do
  pgrep -f 'bridge[.]mjs' >/dev/null 2>&1 || break
  sleep 1
done

# ── 4) 起新进程 ───────────────────────────────────────────────────────────
source /etc/profile.d/deepseek.sh 2>/dev/null
source /etc/profile.d/cred.sh 2>/dev/null
# 记录本次启动时日志的行数，用于只判断「新启动」是否成功
LOGLINES_BEFORE=$(wc -l < logs/bridge.log 2>/dev/null || echo 0)
nohup node bridge.mjs >> logs/bridge.log 2>&1 &
disown 2>/dev/null

READY=0
for _ in $(seq 1 25); do
  if tail -n +"$((LOGLINES_BEFORE + 1))" logs/bridge.log 2>/dev/null | grep -q 'pi agent 就绪'; then
    READY=1
    break
  fi
  # 进程都没了，不必再等
  pgrep -f 'bridge[.]mjs' >/dev/null 2>&1 || break
  sleep 1
done

# ── 5) 启动失败 → 自动回滚 ────────────────────────────────────────────────
if [ "$READY" != "1" ]; then
  log "❌ 新进程启动失败（未出现「pi agent 就绪」）"
  log "   最近日志："
  tail -n 25 logs/bridge.log | sed 's/^/   | /'
  if [ -n "$PREV_SHA" ] && [ -x scripts/rescue.mjs ] || [ -f scripts/rescue.mjs ]; then
    log "→ 调用救援脚本自动回滚…"
    node scripts/rescue.mjs auto-rollback 2>&1 | sed 's/^/   | /'
  fi
  if [ -n "$Uid" ]; then
    node scripts/send-notify.mjs "$Uid" "⚠️ PI2X 重启失败，已尝试自动回滚（回滚点 ${PREV_SHA:-无}）。详情见 logs/bridge.log" 2>/dev/null
  fi
  exit 1
fi

# ── 6) 上线提醒 ───────────────────────────────────────────────────────────
log "✅ 已就绪"
if [ -n "$Uid" ]; then
  if [ "$Chat" = "group" ] && [ -n "$Target" ]; then
    node scripts/send-notify.mjs "$Target" "PI2X 已重启完成，服务已上线。" --group
  else
    node scripts/send-notify.mjs "$Uid" "PI2X 已重启完成，服务已上线。"
  fi
fi
exit 0
