# CHANGELOG

## 0.3.1 (2026-09-22)
- 破壊検証（プラグイン配布）の致命傷5件を修正
  - 停止.cmd がプラグイン配置（`~/.claude/threads-ops/data`）の server.pid を見ていなかった → `stop.ps1` が threads-ops.env の THREADS_DATA_DIR を読む。install.ps1 は更新時に旧版を止めてから新版を起動し、自動起動タスクの登録を実測で確認
  - アンインストールが JSON 手編集前提だった → `アンインストール.cmd`（`uninstall.ps1`）／Mac は `アンインストール.command`（`uninstall.py`）で、自動起動の解除・停止・登録の削除・フォルダ削除まで自動
  - Node.js 無し PC: UAC の案内・winget の失敗理由を表示・ターミナルごとの再起動を案内。README とテンプレに許可プロンプトと所要時間を追記
  - Mac: zip 展開で落ちる hooks の実行ビットを付け直す。launchd の KeepAlive を異常終了時だけに変更（停止.command が効く）
  - threads-setup の連携手順を App ID / App Secret → 認可 URL の順に。テンプレ「販売者側の作業」に App ID / App Secret の送付を追加
- MCP: `threads_update_settings` は許可キーだけを本体へ送る（accessKey・トークン・API キーを混ぜても保存しない）。protocolVersion は固定。バッチ要求は -32600 で返す。起動案内は OS 別
- install.ps1 / install.py が `.mcp.json` の node をフルパスに書き換える（GUI 起動の Claude Code で PATH に node が無くても動く）。日本語名の .cmd は install.ps1 が生成（ZIP の文字コードに依存しない）
- アンインストール.cmd をダブルクリックした経路（消す側の cwd が app 内）でもフォルダが消えるよう、uninstall.ps1 と cmd が cwd を %TEMP% へ移してから削除する（破壊68）
- テスト追加: アンインストール.cmd をダブルクリックと同じ経路で通してフォルダ・登録・タスクが残らないこと、MCP の設定ホワイトリスト・protocolVersion・バッチ、stop.ps1 の env 経由 pid 解決（実行）、配布スクリプトの静的検査（BOM・Read-Host 無し・必須記述）

## 0.3.0 (2026-09-22)
- Claude Code プラグイン化: 1行貼るだけのインストール（install.ps1 / install.py）、本体を `~/.claude/threads-ops/app` に配置しデータを分離、ログオン時の自動起動を登録
- MCP サーバー同梱（mcp/server.mjs・外部依存なし）: チャットから状態確認・投稿生成・承認・予約・公開・コメント取得・下書き・返信・分析・設定変更ができる。公開と返信は利用者の明示があるときだけ
- SessionStart フックで操作指示（CLAUDE.md）と本体の生死・セットアップ状況を注入。スキル threads-setup / threads-ops
- start.js が同じフォルダの threads-ops.env を読む（データの置き場所などを渡せる）

## 0.2.0 (2026-09-21)
- 4本の破壊検証の致命傷を修正: アクセスキー・shell 注入の廃止・公開の永続化と中断からの復旧・db.json のバックアップと復旧・停止.cmd・配布用 ZIP・受け取り手向け README
- サーバー運用（VPS 常時稼働）対応: THREADS_PUBLIC_ORIGIN・アクセスキー必須・deploy/ 一式

## 0.1.0 (2026-09-19)
- 初版（承認制ダッシュボード・Claude Code / Codex / Gemini / Claude API・コメント自動処理・Web検索経由の参考投稿）
