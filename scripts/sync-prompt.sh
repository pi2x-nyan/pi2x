#!/usr/bin/env bash
# 把本项目 prompt/ 提示词目录同步到 Linux 服务器（PI2X 运行端）
# 用法: bash scripts/sync-prompt.sh  [可选: host]
# 说明: 用 scp -r 覆盖同步，删除服务器端 prompt/.git，并抽样 md5 校验。

set -e
cd "$(dirname "$0")/.."   # 项目根 <PI2X_ROOT_WIN>

HOST="${1:-${PI2X_SYNC_HOST:-}}"
[ -z "$HOST" ] && { echo "用法: $0 <user@host>，或设置 PI2X_SYNC_HOST"; exit 2; }
KEY="${2:-$HOME/.ssh/id_ed25519_22041211AC}"
REMOTE=<PI2X_ROOT>/prompt

echo "==> 1/4 清空服务器端 prompt/（避免残留）"
ssh -i "$KEY" -o ConnectTimeout=10 "$HOST" "rm -rf $REMOTE" || { echo "✗ 清空失败"; exit 1; }

echo "==> 2/4 scp -r 覆盖同步本地 prompt/ → 服务器"
scp -i "$KEY" -r prompt "$HOST:<PI2X_ROOT>/" || { echo "✗ 同步失败"; exit 1; }

echo "==> 3/4 删除服务器端 prompt/.git（仅保留提示词文件）"
ssh -i "$KEY" -o ConnectTimeout=10 "$HOST" "rm -rf $REMOTE/.git"

echo "==> 4/4 抽样 md5 校验"
FILES=(agent/system.md reviewer/system.md reviewer/input.md \
       context/session.md risk/note.md skills/qq-bot/SKILL.md \
       tools/deop.md tools/group_history.md tools/napcat_call.md)
OK=1
for f in "${FILES[@]}"; do
  l=$(md5sum "prompt/$f" 2>/dev/null | awk '{print $1}')
  r=$(ssh -i "$KEY" -o ConnectTimeout=10 "$HOST" "md5sum $REMOTE/$f" 2>/dev/null | awk '{print $1}')
  if [ "$l" = "$r" ]; then echo "  ✓ $f"; else echo "  ✗ 差异 $f"; OK=0; fi
done

echo "==> 同步完成 . 文件数: $(find prompt -type f -not -path '*/.git/*' | wc -l | tr -d ' ')"
[ "$OK" = "1" ] && echo "✅ 全部一致" || echo "⚠️ 存在差异，请检查上面 ✗ 项"
