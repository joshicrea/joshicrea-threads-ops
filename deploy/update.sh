#!/usr/bin/env bash
# 更新: 新しいバージョンのフォルダを /opt/threads-ops に反映して再起動する（root で実行）。データは /var/lib/threads-ops にあるので触らない。
# 使い方: sudo bash update.sh /path/to/new-version
set -euo pipefail
SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -f "$SRC/server.js" ]; then echo "使い方: sudo bash update.sh <新しいバージョンのフォルダ>"; exit 1; fi
rsync -a --delete --exclude data --exclude test --exclude .git --exclude "Meta審査申請" "$SRC"/ /opt/threads-ops/
chown -R root:root /opt/threads-ops
chmod -R u=rwX,go=rX /opt/threads-ops
if ! cmp -s /opt/threads-ops/deploy/threads-ops.service /etc/systemd/system/threads-ops.service; then
  cp /opt/threads-ops/deploy/threads-ops.service /etc/systemd/system/threads-ops.service
  systemctl daemon-reload
fi
systemctl restart threads-ops
sleep 3
systemctl is-active --quiet threads-ops || { journalctl -u threads-ops -n 30 --no-pager; echo "起動していません"; exit 1; }
echo "更新しました: $(grep '"version"' /opt/threads-ops/package.json)"
