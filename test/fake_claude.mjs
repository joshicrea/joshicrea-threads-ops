// テスト用の偽 Claude Code CLI。stdin のプロンプトと引数を見て、`claude -p --output-format json` と同じ形で返す。
// 実行環境: クロスプラットフォーム（Node.js 20以上）。smoke.test.mjs から THREADS_CLAUDE_CMD で指定される。
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const systemIdx = args.indexOf("--system-prompt");
const system = systemIdx >= 0 ? args[systemIdx + 1] : "";
const model = args[args.indexOf("--model") + 1] || "";

let payload;
if (process.env.FAKE_CLAUDE_MODE === "not-logged-in") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }));
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_MODE === "mentions-limit") {
  payload = JSON.stringify({ ok: true, greeting: "rate limit と /login の話" });
} else if (process.env.FAKE_CLAUDE_MODE === "prose") {
  payload = "了解しました。以下がJSONです。\n```json\n" + JSON.stringify({ ok: true, greeting: "こんにちは" }) + "\n```";
} else if (/"decision"/.test(system)) {
  // まとめ判定: プロンプトの id を拾い、コメントに「クレーム」を含むものだけ hold
  const blocks = [...prompt.matchAll(/- id: (\S+)\n[^\n]*\n\s+コメント: ([^\n]*)/g)];
  const mode = process.env.FAKE_BATCH_MODE || "";
  if (mode === "badjson") {
    payload = "了解しました。判定は次のとおりです（JSONではない）";
  } else {
    const rows = blocks.map((m) => (/クレーム|返金/.test(m[2])
      ? { id: m[1], quote: m[2].slice(0, 12), decision: "hold", reason: "クレームのため人が確認" }
      : { id: m[1], quote: m[2].slice(0, 12), decision: "reply", text: `自動下書き: ${m[2].slice(0, 20)}` }));
    if (mode === "swap" && rows.length >= 2) {
      // id を取り違えた応答: id だけ入れ替える（quote と text は元のまま）
      [rows[0].id, rows[1].id] = [rows[1].id, rows[0].id];
    }
    if (mode === "object-text") rows.forEach((r) => { if (r.decision === "reply") r.text = { a: 1 }; });
    if (mode === "url-text") rows.forEach((r) => { if (r.decision === "reply") r.text = "詳しくは https://example.com を見てください"; });
    if (mode === "san-text") rows.forEach((r) => { if (r.decision === "reply") r.text = "fan2さんの言うとおりだと思います。"; });
    if (mode === "bracket-quote") rows.forEach((r) => { r.quote = `「${r.quote}」`; });
    payload = JSON.stringify({ replies: rows });
  }
} else if (/"likes"/.test(system)) {
  // Threads 公開投稿の Web 探索: 有効URL1件・プロフィールURL1件（除外）・重複1件（除外）
  payload = JSON.stringify({ posts: [
    { url: "https://www.threads.com/@maker1/post/ABC123xyz/%E3%83%8F%E3%83%B3", username: "@maker1", text: "委託販売先の探し方", likes: 70, replies: 34, timestamp: "2025-01-28" },
    { url: "https://www.threads.com/@maker2", username: "maker2", text: "プロフィール", likes: 1 },
    { url: "https://www.threads.com/@maker1/post/ABC123xyz", username: "maker1", text: "重複", likes: 70 }
  ] });
} else if (/"posts"/.test(system)) {
  payload = JSON.stringify({ posts: [{ category: "Tips", text: `Claude生成: ${prompt.slice(0, 20).replace(/\s+/g, " ")}` }], strategyMemo: "claude memo" });
} else if (/"sources"/.test(system)) {
  payload = JSON.stringify({ summary: "検索要約", sources: [{ title: "記事", url: "https://example.com/c" }, { title: "危険", url: "javascript:alert(1)" }] });
} else if (/"greeting"/.test(system)) {
  payload = JSON.stringify({ ok: true, greeting: "こんにちは" });
} else {
  payload = JSON.stringify({ text: "claude返信" });
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: payload, model, usage: { input_tokens: 10, output_tokens: 5 } }) + "\n");
