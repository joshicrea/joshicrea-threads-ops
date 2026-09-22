---
name: threads-ops
description: Threads運用アシスタントの日常操作。投稿案の生成と承認、コメントの確認と返信、実績の確認と改善提案を MCP ツール threads_* で行う。利用者が「投稿案を作って」「承認待ちを見せて」「コメントを見て」「返信して」「反応はどう」「予約して」「今すぐ投稿して」と言ったときに使う。
---

# 日常操作

前提: `threads_status` で本体に接続できていること。承認・公開・返信の送信は、利用者が本文を見て明示したときだけ行う（CLAUDE.md の決まり）。

## A. 投稿案を作る

1. 目的（例: 認知・信頼・申込）とテーマを1問ずつ聞く。両方言われていれば聞かない。本数は指定がなければ8
2. `threads_generate_posts`（goal, topic, count, date）
3. 結果を「番号・カテゴリ・冒頭30字」で一覧にし、「全文を見たい番号」「承認する番号」「直したい番号」を聞く
4. 承認 → `threads_post_action` action=approve（番号ごとに id を対応させる）。却下 → reject。修正 → 直した本文を見せて了承を得てから `threads_edit_post`
5. 承認済みを予約するか聞く。予約 → `threads_post_action` action=schedule（日時指定があれば scheduledAt を ISO 8601・日本時間で）。「今すぐ」→ 本文を再掲して確認を取ってから `threads_publish_now`

予約投稿が実際に送られるのは、設定「予約投稿の自動送信」が ON で、本体が動いている時刻だけ。OFF なら「予約しましたが自動送信は OFF です。ON にしますか」と聞く。

## B. コメント対応

1. `threads_fetch_replies` → `threads_list_replies`（status 指定なし）で件数を伝える
2. 未対応があれば `threads_draft_replies`。結果を「返信する n 件・要確認 m 件」で伝える
3. 下書きあり（drafted）は、相手のコメントと下書きを対で見せる。自動返信 ON なら「裏で順に送られます。止めたいものがあれば番号を」と伝える。OFF なら「送る番号を」と聞き、指示があったものだけ `threads_reply`
4. 要確認（held）は holdReason を添えて見せ、返信文の提案は出してよいが、送るのは利用者の指示があってから。対応しないなら `threads_set_reply` status=ignored
5. 相手をユーザー名で呼ぶ書き方はしない（本体の下書きも同じ決まり）

## C. 実績と改善

1. `threads_insights`（refresh=true）→ 閲覧・いいね・返信の上位3件と、カテゴリ別・時間帯別の傾向を3行で
2. インサイト付きの公開投稿が3件以上なら `threads_suggestions` を提案。結果の nextTopics を「次の投稿案に使いますか」とつなぐ
3. 公開24時間未満の投稿は数字が育っていないので、本体が平均と下位の集計から外している。その旨を一言添える

## D. 設定

- `threads_get_settings` で現状を見せてから、変える項目だけ `threads_update_settings`
- 自動返信・予約投稿の自動送信を ON にするときは「自動で外に出る」ことを一言添えてから
- Threads 連携・キー・アクセスキーは画面（http://localhost:4173 の設定タブ）で。値はチャットで受け取らない

## E. よくある状況

| 状況 | 対応 |
|---|---|
| 本体に接続できない | 「`~/.claude/threads-ops/app/起動.cmd`（Mac は `起動.command`）をダブルクリック」か「PC を再起動」。自分では起動しない |
| threads.expired が true | 画面の設定タブで「Threadsと連携する」を押し直してもらう。それまで予約投稿とコメント処理は止まっている |
| 投稿がエラー | error の原文を短く見せ、「承認し直して今すぐ投稿」か「本文を直す」かを聞く。本体は同じ本文が既に出ていれば送らずに公開済みに直す |
| AI の利用上限 | 時間をおいて再実行。プロバイダの切り替えは画面で |
| 「今日の予定は」 | `threads_list_posts` status=scheduled を日時順で |
