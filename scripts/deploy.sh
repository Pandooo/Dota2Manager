#!/usr/bin/env bash
# 一键部署 / 更新远程服务器上的多人服务器。
#
# 用法：
#   scripts/deploy.sh user@host            # 同步当前工作目录的源码 → 服务器安装依赖、构建前端、重启 systemd 服务
#   scripts/deploy.sh user@host --no-build # 只同步与重启（服务器上已有 dist/）
#
# 服务器端约定（首次部署前手工准备一次，见 docs/MULTIPLAYER.md「部署到公网服务器」）：
#   - 已安装 Node.js 20+（node / npm 在 PATH 中），已创建系统用户 d2m；
#   - 应用目录 /opt/dota2manager（属主 d2m），房间存档目录 /opt/dota2manager-data（属主 d2m）；
#   - systemd 单元 deploy/dota2manager.service 由本脚本安装 / 更新（v0.4 起监听 80 端口，云服务器安全组需放行 TCP 80，
#     且服务器上不能有其他程序占用 80 端口，如 nginx / apache）。
#
# 不会上传：node_modules、dist、server-data、.git、本地美术覆盖 public/local/*（只上传其中的 README.txt）等本地产物。
set -euo pipefail

HOST="${1:-}"
if [[ -z "$HOST" ]]; then
  echo "用法：scripts/deploy.sh user@host [--no-build]" >&2
  exit 1
fi
shift
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "未知参数：$arg" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/dota2manager
REGISTRY=https://registry.npmmirror.com

echo "== 同步源码到 $HOST:$APP_DIR"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude server-data --exclude '.npm' \
  --exclude .git --exclude .claude --exclude .idea --exclude .vscode --exclude .vite --exclude coverage \
  --exclude '*.log' --exclude '*.tsbuildinfo' --exclude .DS_Store \
  --include 'public/local/README.txt' --exclude 'public/local/*' \
  "$ROOT"/ "$HOST:$APP_DIR/"

echo "== 服务器端：安装依赖$([[ $BUILD == 1 ]] && echo '、构建前端')、安装并重启服务"
# macOS 自带的 rsync 不支持 --chown，属主在服务器端统一修正
ssh "$HOST" "set -euo pipefail
  chown -R d2m:d2m $APP_DIR
  install -m 644 $APP_DIR/deploy/dota2manager.service /etc/systemd/system/dota2manager.service
  systemctl daemon-reload
  runuser -u d2m -- env HOME=$APP_DIR npm ci --no-audit --no-fund --registry=$REGISTRY --prefix $APP_DIR
  if [[ $BUILD == 1 ]]; then
    (cd $APP_DIR && runuser -u d2m -- env HOME=$APP_DIR npx vite build)
  fi
  systemctl enable --now dota2manager >/dev/null
  systemctl restart dota2manager
  sleep 2
  systemctl --no-pager --lines=5 status dota2manager || true
"

echo "== 完成。浏览器打开 http://<服务器地址>/ 即可进入（80 端口，不用写端口号）。"
