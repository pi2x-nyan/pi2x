#!/bin/bash
# dialog 沙盒专用网络：独立 netns（只能连到出口代理），公网放行、内网不可达
#
# 拓扑：
#   netns dlgnet (10.200.200.2)  --veth--  主机 (10.200.200.1)  [dlg-proxy:3128]
#   ip_forward=0 → 沙盒除了代理什么都连不上（内网/本机端口一律不可达）
#
# 用法：dlg-net.sh {up|down|status}
set -uo pipefail

NS=dlgnet
HOST_VETH=vdlg0
NS_VETH=vdlg1
HOST_IP=10.200.200.1
NS_IP=10.200.200.2
PREFIX=24
PROXY_PORT=3128
# 用绝对路径：bwrap 里 PATH 可能不全
IP=$(command -v ip || echo /usr/sbin/ip)

status() {
  if $IP netns list 2>/dev/null | grep -qw "$NS"; then
    echo "netns: up"
  else
    echo "netns: down"
  fi
  if pgrep -f "node .*dlg-proxy\.mjs" >/dev/null 2>&1; then
    echo "proxy: up"
  else
    echo "proxy: down"
  fi
}

up() {
  # 1) netns
  if ! $IP netns list 2>/dev/null | grep -qw "$NS"; then
    $IP netns add "$NS" || { echo "netns add 失败"; return 1; }
  fi
  # 2) veth
  if ! $IP link show "$HOST_VETH" >/dev/null 2>&1; then
    $IP link add "$HOST_VETH" type veth peer name "$NS_VETH" || { echo "veth 创建失败"; return 1; }
    $IP link set "$NS_VETH" netns "$NS"
  fi
  # 3) 地址与路由
  $IP addr replace "$HOST_IP/$PREFIX" dev "$HOST_VETH" 2>/dev/null
  $IP link set "$HOST_VETH" up 2>/dev/null
  $IP netns exec "$NS" $IP addr replace "$NS_IP/$PREFIX" dev "$NS_VETH" 2>/dev/null
  $IP netns exec "$NS" $IP link set "$NS_VETH" up 2>/dev/null
  $IP netns exec "$NS" $IP link set lo up 2>/dev/null
  # 只留一条到代理的主机路由，不设默认路由：
  # 这样沙盒除了代理以外什么都不可达（内网、公网直连一律 网络不可达），
  # 公网访问必须经代理，过滤点唯一。
  $IP netns exec "$NS" $IP route flush default 2>/dev/null
  $IP netns exec "$NS" $IP route replace "$HOST_IP/32" dev "$NS_VETH" 2>/dev/null
  # 3.5) 回程策略路由：本机有 ip rule 把 10.x 指向别的表，需给本网段钉一条 main 表规则
  $IP rule del to 10.200.200.0/24 lookup main 2>/dev/null
  $IP rule add to 10.200.200.0/24 lookup main priority 1000 2>/dev/null
  # 4) 不转发（本机没有 sysctl 命令，直接写 proc）
  echo 0 > /proc/sys/net/ipv4/ip_forward 2>/dev/null
  # 5) 出口代理
  if ! pgrep -f "node .*dlg-proxy\.mjs" >/dev/null 2>&1; then
    ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    LOG_DIR="${PI2X_LOG_DIR:-$ROOT_DIR/private/logs}"
    mkdir -p "$LOG_DIR"
    # setsid：脱离当前进程组，否则父 shell 退出时会被一并收掉（实测踩过）
    DLG_PROXY_HOST=$HOST_IP DLG_PROXY_PORT=$PROXY_PORT \
      setsid nohup node "$ROOT_DIR/scripts/dlg-proxy.mjs" >>"$LOG_DIR/dlg-proxy.log" 2>&1 < /dev/null &
    sleep 0.8
  fi
  status
}

down() {
  pkill -f "node .*dlg-proxy\.mjs" 2>/dev/null
  if $IP netns list 2>/dev/null | grep -qw "$NS"; then
    $IP netns del "$NS" 2>/dev/null
  fi
  $IP link del "$HOST_VETH" 2>/dev/null
  echo "已清理"
}

case "${1:-status}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "用法: $0 {up|down|status}"; exit 2 ;;
esac
