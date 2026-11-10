#!/usr/bin/env bash
# mooc-loop.sh —— 超星挂课外层循环（长时间连续跑）
#
# 每轮：node mooc-runner.mjs --minutes 100 --port 9333 [--stall-min 3]
#   退出码 0（时间预算到）或 2（browser-cli 看门狗超时）→ 等 60s 跑下一轮
#   退出码 3（验证码/异常）→ 写 STOPPED，等 10 分钟再判：验证码类真停，否则自动重试
#   退出码 4（停滞，自愈+5 分钟确认都失败）/5（恢复失败）/6（掉线）
#       → 写 STOPPED，先等 10 分钟；不是验证码类就自动清掉 STOPPED 重试
#   连续自动重试 3 次仍停 → 彻底停，并在 STOPPED 里注明「已自动重试 3 次仍失败」
#   其它退出码 → 写 STOPPED 停下等人
#
# 自动重试（2026-11-04 加）：昨天卡 17 小时的原因之一就是「判死以后没人再踢一脚」。
# 现在只要不是验证码类，就自己等 10 分钟再试，最多 3 次；次数写进 state.json 的 autoRestartCount。
#
# 独立浏览器：先确保 :9333（profile=tmp/mooc/profile）在跑，绝不使用 9222。
#
# 用法：nohup bash <PI2X_ROOT>/scripts/mooc-loop.sh >> <PI2X_ROOT>/tmp/mooc/loop.nohup 2>&1 &
set -u

OUT=<PI2X_ROOT>/tmp/mooc
RUNNER=<PI2X_ROOT>/scripts/mooc-runner.mjs
CHROME_SH=$OUT/start-chrome.sh
PORT=9333
LOG=$OUT/loop.log
STOP=$OUT/STOPPED
LOCK=$OUT/loop.lock
STATE=$OUT/state.json
AUTO=$OUT/autorestart.json
RETRY_WAIT=600        # 停下后先等 10 分钟再看
AUTO_MAX=3            # 连续自动重试上限

mkdir -p "$OUT"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# 单实例保护
if [ -f "$LOCK" ]; then
  oldpid=$(cat "$LOCK" 2>/dev/null || true)
  if [ -n "${oldpid:-}" ] && kill -0 "$oldpid" 2>/dev/null; then
    log "已有 loop 在跑（pid=$oldpid），本次退出"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'log "loop 收到终止信号，退出"; rm -f "$LOCK"; exit 143' INT TERM

# ---- 自动重试计数（跨 loop 重启保留）----
auto_read() {
  node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.count||0))}catch(e){process.stdout.write("0")}' "$AUTO" 2>/dev/null || echo 0
}
auto_write() {
  node -e 'const fs=require("fs");const f=process.argv[1];const c=Number(process.argv[2])||0;fs.writeFileSync(f,JSON.stringify({count:c,at:new Date().toISOString()},null,1));const s=process.argv[3];try{const st=JSON.parse(fs.readFileSync(s,"utf8"));st.autoRestartCount=c;fs.writeFileSync(s,JSON.stringify(st,null,1))}catch(e){}' "$AUTO" "$1" "$STATE" 2>/dev/null || true
}

# 验证码类判定：STOPPED 里出现这些词就真的停（等人工）
is_captcha_stop() {
  [ -s "$STOP" ] || return 1
  local c
  c=$(tr '\n' ' ' < "$STOP" 2>/dev/null)
  case "$c" in
    *验证码*|*滑块*|*webslider*|*captcha*|*人脸*|*风控*|*访问异常*|*异常行为*|*安全验证*|*身份验证*|*扫码验证*|*检测到异常*) return 0 ;;
    *) return 1 ;;
  esac
}

AUTO_CNT=$(auto_read)
log "===== mooc-loop 启动 pid=$$ port=$PORT（autoRestartCount=$AUTO_CNT）====="
round=0

