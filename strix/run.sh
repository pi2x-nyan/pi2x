#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# strix 本地模式启动器 —— 复用 PI2X 自己的 omniroute 网关与模型
#
# 用法（与官方 strix 完全一致）：
#   strix/run.sh -n -t https://example.com --scan-mode quick --max-budget 2
#   strix/run.sh -n -t ./some-dir --scan-mode standard
#
# 与官方版差异：不需要 Docker（本地沙箱后端）。
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

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

# PI2X 用的模型 ID 是 omniroute/openai/deepseek-flash；
# strix 的 provider 前缀不同，同一模型的写法是 openai/openai/deepseek-flash。
export STRIX_LLM="${STRIX_LLM:-openai/deepseek-v4.1-flash}"
export LLM_API_KEY="${LLM_API_KEY:-$OMNIROUTE_API_KEY}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$OMNIROUTE_BASE_URL}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$OMNIROUTE_API_KEY}"

# ── 浏览器（agent-browser 是 strix 的动态分析工具）────────────────────
# 官方容器用 AGENT_BROWSER_* 一组变量指向内置 chromium；本机指向 Playwright 的 Chrome。
if [ -f "$HERE/scripts/agent-browser-env.sh" ]; then
  # shellcheck disable=SC1091
  . "$HERE/scripts/agent-browser-env.sh"
fi

# ── 本地后端：不用 Docker ────────────────────────────────────────────
export STRIX_RUNTIME_BACKEND="${STRIX_RUNTIME_BACKEND:-local}"
export STRIX_NO_UPDATE_CHECK=1
# litellm 默认去 raw.githubusercontent.com 拉远端价格表（本机被墙会卡住）
export LITELLM_LOCAL_MODEL_COST_MAP="${LITELLM_LOCAL_MODEL_COST_MAP:-True}"

# 输出目录（默认放到这里，避免散落）
cd "$ROOT/strix"
mkdir -p runs
cd runs

exec "$HERE/venv/bin/strix" "$@"
