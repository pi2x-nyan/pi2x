#!/bin/bash
# 解析运行期目录的实际位置（private/ 优先，否则旧布局），供 shell 脚本复用。
#
# 【为什么需要】
# 私密数据收进 private/ 后，logs/state/sessions 的位置会变，
# 而多个 .sh 脚本（restart / watchdog / session-rescue / bridge-watchdog）里
# 硬编码了 `logs/bridge.log` 这类相对路径。若不统一，迁移后日志会写到
# 空目录里（甚至创建出一套假的旧布局），排查时会看到“服务没输出”。
#
# 用法：  source scripts/private-paths.sh
#         echo "$P_LOGS_DIR/bridge.log"
#
# 判定与 lib/config.mjs 的 PRIVATE_ENABLED 一致：private/ 存在即用新布局。

PI2X_ROOT="${PI2X_ROOT:-<PI2X_ROOT>}"

if [ -d "$PI2X_ROOT/private" ]; then
  P_MODE="private"
  P_PRIVATE_DIR="$PI2X_ROOT/private"
else
  P_MODE="legacy"
  P_PRIVATE_DIR=""
fi

# 单个资源：private/ 下有就用它，否则回落旧位置
_p_resolve() {
  local rel="$1"
  if [ "$P_MODE" = "private" ] && [ -e "$P_PRIVATE_DIR/$rel" ]; then
    echo "$P_PRIVATE_DIR/$rel"
  else
    echo "$PI2X_ROOT/$rel"
  fi
}

# 目录类（即使尚未创建也按模式给出“应该在哪”）
_p_dir() {
  local rel="$1"
  if [ "$P_MODE" = "private" ]; then echo "$P_PRIVATE_DIR/$rel"; else echo "$PI2X_ROOT/$rel"; fi
}

P_LOGS_DIR="$(_p_dir logs)"
P_STATE_DIR="$(_p_dir state)"
P_SESSIONS_DIR="$(_p_dir sessions)"
P_WORKSPACE_DIR="$(_p_dir workspace)"
P_CONFIG_FILE="$(_p_resolve config.json)"
P_WHITELIST_FILE="$(_p_resolve whitelist.json)"

export PI2X_ROOT P_MODE P_PRIVATE_DIR
export P_LOGS_DIR P_STATE_DIR P_SESSIONS_DIR P_WORKSPACE_DIR
export P_CONFIG_FILE P_WHITELIST_FILE
