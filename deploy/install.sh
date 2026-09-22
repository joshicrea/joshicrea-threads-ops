#!/usr/bin/env bash
# Threads運用アシスタントを Ubuntu 24.04 の VPS に入れる（root で実行・途中で止まったら同じコマンドを再実行してよい）。
# 使い方: sudo bash install.sh threads.example.com
# やること: Node.js 22 / Caddy / Claude Code の導入、専用ユーザー、/opt/threads-ops への配置、systemd 登録。
set -euo pipefail
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "使い方: sudo bash install.sh <公開ドメイン>（例: threads.example.com）"; exit 1; fi
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== 1/6 パッケージ"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update -y
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring openssl rsync
NODE_MAJOR="$( (node -v 2>/dev/null || echo v0) | sed -E 's/^v([0-9]+).*/\1/')"
if [ ! -x /usr/bin/node ] || [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "== 2/6 専用ユーザーと置き場所"
id -u threads >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin threads
mkdir -p /opt/threads-ops /var/lib/threads-ops
rsync -a --delete --exclude data --exclude test --exclude .git --exclude "Meta審査申請" "$SRC_DIR"/ /opt/threads-ops/
chown -R root:root /opt/threads-ops
chmod -R u=rwX,go=rX /opt/threads-ops
chown -R threads:threads /var/lib/threads-ops
chmod 700 /var/lib/threads-ops

echo "== 3/6 Claude Code（threads ユーザーで動く）"
if ! sudo -u threads -H bash -lc 'command -v claude || test -x "$HOME/.local/bin/claude"' >/dev/null 2>&1; then
  sudo -u threads -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash' || echo "Claude Code の導入に失敗しました。あとで threads ユーザーで入れ直してください（Gemini / Claude API を使う場合は不要）"
fi

echo "== 4/6 環境変数"
if [ ! -f /etc/threads-ops.env ]; then
  KEY="$(openssl rand -hex 16)"
  sed -e "s#https://threads.example.com#https://$DOMAIN#" -e "s#change-me-to-a-long-random-string#$KEY#" "$SRC_DIR/deploy/threads-ops.env.example" > /etc/threads-ops.env
  chmod 600 /etc/threads-ops.env
  echo "アクセスキーを生成しました（画面を開くときに要ります。忘れたら: sudo grep THREADS_ACCESS_KEY /etc/threads-ops.env）: $KEY"
  echo "Claude Code を使う場合は /etc/threads-ops.env の CLAUDE_CODE_OAUTH_TOKEN に、手元の PC で claude setup-token を実行して出た値を入れてください"
else
  echo "/etc/threads-ops.env は既にあるので変更しません"
fi

echo "== 5/6 Caddy（https）"
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "reverse_proxy 127.0.0.1:4173" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  echo "既存の /etc/caddy/Caddyfile を退避しました（別サイトの設定があれば手で統合してください）"
fi
sed -e "s#threads.example.com#$DOMAIN#" "$SRC_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl enable --now caddy; fi

echo "== 6/6 systemd"
cp "$SRC_DIR/deploy/threads-ops.service" /etc/systemd/system/threads-ops.service
systemctl daemon-reload
systemctl enable --now threads-ops
sleep 3
if ! systemctl is-active --quiet threads-ops; then
  journalctl -u threads-ops -n 30 --no-pager
  echo "threads-ops が起動していません。上のログを確認してください。"
  exit 1
fi
echo
echo "完了。ブラウザで https://$DOMAIN を開き、アクセスキーを入れてください。"
echo "アクセスキーを忘れたら: sudo grep THREADS_ACCESS_KEY /etc/threads-ops.env"
echo "更新するときは、新しいファイルを置いて sudo bash /opt/threads-ops/deploy/update.sh <新しいフォルダ> を実行します。"
