// テスト用の偽 Codex CLI。`codex exec --output-schema <file> -o <file> -` と同じ引数を受け、スキーマを見て JSON を出力ファイルに書く。
// 実行環境: クロスプラットフォーム（Node.js 20以上）。smoke.test.mjs から THREADS_CODEX_CMD で指定される。
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const schemaPath = args[args.indexOf("--output-schema") + 1];
const outPath = args[args.indexOf("-o") + 1];
const schema = readFileSync(schemaPath, "utf8");
const search = args.includes("--search");

if (process.env.FAKE_CODEX_MODE === "not-logged-in") {
  process.stderr.write("Error: not logged in. Run `codex login`.\n");
  process.exit(1);
}
if (!process.env.CODEX_HOME || process.env.CODEX_HOME.includes(".codex")) {
  process.stderr.write("CODEX_HOME must point to the tool's dedicated folder\n");
  process.exit(1);
}
let payload;
if (/"likes"/.test(schema)) {
  payload = { posts: [{ url: "https://www.threads.com/@codexmaker/post/XYZ789/", username: "codexmaker", text: "Codex経由の投稿", likes: 12, replies: 3, timestamp: "2026-09-01" }] };
} else if (/"posts"/.test(schema)) {
  payload = { posts: [{ category: "Tips", text: `Codex生成: ${prompt.slice(-20).replace(/\s+/g, " ")}` }], strategyMemo: "codex memo" };
} else if (/"sources"/.test(schema)) {
  payload = { summary: search ? "検索要約(codex)" : "検索なし", sources: [{ title: "記事", url: "https://example.com/codex" }] };
} else if (/"greeting"/.test(schema)) {
  payload = { ok: true, greeting: "こんにちは(codex)" };
} else {
  payload = { text: "codex返信" };
}
writeFileSync(outPath, JSON.stringify(payload), "utf8");
process.stderr.write("tokens used\n22563\n");
