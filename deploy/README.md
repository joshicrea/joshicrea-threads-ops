# サーバー運用（VPS）への設置

PC を閉じている間も予約投稿・コメント返信を動かすための置き方です。1台の Ubuntu 24.04（メモリ 1GB 以上）で動きます。

## 構成

| 役割 | もの |
|---|---|
| https で受ける | Caddy（Let's Encrypt の証明書を自動取得・更新） |
| アプリ | Node.js 22 + このツール（systemd で常駐・落ちたら自動再起動） |
| データ | `/var/lib/threads-ops/`（キー・トークン・投稿。日次バックアップもここ） |
| AI | Claude Code（`claude setup-token` の長期トークンを環境変数で渡す。Claude の契約枠で動く）。Gemini / Claude API でも可 |

ローカル版との違いは4つです。画面のアクセスキーが必須で空にできない（外から開けるため）、localhost 用の自己署名 https は使わない、Threads の Redirect URI は中継ページではなく `https://<ドメイン>/oauth/callback` を直接使う、ブラウザは自動で開かない。

## 手順

1. VPS を用意し、DNS で `threads.example.com` の A レコードを VPS の IP に向ける（先に向けておくと証明書の取得が一度で通る。AAAA レコードがあるなら同じ VPS の IPv6 か、無ければ消す）
2. VPS 側で 80 番と 443 番を外から受けられるようにする（さくらの VPS はパケットフィルタで「Web」を許可、ConoHa はセキュリティグループで Web を許可、ufw を使っているなら `sudo ufw allow 80,443/tcp`）。証明書の取得に両方要ります
3. このフォルダ一式を VPS に置く（例: `scp -r Threads運用アシスタント root@<IP>:/root/`）。手元の `data/` は送らない（キー・トークンが入っている。送ってしまったら `rm -rf /root/Threads運用アシスタント/data`）
4. `sudo bash /root/Threads運用アシスタント/deploy/install.sh threads.example.com`（途中で止まったら同じコマンドをもう一度実行して構いません）
5. 画面に出たアクセスキーを控える（忘れたら `sudo grep THREADS_ACCESS_KEY /etc/threads-ops.env`）。Claude Code を使うなら、手元の PC で `claude setup-token` を実行し、出たトークンを `/etc/threads-ops.env` の `CLAUDE_CODE_OAUTH_TOKEN=` に貼って `sudo systemctl restart threads-ops`
6. Meta for Developers の Threads API 設定で、Redirect Callback URLs に `https://threads.example.com/oauth/callback`、Uninstall Callback URL に `https://threads.example.com/threads/uninstall`、Delete Callback URL に `https://threads.example.com/threads/delete` を追加（候補をクリックして確定してから保存）
7. ブラウザで `https://threads.example.com` を開く → アクセスキー → 設定タブで App ID / App Secret を入れ、Redirect URI が `https://threads.example.com/oauth/callback` になっていることを確認 → 「Threadsと連携する」

## ローカル版から引っ越す

次の順で行います。順番を変えると、稼働中のツールが古い設定のまま外に開いた状態になることがあります。

1. `sudo systemctl stop threads-ops`
2. 手元の `data/db.json` を `/var/lib/threads-ops/db.json` に上書き（例: `scp data/db.json root@<IP>:/var/lib/threads-ops/db.json`）
3. `sudo chown threads:threads /var/lib/threads-ops/db.json && sudo chmod 600 /var/lib/threads-ops/db.json`
4. `sudo systemctl start threads-ops`
5. 画面のアクセスキー: 手元で設定していればそちらが優先され、install.sh が表示したキーは使われません。手元で未設定なら install.sh のキーで開けます（起動時に環境変数から入ります）
6. Redirect URI は起動時に `https://threads.example.com/oauth/callback` へ自動で置き換わるので、設定タブで確認して「Threadsと連携する」をやり直す

別の VPS へ移すときは `/var/lib/threads-ops/` と `/etc/threads-ops.env` を丸ごと新しい VPS の同じ場所に置き（所有者と権限も同じに）、install.sh を実行します（env が既にあれば install.sh は生成しません）。

## 運用

| したいこと | コマンド |
|---|---|
| 状態を見る | `systemctl status threads-ops` |
| ログを見る | `journalctl -u threads-ops -n 100 -f`、失敗の記録は `/var/lib/threads-ops/server-error.log` |
| 再起動 | `sudo systemctl restart threads-ops` |
| 更新 | 新しいフォルダを置いて `sudo bash /opt/threads-ops/deploy/update.sh <新しいフォルダ>` |
| アクセスキーを変える | 画面の設定「4. 運用」で変更（環境変数の値は初回だけ使われる。空にはできない） |
| アクセスキーを確認する | `sudo grep THREADS_ACCESS_KEY /etc/threads-ops.env`（画面で変えていればそちらが優先） |
| Claude Code のトークンを更新する（失効時。画面に「トークンが無効か期限切れ」と出る） | 手元の PC で `claude setup-token` → `/etc/threads-ops.env` の `CLAUDE_CODE_OAUTH_TOKEN=` を書き換え → `sudo systemctl restart threads-ops` |
| バックアップを外へ | `/var/lib/threads-ops/backups/` をコピー |
| 撤去する | `sudo systemctl disable --now threads-ops && sudo rm -rf /opt/threads-ops /var/lib/threads-ops /etc/threads-ops.env /etc/systemd/system/threads-ops.service && sudo systemctl daemon-reload`（Caddy の設定も戻す） |

## 安全のための決まり

- アプリ自体は 127.0.0.1:4173 でしか待ち受けない。外から届くのは Caddy の https だけ
- アクセスキー無しでは起動しない（環境変数か設定に無いとエラーで止まる）。稼働中にキーが消えた場合も、API は 503 で閉じる。画面からキーを空にはできない
- 設定ミス（トークン不正等）で起動に失敗すると 5 秒ごとに再起動を繰り返す。`journalctl -u threads-ops -n 50` で原因を見て、`/etc/threads-ops.env` を直す
- `/etc/threads-ops.env` は root の 600。`/var/lib/threads-ops` は threads ユーザーの 700
- systemd の `ProtectSystem=strict` で、データ置き場とホーム以外には書けない
