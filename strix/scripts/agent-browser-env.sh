# strix 的浏览器工具（agent-browser）环境配置
# 来源：官方容器 Dockerfile 里 AGENT_BROWSER_* 一组变量
export AGENT_BROWSER_EXECUTABLE_PATH="/root/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome"
export AGENT_BROWSER_SCREENSHOT_DIR="<PI2X_ROOT>/strix/runs/screenshots"
mkdir -p "$AGENT_BROWSER_SCREENSHOT_DIR"
