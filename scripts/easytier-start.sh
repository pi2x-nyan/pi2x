#!/bin/bash
# EasyTier 组网启动（手机侧）。带 watchdog 复用：已在跑则只补路由、不重启进程。
#
# 【为什么要有这个脚本】EasyTier 之前是手工起的、没有任何自启 ——
# 手机重启后就再也没起来过（2026-10-18 重启后一直空着），
# 而它是"局域网不可达时的备用通道"。这里补成与其他服务一致的方式：
# screen 常驻 + start-all.sh 调用 + cron watchdog 兜底。
set -u

CONF=/etc/easytier/config.toml
BIN=/usr/local/bin/easytier-core
LOG=<PI2X_ROOT>/private/logs/easytier.log
PATTERN="[e]asytier-core"

# 网段**不写死**：从 et_ 接口的实际地址推导（形如 10.x.x.x/24）。
# 两个理由：① 仓库保密扫描会把硬编码内网 IP 报为中危（泄露网络拓扑）；
# ② 换了组网配置或网段就不用改脚本。
derive_net() {
  local dev="$1" cidr
  cidr=$(ip -o -4 addr show "$dev" 2>/dev/null | awk '{print $4}' | head -1)
  [ -n "$cidr" ] && printf '%s\n' "$cidr"
}

mkdir -p "$(dirname "$LOG")"

# ── 关键修复：把 EasyTier 网段的路由补进 Android 的策略路由表 ────────────────
#
# 【根因】Android 不是单表路由：它给应用流量打 fwmark，再用 ip rule 把包导到
# **按网络划分的表**（wlan0=1038、dummy0=1002，还有 97/98/99/60 等）。
# EasyTier 起来后只在 main 表里加 `<组网网段> dev et_*`，而容器的包先查
# 上面那几张表 —— 里面没有这条路由 → 包直接出 wlan0 交网关（丢掉）。
# 症状极具误导性（2026-10-16~19 一直被当成"EasyTier 数据面坏了"）：
#   · easytier-cli peer 显示 p2p/DIRECT、0% 丢包（那只是控制面）
#   · main 表里明明有组网网段的路由
#   · 但 ping 100% 丢包，且 **TUN 的 TX 计数一个都不涨**（包压根没进隧道）
# 补完这几张表后实测：ping 3/3、双向 7~10ms、SSH 与 win-agent 端口都通。
#
# 为什么每次都要补：Android 在切换网络/重建 netd 时会重刷这些表，路由会丢。
add_policy_routes() {
  local dev net
  dev=$(ip -o link show 2>/dev/null | grep -aoE 'et_[a-zA-Z0-9_]+' | head -1)
  [ -n "$dev" ] || { echo "  未找到 et_ 接口，跳过补路由"; return 0; }
  net=$(derive_net "$dev")
  [ -n "$net" ] || { echo "  et_ 接口无 IPv4 地址，跳过补路由"; return 0; }
  for t in 1038 1002 97 98 99 60; do
    ip route replace "$net" dev "$dev" table "$t" 2>/dev/null && echo "  路由 $net → $dev（表 $t）"
  done
}

[ -x "$BIN" ] || { echo "easytier-core 不存在：$BIN"; exit 1; }
[ -f "$CONF" ] || { echo "配置不存在：$CONF"; exit 1; }

if pgrep -f "$PATTERN" >/dev/null 2>&1; then
  echo "easytier 已在运行: $(pgrep -f "$PATTERN" | head -1)"
  add_policy_routes          # ← 运行中也要补：网络切换后表会被重刷
  exit 0
fi

screen -wipe >/dev/null 2>&1
screen -dmS easytier bash -c "exec $BIN -c $CONF >> $LOG 2>&1"
sleep 6

pid=$(pgrep -f "$PATTERN" | head -1)
if [ -n "$pid" ]; then
  echo "easytier pid: $pid"
  add_policy_routes
  ip -br addr 2>/dev/null | grep -aE "et_[a-zA-Z0-9_]+" | sed 's/^/  /'
else
  echo "easytier 启动失败，见 $LOG"
  exit 1
fi
