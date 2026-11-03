#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# strix 常驻 worker 启动器（给 lib/strix-session.mjs 调用）
#
# 与 strix/run.sh 的区别：那个是「跑一次扫描就退出」的 CLI 启动器；
# 这个是**常驻会话**的加载器 —— 同一个进程里反复对话，不退出。
# 环境变量与 run.sh 完全一致（共用同一个 omniroute 网关与模型），
# 避免两处配置漂移。
#
# 工作目录必须是 strix/runs —— 与 run.sh / strix-cli.mjs 保持一致：
# strix 把 run 目录算作 `cwd/strix_runs/<run_name>`，cwd 不同则「已有会话」
# 会在两个地方各存一份（实测把 run 落到了 strix/strix_runs 而不是
# strix/runs/strix_runs，导致 /strix ls 看不到刚建的会话）。
#
# 用法：pi2x-worker.sh -- <-n -t <target> ...>   （"--" 后的参数原样交给 strix）
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STRIX_DIR="$(dirname "$HERE")"

# ── LLM：与 PI2X 本身一致（同一个网关、同一个模型）──────────────────
ENV_FILE="/root/.omniroute/.env"
if [ -z "${OMNIROUTE_API_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  OMNIROUTE_API_KEY="$(grep -oP '^OMNIROUTE_API_KEY=\K.*' "$ENV_FILE" | tr -d '"'"'"'' )"
fi
export OMNIROUTE_BASE_URL="${OMNIROUTE_BASE_URL:-http://127.0.0.1:39001/v1}"
export OMNIROUTE_API_KEY

if [ -z "${OMNIROUTE_API_KEY:-}" ]; then
  echo "错误：拿不到 OMNIROUTE_API_KEY（$ENV_FILE 里没有，环境变量也没给）" >&2
  exit 1
fi

export STRIX_LLM="${STRIX_LLM:-openai/deepseek-v4.1-flash}"
export LLM_API_KEY="${LLM_API_KEY:-$OMNIROUTE_API_KEY}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$OMNIROUTE_BASE_URL}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$OMNIROUTE_API_KEY}"

# ── 浏览器（strix 的动态分析工具）─────────────────────────────────────
if [ -f "$HERE/agent-browser-env.sh" ]; then
  # shellcheck disable=SC1091
  . "$HERE/agent-browser-env.sh"
fi

# ── 本地后端：不用 Docker ────────────────────────────────────────────
export STRIX_RUNTIME_BACKEND="${STRIX_RUNTIME_BACKEND:-local}"
export STRIX_NO_UPDATE_CHECK=1
export LITELLM_LOCAL_MODEL_COST_MAP="${LITELLM_LOCAL_MODEL_COST_MAP:-True}"

cd "$STRIX_DIR/runs" 2>/dev/null || { mkdir -p "$STRIX_DIR/runs"; cd "$STRIX_DIR/runs"; }
exec "$STRIX_DIR/venv/bin/python" "$STRIX_DIR/scripts/pi2x_worker.py" "$@"