while :; do
  round=$((round + 1))
  started=$(date +%s)
  log "--- 第 $round 轮开始（--minutes 100 --port $PORT --stall-min 3）---"

  if ! bash "$CHROME_SH" >> "$LOG" 2>&1; then
    log "警告：独立 Chrome（:$PORT）未能确认就绪，仍尝试开跑"
  fi

  node "$RUNNER" --minutes 100 --port "$PORT" --stall-min 3 >> "$OUT/runner.out" 2>&1
  code=$?
  dur=$(( $(date +%s) - started ))
  log "第 $round 轮结束：退出码 $code，耗时 ${dur}s"

  case "$code" in
    0|2)
      # 正常轮到点 / 浏览器看门狗超时：连跑；连续自动重试计数清零（能跑就算健康）
      AUTO_CNT=0; auto_write 0
      done_pts=$(node -e 'try{const s=require("<PI2X_ROOT>/tmp/mooc/state.json");process.stdout.write(String(s.completedPoints)+"/"+String(s.totalPoints))}catch(e){process.stdout.write("-/-")}' 2>/dev/null)
      case "$done_pts" in
        "96/96")
          echo "全部任务点已完成（96/96），$(ts)" > "$STOP"
          log "【结束】全部任务点已完成，写 $STOP"
          break
          ;;
      esac
      # 死循环保护：连续 3 轮进度一模一样，说明在重播已完成节点空转
      if [ "$done_pts" = "${LAST_PTS:-}" ]; then
        SAME_CNT=$(( ${SAME_CNT:-0} + 1 ))
      else
        SAME_CNT=0
      fi
      LAST_PTS=$done_pts
      if [ "$SAME_CNT" -ge 3 ]; then
        echo "空转：连续 $((SAME_CNT + 1)) 轮进度都是 $done_pts，$(ts)" > "$STOP"
        log "【停止】连续 $((SAME_CNT + 1)) 轮进度不变（$done_pts），已写 $STOP"
        break
      fi
      log "等 60 秒后开始下一轮（当前进度 $done_pts）"
      sleep 60
      ;;
    7)
      # 【空转】没节点可播但任务点没做完：写 STOPPED 让看门狗推事件叫醒 Router，
      # 不再每 60 秒重开一遍页面空跑（19:50 那次就是这么空转 27 轮的）。
      done_pts=$(node -e 'try{const s=require("<PI2X_ROOT>/tmp/mooc/state.json");process.stdout.write(String(s.completedPoints)+"/"+String(s.totalPoints))}catch(e){process.stdout.write("-/-")}' 2>/dev/null)
      echo "空转：没有可播节点，进度停在 $done_pts（退出码 7），$(ts)" > "$STOP"
      log "【停止】空转，进度 $done_pts，已写 $STOP"
      break
      ;;
    3|4|5|6)
      # runner 自己已经写过 STOPPED（4/5/6 带现场）；3 没写的话这边补
      if [ ! -s "$STOP" ]; then
        echo "验证码/风控异常（退出码 $code），$(ts)" > "$STOP"
      fi
      log "【停止】退出码 $code，STOPPED=$(head -c 160 "$STOP" | tr '\n' ' ')"
      log "按约定先等 ${RETRY_WAIT}s，再判断是不是验证码类"
      sleep "$RETRY_WAIT"

      if [ ! -s "$STOP" ]; then
        log "等待期间 STOPPED 已被清掉（有人在处理），直接重试"
      elif is_captcha_stop; then
        log "【真停】STOPPED 属于验证码类，不自动重试，等人处理：$(head -c 120 "$STOP" | tr '\n' ' ')"
        break
      fi

      if [ "$AUTO_CNT" -ge "$AUTO_MAX" ]; then
        {
          echo "已自动重试 ${AUTO_MAX} 次仍失败（最后一次退出码 $code，$(ts)）"
          head -c 600 "$STOP" 2>/dev/null || true
        } > "$STOP"
        log "【真停】连续自动重试 ${AUTO_MAX} 次仍失败，彻底停下，已写 STOPPED"
        break
      fi

      AUTO_CNT=$((AUTO_CNT + 1))
      auto_write "$AUTO_CNT"
      rm -f "$STOP"
      log "【自动重试】第 ${AUTO_CNT}/${AUTO_MAX} 次：清掉 STOPPED，重开一轮（非验证码类）"
      sleep 20
      ;;
    *)
      echo "异常退出码 $code，$(ts)" > "$STOP"
      log "【停止】异常退出码 $code，已写 $STOP"
      break
      ;;
  esac
done

rm -f "$LOCK"
log "===== mooc-loop 结束（共 $round 轮，autoRestartCount=$(auto_read)）====="
