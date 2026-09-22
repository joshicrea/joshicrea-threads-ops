# relay/ — Meta が localhost を受け付けないときの転送ページ

Meta の Threads API 設定（Redirect Callback URLs / Uninstall / Delete）は `localhost` の URL を保存できない（2026-09-20 実測: https://localhost:4174 でも「フォームを保存できません」）。
このフォルダの4ファイルを自分の公開ドメイン（https 必須）に置き、Meta にはそのURLを登録する。

| ファイル | 置き先の例 | Meta の欄 | 役割 |
|---|---|---|---|
| callback.html | https://bizcrea.com/threads/callback.html | Redirect Callback URLs | code と state をそのまま http://localhost:4173/oauth/callback に転送する |
| uninstall.php | https://bizcrea.com/threads/uninstall.php | Uninstall Callback URL | 200 を返すだけ |
| delete.php | https://bizcrea.com/threads/delete.php | Delete Callback URL | 確認コードを返す（Meta の仕様） |
| deleted.html | (delete.php が返すURL) | — | 削除受付の表示 |

置いたら、ツールの設定画面「Threads連携」の Redirect URI を同じURL（例: https://bizcrea.com/threads/callback.html）にして保存する。
認可コードの交換時にツールがこの値を Meta へ送るので、Meta に登録した文字列と一致している必要がある。

転送先ポートを変えている場合は callback.html の `4173` を書き換える。
