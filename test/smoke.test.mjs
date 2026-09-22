// 実行環境: クロスプラットフォーム（Node.js 20以上）
// 実行: npm test
// 外部API（Gemini / Threads）は globalThis.fetch を差し替えて模擬する。localhost向けだけ本物のfetchを通す。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "threads-ops-test-"));
process.env.THREADS_DATA_DIR = dataDir;
process.env.THREADS_CLAUDE_CMD = `node ${fileURLToPath(new URL("./fake_claude.mjs", import.meta.url))}`;
process.env.THREADS_CODEX_CMD = fileURLToPath(new URL("./fake_codex.mjs", import.meta.url));
const PORT = 4199;
const BASE = `http://localhost:${PORT}`;

const realFetch = globalThis.fetch;
const calls = [];
let geminiFailOnce = false;

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("localhost")) return realFetch(input, init);
  calls.push({ url, method: init.method || "GET", body: init.body || "" });

  if (url.includes("generativelanguage.googleapis.com")) {
    if (url.includes("/models?")) {
      return jsonRes(200, { models: [
        { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.0-flash-lite-preview", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] }
      ] });
    }
    if (geminiFailOnce) {
      geminiFailOnce = false;
      return jsonRes(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.1s" }] } });
    }
    const body = JSON.parse(init.body);
    const schema = body.generationConfig?.responseSchema;
    let payload;
    if (!schema) {
      return jsonRes(200, { candidates: [{ content: { parts: [{ text: "要点まとめ" }] }, groundingMetadata: { groundingChunks: [
        { web: { uri: "https://example.com/a", title: "記事A" } }, { web: { uri: "https://example.com/a", title: "記事A重複" } }, { web: { uri: "https://example.com/b", title: "記事B" } }
      ] } }] });
    }
    const props = Object.keys(schema.properties);
    if (props.includes("posts")) payload = { posts: Array.from({ length: 3 }, (_, i) => ({ category: ["Tips", "失敗談", "問いかけ"][i], text: `投稿${i + 1}`, scheduledAt: "2000-01-01T00:00:00Z" })), strategyMemo: "メモ" };
    else if (props.includes("items")) {
      const ids = [...body.contents[0].parts[0].text.matchAll(/\[(ref_[^\]]+)\]/g)].map((m) => m[1]);
      payload = { items: ids.map((id) => ({ id, hook: "h", structure: "s", whyItWorks: "w", howToAdapt: "a" })), commonPatterns: "共通" };
    } else if (props.includes("doMore")) payload = { summary: "要約", doMore: ["a"], avoid: ["b"], nextTopics: ["t1"], styleNotes: ["s"] };
    else payload = { text: "返信下書き" };
    return jsonRes(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }] });
  }

  if (url.includes("graph.threads.net")) {
    const u = new URL(url);
    if (u.pathname.endsWith("/me/threads") && (init.method || "GET") === "GET") {
      // 直近の自分の投稿一覧（復旧・二重投稿検査用）。FAKE_RECENT_TEXT に一致する本文があれば1件返す
      return jsonRes(200, { data: process.env.FAKE_RECENT_TEXT ? [{ id: "recent1", text: process.env.FAKE_RECENT_TEXT, permalink: "https://www.threads.net/@me/post/recent1", timestamp: new Date().toISOString() }] : [] });
    }
    if (u.pathname.endsWith("/me/threads")) return jsonRes(200, { id: "container1" });
    if (u.pathname === "/v1.0/container1" && u.searchParams.get("fields")?.includes("status")) return jsonRes(200, { id: "container1", status: process.env.FAKE_CONTAINER_STATUS || "FINISHED", permalink: "https://www.threads.net/@me/post/c1" });
    if (u.pathname.endsWith("/me/threads_publish") && process.env.FAKE_PUBLISH_429 === "1") return jsonRes(429, { error: { message: "Application request limit reached", code: 4 } });
    if (u.pathname.endsWith("/me/threads_publish")) {
      if (publishDelayMs) await new Promise((r) => setTimeout(r, publishDelayMs));
      return jsonRes(200, { id: "thread1" });
    }
    if (u.pathname === "/v1.0/thread1" ) return jsonRes(200, { id: "thread1", permalink: "https://www.threads.net/@me/post/1" });
    if (u.pathname === "/v1.0/keyword_search" && process.env.FAKE_THREADS_SEARCH === "empty") return jsonRes(200, { data: [] });
    if (u.pathname === "/v1.0/keyword_search" && process.env.FAKE_THREADS_SEARCH === "denied") return jsonRes(400, { error: { message: "Application does not have permission for this action", code: 10 } });
    if (u.pathname === "/v1.0/keyword_search") return jsonRes(200, { data: [
      { id: "k1", text: "バズ投稿1", username: "user1", permalink: "https://t/1", timestamp: "2026-09-18T00:00:00+0000" },
      { id: "k2", text: "バズ投稿2", username: "user2", permalink: "https://t/2", timestamp: "2026-09-18T00:00:00+0000" }
    ] });
    if (u.pathname === "/v1.0/thread1/insights") return jsonRes(200, { data: [{ name: "views", values: [{ value: 120 }] }, { name: "likes", values: [{ value: 7 }] }] });
    if (u.pathname === "/v1.0/thread1/replies") {
      assert.equal(u.searchParams.get("limit"), "100", "返信取得は100件ずつページ送り");
      if (process.env.FAKE_REPLIES_PAGED === "1" && !u.searchParams.get("after")) {
        return jsonRes(200, { data: [
          { id: "r1", text: "質問です", username: "fan", timestamp: "2026-09-18T01:00:00+0000", is_reply_owned_by_me: false },
          { id: "r3", text: "返金してほしい。クレームです", username: "angry", timestamp: "2026-09-18T01:30:00+0000", is_reply_owned_by_me: false }
        ], paging: { cursors: { after: "p2" } } });
      }
      if (process.env.FAKE_REPLIES_PAGED === "1") {
        return jsonRes(200, { data: [
          { id: "r4", text: "2ページ目のコメント", username: "fan2", timestamp: "2026-09-18T03:00:00+0000", is_reply_owned_by_me: false }
        ], paging: { cursors: {} } });
      }
      return jsonRes(200, { data: [
        { id: "r1", text: "質問です", username: "fan", timestamp: "2026-09-18T01:00:00+0000", is_reply_owned_by_me: false },
        { id: "r2", text: "自分の返信", username: "me", timestamp: "2026-09-18T02:00:00+0000", is_reply_owned_by_me: true }
      ] });
    }
    if (u.pathname === "/refresh_access_token") return jsonRes(200, { access_token: "refreshed", expires_in: 5184000 });
    if (u.pathname === "/v1.0/me/replies") return jsonRes(200, { data: process.env.FAKE_MY_REPLIES === "r5" ? [{ id: "mine1", replied_to: { id: "r5" }, timestamp: "2026-09-19T12:00:00+0000" }] : [] });
    if (/^\/v1\.0\/r\d+\/replies$/.test(u.pathname)) return jsonRes(200, { data: process.env.FAKE_CHILD_OWNED === u.pathname.split("/")[2] ? [{ id: "c1", is_reply_owned_by_me: true }] : [] });
    if (u.pathname === "/oauth/access_token") return jsonRes(200, { access_token: "short", user_id: 28556970853941705 });
    if (u.pathname === "/v1.0/me") return jsonRes(200, { id: "28556970853941705", username: "tester" });
    if (u.pathname === "/access_token") return jsonRes(200, { access_token: "long", expires_in: 5184000 });
    return jsonRes(400, { error: { message: "unexpected " + u.pathname } });
  }
  throw new Error(`unmocked fetch: ${url}`);
};

const { startServer, _internals, chooseGeminiModel } = await import("../server.js");
let server;

async function api(path, options = {}) {
  const res = await realFetch(`${BASE}${path}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json", "x-threads-ops": "1", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  return { status: res.status, data };
}

// 遅い publish を再現したいテスト用: Threads の threads_publish を指定ミリ秒待たせる
let publishDelayMs = 0;

before(async () => { server = await startServer(PORT); });
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = realFetch;
  rmSync(dataDir, { recursive: true, force: true });
});

test("初期状態: 設定は既定値、秘密はマスク", async () => {
  const { status, data } = await api("/api/state");
  assert.equal(status, 200);
  assert.equal(data.settings.operationMode, undefined, "自動モードは存在しない");
  assert.equal(data.settings.geminiApiKey, "");
  assert.ok(data.settings.threadsScopes.includes("threads_keyword_search"));
  assert.deepEqual(data.posts, []);
});

test("設定: 秘密はマスク往復で保持、時刻形式を検証、未知キーは無視", async () => {
  let r = await api("/api/settings", { method: "POST", body: { geminiApiKey: "AIzaTESTKEY", threadsAccessToken: "tok123", scheduleTimes: "09:00, 07:00,09:00", hacked: "x" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.geminiApiKey, "*".repeat("AIzaTESTKEY".length));
  assert.deepEqual(r.data.settings.scheduleTimes, ["07:00", "09:00"]);
  assert.equal(r.data.settings.hacked, undefined);
  r = await api("/api/settings", { method: "POST", body: { geminiApiKey: "***********" } });
  assert.equal(r.data.settings.geminiApiKey.length, "AIzaTESTKEY".length);
  const raw = JSON.parse(readFileSync(join(dataDir, "db.json"), "utf8"));
  assert.equal(raw.settings.geminiApiKey, "AIzaTESTKEY");
  r = await api("/api/settings", { method: "POST", body: { scheduleTimes: "25:00" } });
  assert.equal(r.status, 400);
  r = await api("/api/settings", { method: "POST", body: { operationMode: "auto" } });
  assert.equal(r.data.settings.operationMode, undefined, "operationMode は無視される");
  r = await api("/api/settings", { method: "POST", body: { geminiApiKey: "*****abc" } });
  assert.equal(r.status, 400, "伏字を部分編集した値は拒否");
  assert.equal(JSON.parse(readFileSync(join(dataDir, "db.json"), "utf8")).settings.geminiApiKey, "AIzaTESTKEY", "キーは壊れない");
  r = await api("/api/settings", { method: "POST", body: { threadsRedirectUri: "javascript:alert(1)" } });
  assert.equal(r.status, 400);
});

test("信頼境界: カスタムヘッダ無し・他オリジンからの書き込みは403", async () => {
  let res = await realFetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403, "ヘッダ無し");
  res = await realFetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"autoPublishEnabled":true}' });
  assert.equal(res.status, 403, "単純POST（フォーム送信相当）");
  res = await realFetch(`${BASE}/api/posts/bulk-approve`, { method: "POST", headers: { "content-type": "application/json", "x-threads-ops": "1", origin: "https://evil.example" }, body: "{}" });
  assert.equal(res.status, 403, "他オリジン");
  const state = await api("/api/state");
  assert.equal(state.data.settings.autoPublishEnabled, false);
  assert.equal(server.address().address, "127.0.0.1", "127.0.0.1 にだけ待ち受ける");
});

test("モデル自動選択: flash-lite の安定版を優先し、embedding は除外", () => {
  const picked = chooseGeminiModel([
    { name: "gemini-2.5-pro" }, { name: "gemini-2.5-flash" }, { name: "gemini-2.5-flash-lite" },
    { name: "gemini-3.0-flash-lite-preview" }, { name: "gemini-embedding-001" }
  ]);
  assert.equal(picked.name, "gemini-2.5-flash-lite");
});

test("投稿の状態遷移をサーバーが強制する", async () => {
  let r = await api("/api/posts", { method: "POST", body: { text: "手動投稿", status: "published", threadsId: "fake", id: "post_injected", replyToId: "x", mediaUrl: "javascript:alert(1)" } });
  assert.equal(r.status, 400, "mediaUrl の不正スキームは拒否");
  r = await api("/api/posts", { method: "POST", body: { text: "手動投稿", status: "published", threadsId: "fake", id: "post_injected", replyToId: "x" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.post.status, "review", "手動追加は必ず承認待ち");
  assert.equal(r.data.post.threadsId, "");
  assert.equal(r.data.post.replyToId, "");
  assert.notEqual(r.data.post.id, "post_injected", "id は指定できない");
  const id = r.data.post.id;

  r = await api(`/api/posts/${id}/publish`, { method: "POST" });
  assert.equal(r.status, 409, "承認待ちは公開できない");

  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "schedule" } });
  assert.equal(r.status, 409, "承認前に予約できない");

  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  assert.equal(r.data.post.status, "approved");

  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "schedule" } });
  assert.equal(r.status, 400, "予約日時なしでは予約できない");

  const future = new Date(Date.now() + 3600_000).toISOString();
  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "schedule", scheduledAt: future } });
  assert.equal(r.data.post.status, "scheduled");

  r = await api(`/api/posts/${id}`, { method: "PUT", body: { text: "本文を変更", status: "published" } });
  assert.equal(r.data.post.status, "review", "本文変更で承認待ちに戻る。status指定は無視");

  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  r = await api(`/api/posts/${id}`, { method: "PUT", body: { category: "Tips" } });
  assert.equal(r.data.post.status, "approved", "カテゴリだけの変更では戻らない");

  r = await api(`/api/posts/${id}/publish`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.data.post.status, "published");
  assert.equal(r.data.post.threadsId, "thread1");
  assert.equal(r.data.post.permalink, "https://www.threads.net/@me/post/1");

  r = await api(`/api/posts/${id}`, { method: "PUT", body: { text: "改ざん" } });
  assert.equal(r.status, 409, "公開済みは編集不可");
  r = await api(`/api/posts/${id}`, { method: "DELETE" });
  assert.equal(r.status, 409, "公開済みは削除不可");
  r = await api("/api/posts", { method: "POST", body: { text: "偽物", id } });
  assert.notEqual(r.data.post.id, id, "既存IDの偽物は作れない");
  await api(`/api/posts/${r.data.post.id}`, { method: "DELETE" });
  const state = await api("/api/state");
  assert.equal(state.data.posts.filter((p) => p.id === id).length, 1, "公開済みが巻き添えで消えない");
});

test("同時公開・公開中の編集は1本に絞られる", async () => {
  let r = await api("/api/posts", { method: "POST", body: { text: "同時" } });
  const id = r.data.post.id;
  await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  const before = calls.filter((c) => c.url.includes("threads_publish")).length;
  publishDelayMs = 400;
  const [a, b, edit] = await Promise.all([
    api(`/api/posts/${id}/publish`, { method: "POST" }),
    new Promise((resolve) => setTimeout(() => resolve(api(`/api/posts/${id}/publish`, { method: "POST" })), 50)),
    new Promise((resolve) => setTimeout(() => resolve(api(`/api/posts/${id}`, { method: "PUT", body: { text: "公開中に改変" } })), 100))
  ]);
  publishDelayMs = 0;
  assert.deepEqual([a.status, b.status, edit.status].sort(), [200, 409, 409]);
  assert.equal(calls.filter((c) => c.url.includes("threads_publish")).length - before, 1, "threads_publish は1回だけ");
  const state = await api("/api/state");
  const post = state.data.posts.find((p) => p.id === id);
  assert.equal(post.status, "published");
  assert.equal(post.text, "同時", "公開中の編集は反映されない");
});

test("Threadsの500文字上限と予約日時の検査", async () => {
  let r = await api("/api/posts", { method: "POST", body: { text: "あ".repeat(501) } });
  const id = r.data.post.id;
  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  assert.equal(r.status, 400, "501文字は承認できない");
  await api(`/api/posts/${id}`, { method: "PUT", body: { text: "あ".repeat(500) } });
  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  assert.equal(r.status, 200);
  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "schedule", scheduledAt: new Date(Date.now() + 3600_000).toISOString() } });
  assert.equal(r.data.post.status, "scheduled");
  r = await api(`/api/posts/${id}`, { method: "PUT", body: { scheduledAt: "" } });
  assert.equal(r.status, 400, "予約済みの日時を空にできない");
  r = await api(`/api/posts/${id}`, { method: "PUT", body: { scheduledAt: "2000-01-01T00:00:00Z" } });
  assert.equal(r.status, 400, "予約済みの日時を過去にできない");
  await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "unschedule" } });
  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "reject" } });
  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  assert.equal(r.status, 409, "却下からは直接承認できない（復帰を経る）");
  await api(`/api/posts/${id}`, { method: "DELETE" });
});

test("トークン未設定での公開は投稿をエラーにせず400を返す", async () => {
  await api("/api/threads-disconnect", { method: "POST" });
  let r = await api("/api/posts", { method: "POST", body: { text: "x" } });
  const id = r.data.post.id;
  await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  r = await api(`/api/posts/${id}/publish`, { method: "POST" });
  assert.equal(r.status, 400);
  const state = await api("/api/state");
  assert.equal(state.data.posts.find((p) => p.id === id).status, "approved");
  await api("/api/settings", { method: "POST", body: { threadsAccessToken: "tok123" } });
  await api(`/api/posts/${id}`, { method: "DELETE" });
});

test("投稿生成: 承認待ちで入り、予約時刻はサーバーが割り当てる。429は再試行する", async () => {
  geminiFailOnce = true;
  const before = calls.filter((c) => c.url.includes(":generateContent")).length;
  const r = await api("/api/generate-posts", { method: "POST", body: { count: 3, date: "2099-01-01", topic: "テスト" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.posts.length, 3);
  assert.ok(r.data.posts.every((p) => p.status === "review"));
  assert.deepEqual(r.data.posts.map((p) => p.scheduledAt), ["2098-12-31T22:00:00.000Z", "2099-01-01T00:00:00.000Z", "2099-01-01T22:00:00.000Z"], "JST 07:00, 09:00, 翌日07:00（UTCでは前日22時）");
  const after = calls.filter((c) => c.url.includes(":generateContent")).length;
  assert.equal(after - before, 2, "429で1回再試行した");
});

test("生成投稿は本数上限12を超えない", async () => {
  const r = await api("/api/generate-posts", { method: "POST", body: { count: 99 } });
  assert.equal(r.status, 200);
  assert.ok(r.data.posts.length <= 12);
});

test("まとめて承認 → 却下 → 復帰 → 削除", async () => {
  let r = await api("/api/posts/bulk-approve", { method: "POST" });
  assert.ok(r.data.count >= 3);
  const state = await api("/api/state");
  const id = state.data.posts.find((p) => p.status === "approved").id;
  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "reject" } });
  assert.equal(r.data.post.status, "rejected");
  r = await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "restore" } });
  assert.equal(r.data.post.status, "review");
  r = await api(`/api/posts/${id}`, { method: "DELETE" });
  assert.equal(r.status, 200);
});

test("スケジューラ: 自動送信ONのときだけ予約済みを公開する", async () => {
  let r = await api("/api/posts", { method: "POST", body: { text: "予約" } });
  const id = r.data.post.id;
  await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "schedule", scheduledAt: new Date(Date.now() + 30_000).toISOString() } });
  await _internals.withDb(async (db) => { db.posts.find((p) => p.id === id).scheduledAt = new Date(Date.now() - 1000).toISOString(); });
  await _internals.schedulerTick();
  let state = await api("/api/state");
  assert.equal(state.data.posts.find((p) => p.id === id).status, "scheduled", "OFFなら送らない");
  await api("/api/settings", { method: "POST", body: { autoPublishEnabled: true } });
  await _internals.schedulerTick();
  state = await api("/api/state");
  assert.equal(state.data.posts.find((p) => p.id === id).status, "published");
  await api("/api/settings", { method: "POST", body: { autoPublishEnabled: false } });
});

test("スケジューラ: 送信中に状態が変わった投稿を二重送信しない・却下済みを送らない", async () => {
  await api("/api/settings", { method: "POST", body: { autoPublishEnabled: true } });
  const make = async (text) => {
    const r = await api("/api/posts", { method: "POST", body: { text } });
    await api(`/api/posts/${r.data.post.id}/transition`, { method: "POST", body: { action: "approve" } });
    await api(`/api/posts/${r.data.post.id}/transition`, { method: "POST", body: { action: "schedule", scheduledAt: new Date(Date.now() + 60_000).toISOString() } });
    await _internals.withDb(async (db) => { db.posts.find((p) => p.id === r.data.post.id).scheduledAt = new Date(Date.now() - 1000).toISOString(); });
    return r.data.post.id;
  };
  const a = await make("A");
  const b = await make("B");
  const c = await make("C");
  const before = calls.filter((x) => x.url.includes("threads_publish")).length;
  publishDelayMs = 300;
  const tick = _internals.schedulerTick();
  await new Promise((r) => setTimeout(r, 100));
  // posts は新しい順に並ぶので、スケジューラは C → B → A の順に送る。C の送信中に A を却下し、B を手動公開する
  const rejected = await api(`/api/posts/${a}/transition`, { method: "POST", body: { action: "reject" } });
  assert.equal(rejected.status, 200, "Cの送信中でもAは却下できる");
  const manual = await api(`/api/posts/${b}/publish`, { method: "POST" });
  await tick;
  publishDelayMs = 0;
  const state = await api("/api/state");
  const byId = (id) => state.data.posts.find((p) => p.id === id);
  assert.equal(byId(c).status, "published");
  assert.equal(manual.status, 200);
  assert.equal(byId(b).status, "published");
  assert.equal(byId(a).status, "rejected", "却下した投稿は送られない");
  assert.equal(byId(a).threadsId, "");
  assert.equal(calls.filter((x) => x.url.includes("threads_publish")).length - before, 2, "C と B（手動）の2回だけ");
  await api("/api/settings", { method: "POST", body: { autoPublishEnabled: false } });
  await api(`/api/posts/${a}`, { method: "DELETE" });
});

test("送信中に落ちた投稿の復旧: 公開済みなら公開済みに、無ければ予約に戻す。失敗扱いの投稿は送り直す前に同文を照合する", async () => {
  await api("/api/settings", { method: "POST", body: { autoPublishEnabled: true } });
  const make = async (text, extra = {}) => {
    const r = await api("/api/posts", { method: "POST", body: { text } });
    await api(`/api/posts/${r.data.post.id}/transition`, { method: "POST", body: { action: "approve" } });
    await _internals.withDb(async (db) => { Object.assign(db.posts.find((p) => p.id === r.data.post.id), extra); });
    return r.data.post.id;
  };
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  // 1) コンテナ作成後に落ちて、Threads 側では公開済み
  const p1 = await make("復旧A", { status: "scheduled", scheduledAt: old, publishing: { startedAt: old, prevStatus: "scheduled", containerId: "container1" } });
  // 2) コンテナ作成前に落ちた（Threads 側に無い）→ 予約に戻して送り直す
  const p2 = await make("復旧B", { status: "scheduled", scheduledAt: old, publishing: { startedAt: old, prevStatus: "scheduled", containerId: "" } });
  // 3) 手動公開の途中で落ち、Threads 側にも無い → 失敗扱い
  const p3 = await make("復旧C", { status: "approved", publishing: { startedAt: old, prevStatus: "approved", containerId: "" } });
  // 4) 直前の送信中（2分未満）は触らない
  const p4 = await make("復旧D", { status: "scheduled", scheduledAt: old, publishing: { startedAt: new Date().toISOString(), prevStatus: "scheduled", containerId: "" } });
  process.env.FAKE_CONTAINER_STATUS = "PUBLISHED";
  const before = calls.filter((x) => x.url.includes("threads_publish")).length;
  await _internals.schedulerTick();
  delete process.env.FAKE_CONTAINER_STATUS;
  let st = (await api("/api/state")).data;
  const byId = (id) => st.posts.find((p) => p.id === id);
  assert.equal(byId(p1).status, "published", "公開済みだった投稿は published に直す");
  assert.equal(byId(p1).threadsId, "container1");
  assert.equal(byId(p2).status, "published", "Threads 側に無い予約投稿は予約に戻り、同じティックで送り直される");
  assert.equal(byId(p3).status, "error", "手動公開の中断は失敗扱い（人が確認して承認し直す）");
  assert.match(byId(p3).error, /送信中に中断/);
  assert.equal(byId(p4).status, "scheduled", "直前の送信中は触らない");
  assert.ok(byId(p4).publishing, "publishing の印も残す");
  assert.equal(calls.filter((x) => x.url.includes("threads_publish")).length - before, 1, "threads_publish は p2 の1回だけ（p1 は再送しない）");
  // 5) 失敗扱いの投稿を承認し直して公開するとき、直近に同じ本文が届いていれば送らずに公開済みにする
  await _internals.withDb(async (db) => { delete db.posts.find((p) => p.id === p4).publishing; });
  const p5 = await make("復旧E", { status: "error", publishFailedAt: new Date().toISOString() });
  await api(`/api/posts/${p5}/transition`, { method: "POST", body: { action: "approve" } });
  process.env.FAKE_RECENT_TEXT = "復旧E";
  const before2 = calls.filter((x) => x.url.includes("threads_publish")).length;
  let r = await api(`/api/posts/${p5}/publish`, { method: "POST" });
  delete process.env.FAKE_RECENT_TEXT;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.post.status, "published");
  assert.equal(r.data.post.threadsId, "recent1", "既に届いていた投稿を採用");
  assert.equal(calls.filter((x) => x.url.includes("threads_publish")).length - before2, 0, "二重投稿しない");
  // 5b) 失敗後に本文を編集した投稿は照合できないので、同文があっても送る（近似の二重は人が Threads 側で確認する前提。ログで知らせる）
  const p5b = await make("復旧F", { status: "error", publishFailedAt: new Date().toISOString() });
  await api(`/api/posts/${p5b}`, { method: "PUT", body: { text: "復旧F 修正" } });
  st = (await api("/api/state")).data;
  assert.equal(st.posts.find((p) => p.id === p5b).textChangedAfterFailure, true);
  assert.ok(st.logs.some((l) => /本文を編集しました/.test(l.message)));
  await api(`/api/posts/${p5b}/transition`, { method: "POST", body: { action: "approve" } });
  process.env.FAKE_RECENT_TEXT = "復旧F 修正";
  const before3 = calls.filter((x) => x.url.includes("threads_publish")).length;
  r = await api(`/api/posts/${p5b}/publish`, { method: "POST" });
  delete process.env.FAKE_RECENT_TEXT;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls.filter((x) => x.url.includes("threads_publish")).length - before3, 1, "編集後は照合せず送る");
  assert.equal(r.data.post.textChangedAfterFailure, undefined, "公開したら印は消える");
  // 5c) 24時間以上過ぎた予約は送らず error にして知らせる
  const p6 = await make("復旧G", { status: "scheduled", scheduledAt: new Date(Date.now() - 25 * 3600e3).toISOString() });
  const before4 = calls.filter((x) => x.url.includes("threads_publish")).length;
  await _internals.schedulerTick();
  st = (await api("/api/state")).data;
  assert.equal(st.posts.find((p) => p.id === p6).status, "error");
  assert.match(st.posts.find((p) => p.id === p6).error, /24時間以上/);
  assert.equal(st.posts.find((p) => p.id === p6).threadsId, "", "古い予約は送らない");
  assert.equal(st.posts.find((p) => p.id === p4).status, "published", "同じティックで、publishing を外した p4（10分遅れ）は送られる");
  assert.equal(calls.filter((x) => x.url.includes("threads_publish")).length - before4, 1, "送信は p4 の1回だけ");
  // 6) 送信中の返信は、届いていなければ要確認に戻す
  await _internals.withDb(async (db) => { db.replies.push({ id: "r90", postId: "p1", rootThreadsId: "thread1", text: "本文", username: "u", timestamp: old, permalink: "", status: "drafted", responseText: "下書き", autoQueued: true, sendingAt: old, respondedThreadsId: "", fetchedAt: "" }); });
  await _internals.schedulerTick();
  st = (await api("/api/state")).data;
  const r90 = st.replies.find((x) => x.id === "r90");
  assert.equal(r90.status, "held");
  assert.equal(r90.sendingAt, "");
  assert.equal(r90.autoQueued, false);
  await api("/api/settings", { method: "POST", body: { autoPublishEnabled: false } });
  for (const id of [p2, p3, p4]) { await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "reject" } }).catch(() => {}); }
  await _internals.withDb(async (db) => { db.posts = db.posts.filter((p) => ![p1, p2, p3, p4, p5, p5b, p6].includes(p.id)); db.replies = db.replies.filter((x) => x.id !== "r90"); });
});

test("429の再送記録は承認し直し・予約し直しでリセットされる", async () => {
  const r = await api("/api/posts", { method: "POST", body: { text: "再送" } });
  const id = r.data.post.id;
  await _internals.withDb(async (db) => { Object.assign(db.posts.find((p) => p.id === id), { status: "error", retryAfter: new Date(Date.now() + 600_000).toISOString(), retryCount: 3 }); });
  await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "approve" } });
  const state = await api("/api/state");
  const post = state.data.posts.find((p) => p.id === id);
  assert.equal(post.retryAfter, undefined);
  assert.equal(post.retryCount, undefined);
  await api(`/api/posts/${id}/transition`, { method: "POST", body: { action: "reject" } });
  await api(`/api/posts/${id}`, { method: "DELETE" });
});

test("信頼境界: アクセスキーを設定すると全 API に x-threads-key が要る。伏字は保存しない。Codex モデル名は英数のみ", async () => {
  let r = await api("/api/settings", { method: "POST", body: { accessKey: "short" } });
  assert.equal(r.status, 400, "8文字未満は拒否");
  r = await api("/api/settings", { method: "POST", body: { accessKey: "k".repeat(129) } });
  assert.equal(r.status, 400, "129文字以上は拒否（黙って切らない）");
  r = await api("/api/settings", { method: "POST", body: { accessKey: "secret-key-123" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api("/api/nonexistent");
  assert.equal(r.status, 401, "キー無しでは API の有無も分からない");
  r = await api("/api/state");
  assert.equal(r.status, 401, "キー無しは読み取りも 401");
  assert.equal(r.data.detail, "access-key");
  r = await api("/api/state", { headers: { "x-threads-key": "wrong" } });
  assert.equal(r.status, 401);
  r = await api("/api/state", { headers: { "x-threads-key": "secret-key-123" } });
  assert.equal(r.status, 200);
  assert.match(r.data.settings.accessKey, /[*]/, "画面には伏字で返す");
  assert.equal(typeof r.data.version, "string", "バージョンを返す");
  // 伏字のまま保存しても実キーは消えない
  r = await api("/api/settings", { method: "POST", body: { accessKey: r.data.settings.accessKey }, headers: { "x-threads-key": "secret-key-123" } });
  assert.equal(r.status, 200);
  r = await api("/api/state", { headers: { "x-threads-key": "secret-key-123" } });
  assert.equal(r.status, 200, "伏字を送っても実キーは保持される");
  // エラー詳細・画面のログにキーの実値が出ない
  assert.equal(_internals.redactSecrets("token secret-key-123 leaked"), "token *** leaked");
  await _internals.withDb(async (d) => { _internals.log(d, "error", "失敗 secret-key-123", { error: "x secret-key-123 y" }); });
  r = await api("/api/state", { headers: { "x-threads-key": "secret-key-123" } });
  assert.equal(r.data.logs[0].message, "失敗 ***");
  assert.equal(r.data.logs[0].meta.error, "x *** y");
  // 空にすると不要になる
  r = await api("/api/settings", { method: "POST", body: { accessKey: "" }, headers: { "x-threads-key": "secret-key-123" } });
  assert.equal(r.status, 200);
  r = await api("/api/state");
  assert.equal(r.status, 200, "空にしたらキー無しで通る");
  r = await api("/api/settings", { method: "POST", body: { codexModel: "gpt-5; rm -rf /" } });
  assert.equal(r.status, 400, "モデル名に記号は入れられない");
  r = await api("/api/settings", { method: "POST", body: { codexModel: "gpt-5-codex" } });
  assert.equal(r.status, 200);
  r = await api("/api/settings", { method: "POST", body: { brandName: "x".repeat(500) } });
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.brandName.length, 100, "文字列には長さ上限がある");
  await api("/api/settings", { method: "POST", body: { brandName: "テスト" } });
});

test("生成の守り: 参考投稿の丸写しは5-gram重複で検出、実績は公開24時間未満を平均・下位から除く", () => {
  const src = "今日はハンドメイドの新作を紹介します。刺繍のブローチで、糸の色を三色にしました。";
  assert.ok(_internals.ngramOverlap(src, src) === 1);
  assert.ok(_internals.ngramOverlap("刺繍のブローチで、糸の色を三色にしました。全然別の話をここに足します。長めにして割合を下げます。", src) > 0.3, "半分写しは検出");
  assert.ok(_internals.ngramOverlap("まったく別の文章です。共通する五文字の並びはありません。", src) < 0.1);
  const now = Date.now();
  const db = { posts: [
    { id: "a", status: "published", category: "c1", text: "古い", publishedAt: new Date(now - 48 * 3600e3).toISOString() },
    { id: "b", status: "published", category: "c1", text: "新しい", publishedAt: new Date(now - 3600e3).toISOString() }
  ], insights: [
    { postId: "a", fetchedAt: "2026-09-20T00:00:00Z", metrics: { views: 100, likes: 5, replies: 1, reposts: 0 } },
    { postId: "b", fetchedAt: "2026-09-21T00:00:00Z", metrics: { views: 3, likes: 0, replies: 0, reposts: 0 } }
  ] };
  const stats = _internals.buildStats(db);
  assert.equal(stats.publishedWithInsights, 2);
  assert.equal(stats.excludedRecent, 1);
  assert.equal(stats.byCategory.c1.count, 1, "24時間未満は平均に入れない");
  assert.equal(stats.byCategory.c1.avgViews, 100);
  assert.deepEqual(stats.bottom.map((x) => x.text), ["古い"], "下位にも入れない");
  assert.equal(stats.top[0].text, "古い");
});

test("信頼境界: Host ヘッダが localhost 以外なら拒否（DNSリバインディング対策）", async () => {
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path: "/api/state", method: "GET", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 421);
});

test("IMAGE 投稿はメディアURL無しで承認できない", async () => {
  const r = await api("/api/posts", { method: "POST", body: { text: "画像", format: "IMAGE" } });
  const t = await api(`/api/posts/${r.data.post.id}/transition`, { method: "POST", body: { action: "approve" } });
  assert.equal(t.status, 400);
  await api(`/api/posts/${r.data.post.id}`, { method: "DELETE" });
});

test("参考投稿: 検索→重複除外→型分析→生成プロンプトに反映", async () => {
  let r = await api("/api/references/search", { method: "POST", body: { keyword: "ハンドメイド" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 2);
  r = await api("/api/references/search", { method: "POST", body: { keyword: "ハンドメイド" } });
  assert.equal(r.data.added, 0, "同じ投稿は二重登録しない");
  r = await api("/api/references", { method: "POST", body: { text: "x", permalink: "javascript:alert(1)" } });
  assert.equal(r.status, 400, "permalink の不正スキームは拒否");
  r = await api("/api/references", { method: "POST", body: { text: "手動貼り付け", username: "@x" } });
  assert.equal(r.data.reference.selected, true);
  let state = await api("/api/state");
  const first = state.data.references.find((x) => x.source === "threads");
  await api(`/api/references/${first.id}`, { method: "PUT", body: { selected: true } });
  r = await api("/api/references/analyze", { method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 2);
  state = await api("/api/state");
  assert.equal(state.data.referenceAnalysis.commonPatterns, "共通");
  assert.equal(state.data.references.find((x) => x.id === first.id).analysis.hook, "h");
  const idx = calls.length;
  await api("/api/generate-posts", { method: "POST", body: { count: 1 } });
  const gen = calls.slice(idx).find((c) => c.url.includes(":generateContent"));
  assert.ok(gen);
  assert.match(gen.body, /手動貼り付け/, "選択した参考投稿の本文がプロンプトに入る");
  assert.match(gen.body, /共通する型/, "型分析の結果がプロンプトに入る");
});

test("Web参照元: 重複URLを除外し、選択・削除できる", async () => {
  let r = await api("/api/research", { method: "POST", body: { keyword: "AI" } });
  assert.equal(r.data.research.sources.length, 2);
  const src = r.data.research.sources[0];
  r = await api(`/api/research/sources/${src.id}`, { method: "PUT", body: { selected: true } });
  assert.equal(r.data.source.selected, true);
  r = await api(`/api/research/${r.data.source.id}`, { method: "DELETE" });
  assert.equal(r.status, 404);
  const state = await api("/api/state");
  r = await api(`/api/research/${state.data.research[0].id}`, { method: "DELETE" });
  assert.equal(r.status, 200);
});

test("インサイト・コメント・AI下書き・返信", async () => {
  let r = await api("/api/refresh-insights", { method: "POST" });
  assert.equal(r.status, 200);
  assert.ok(r.data.fetched >= 1);
  let state = await api("/api/state");
  assert.ok(state.data.insights[0].metrics.views === 120);
  assert.ok(state.data.stats.byCategory);

  r = await api("/api/fetch-replies", { method: "POST" });
  assert.equal(r.status, 200);
  state = await api("/api/state");
  const mine = state.data.replies.find((x) => x.id === "r2");
  assert.equal(mine, undefined, "自分の返信は取り込まない");
  const reply = state.data.replies.find((x) => x.id === "r1");
  assert.equal(reply.status, "unhandled");

  r = await api("/api/fetch-replies", { method: "POST" });
  assert.equal(r.data.added, 0, "既知のコメントは再登録しない");

  r = await api(`/api/replies/r1/draft`, { method: "POST" });
  assert.equal(r.data.reply.responseText, "返信下書き");
  assert.equal(r.data.reply.status, "drafted");

  r = await api(`/api/replies/r1/respond`, { method: "POST", body: { text: "" } });
  assert.equal(r.status, 200, "空指定なら下書きを使う");
  assert.equal(r.data.reply.status, "responded");
  r = await api(`/api/replies/r1/respond`, { method: "POST", body: { text: "二重" } });
  assert.equal(r.status, 409);
  await _internals.withDb(async (db) => { db.replies.push({ id: "r9", postId: "none", text: "無視対象", status: "unhandled", responseText: "", timestamp: "" }); });
  await api(`/api/replies/r9`, { method: "PUT", body: { status: "ignored" } });
  r = await api(`/api/replies/r9/respond`, { method: "POST", body: { text: "返す" } });
  assert.equal(r.status, 409, "対応しないにしたコメントには返信できない");
});

test("改善提案: インサイト付き3件未満なら400、3件以上なら生成して保存", async () => {
  let state = await api("/api/state");
  const n = state.data.stats.publishedWithInsights;
  let r = await api("/api/suggestions", { method: "POST" });
  if (n < 3) {
    assert.equal(r.status, 400);
    assert.match(r.data.error, /3件以上/);
  } else {
    assert.equal(r.status, 200);
    assert.equal(r.data.suggestion.basedOn, n);
    state = await api("/api/state");
    assert.equal(state.data.suggestions[0].summary, "要約");
  }
});

test("OAuth: state不一致は拒否、正しいstateでトークン保存", async () => {
  await api("/api/settings", { method: "POST", body: { threadsAppId: "app", threadsAppSecret: "sec" } });
  let res = await realFetch(`${BASE}/oauth/callback?code=abc&state=bogus`);
  assert.equal(res.status, 400);
  const r = await api("/api/threads-auth-url");
  const state = new URL(r.data.url).searchParams.get("state");
  assert.equal(new URL(r.data.url).searchParams.get("client_id"), "app");
  res = await realFetch(`${BASE}/oauth/callback?code=abc&state=${state}`);
  assert.equal(res.status, 200);
  const raw = JSON.parse(readFileSync(join(dataDir, "db.json"), "utf8"));
  assert.equal(raw.settings.threadsAccessToken, "long");
  assert.equal(raw.settings.threadsUserId, "28556970853941705", "2^53 超の user_id は /me の文字列 id で保存する");
  assert.equal(raw.settings.threadsUsername, "tester");
  res = await realFetch(`${BASE}/oauth/callback?code=abc&state=${state}`);
  assert.equal(res.status, 400, "stateは使い捨て");
});

test("トークン更新API", async () => {
  const r = await api("/api/refresh-threads-token", { method: "POST" });
  assert.equal(r.status, 200);
  const raw = JSON.parse(readFileSync(join(dataDir, "db.json"), "utf8"));
  assert.equal(raw.settings.threadsAccessToken, "refreshed");
});

test("AIプロバイダ: Claude Code 経由で生成・返信下書き・Web検索が動く（偽CLI）", async () => {
  let r = await api("/api/settings", { method: "POST", body: { aiProvider: "claude-code", claudeModel: "opus" } });
  assert.equal(r.data.settings.aiProvider, "claude-code");
  r = await api("/api/ai-check", { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.provider, "claude-code");
  assert.equal(r.data.greeting, "こんにちは");
  r = await api("/api/generate-posts", { method: "POST", body: { count: 1, topic: "テーマX" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.posts[0].text, /^Claude生成: /);
  assert.equal(r.data.posts[0].status, "review");
  r = await api("/api/research", { method: "POST", body: { keyword: "claude検索" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.research.sources.map((s) => s.url), ["https://example.com/c"], "不正スキームのURLは捨てる");
  // Threads API のキーワード検索が0件（審査前は自分の投稿のみ）→ Web 検索経由に切り替わる
  process.env.FAKE_THREADS_SEARCH = "empty";
  r = await api("/api/references/search", { method: "POST", body: { keyword: "ハンドメイド 委託" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.via, "web");
  assert.equal(r.data.found, 1, "プロフィールURLと重複は除外して1件");
  let st = (await api("/api/state")).data;
  const webRef = st.references.find((x) => x.source === "threads-web");
  assert.equal(webRef.permalink, "https://www.threads.com/@maker1/post/ABC123xyz", "URL は正規形に整える");
  assert.equal(webRef.username, "maker1", "@ は外す");
  assert.deepEqual(webRef.metrics, { likes: 70, replies: 34 });
  // 権限不足（審査前に scope が付いていない）でも Web 経由へ
  process.env.FAKE_THREADS_SEARCH = "denied";
  r = await api("/api/references/search", { method: "POST", body: { keyword: "ハンドメイド 委託" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.via, "web");
  assert.equal(r.data.added, 0, "同じ投稿は二重登録しない");
  delete process.env.FAKE_THREADS_SEARCH;
  r = await api("/api/settings", { method: "POST", body: { aiProvider: "bogus" } });
  assert.equal(r.status, 400);
  r = await api("/api/settings", { method: "POST", body: { aiProvider: "claude-api" } });
  r = await api("/api/research", { method: "POST", body: { keyword: "x" } });
  assert.equal(r.status, 400, "Claude API では Web検索は使えない旨を返す");
  r = await api("/api/ai-check", { method: "POST" });
  assert.equal(r.status, 400, "Claude APIキー未設定");
  await api("/api/settings", { method: "POST", body: { aiProvider: "gemini" } });
});

test("コメント自動処理: ページ送り取得→AIまとめ判定（要確認を分ける）→間隔・上限つき自動送信→手動送信は自動に混ざらない（偽CLI）", async () => {
  await api("/api/settings", { method: "POST", body: { aiProvider: "claude-code", autoReplyEnabled: false, autoFetchRepliesEnabled: true, autoFetchRepliesMinutes: 1 } });
  // 自動返信OFF: 取得と下書きはせず、送信もしない
  process.env.FAKE_REPLIES_PAGED = "1";
  await _internals.withDb(async (d) => { d.settings.lastAutoFetchAt = ""; d.replies = d.replies.filter((r) => !["r3", "r4"].includes(r.id)); });
  await _internals.autoReplyTick();
  let st = (await api("/api/state")).data;
  assert.ok(st.replies.some((r) => r.id === "r4"), "2ページ目のコメントまで取り込む");
  assert.equal(st.replies.filter((r) => r.status === "drafted" && r.autoDrafted).length, 0, "OFFでは自動下書きしない");
  // まとめ下書き（手動ボタン）: クレームは要確認へ
  let r = await api("/api/replies/draft-batch", { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = (await api("/api/state")).data;
  const held = st.replies.find((x) => x.id === "r3");
  assert.equal(held.status, "held");
  assert.match(held.holdReason, /クレーム/);
  const drafted = st.replies.find((x) => x.id === "r4");
  assert.equal(drafted.status, "drafted");
  assert.equal(drafted.autoDrafted, true);
  assert.equal(st.replies.filter((x) => x.status === "responded").length, st.replies.filter((x) => x.status === "responded" && !x.auto).length, "自動送信はまだ0件");
  // 自動返信ON: 間隔60秒なら1ティックで1件だけ送る
  await api("/api/settings", { method: "POST", body: { autoReplyEnabled: true, autoReplyIntervalSec: 60, autoReplyDailyCap: 500 } });
  await _internals.withDb(async (d) => { d.settings.lastAutoReplyAt = ""; });
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  const autoSent = st.replies.filter((x) => x.status === "responded" && x.auto);
  assert.equal(autoSent.length, 1, "1ティックで1件（間隔60秒）");
  assert.equal(st.replies.find((x) => x.id === "r3").status, "held", "要確認は送らない");
  assert.equal(st.settings.lastAutoReplyAt, autoSent[0].respondedAt);
  // 間隔内は送らない
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  assert.equal(st.replies.filter((x) => x.status === "responded" && x.auto).length, 1, "間隔60秒以内は次を送らない");
  // 1日上限
  await api("/api/settings", { method: "POST", body: { autoReplyDailyCap: 1 } });
  await _internals.withDb(async (d) => { d.settings.lastAutoReplyAt = ""; });
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  assert.equal(st.replies.filter((x) => x.status === "responded" && x.auto).length, 1, "1日上限に達したら送らない");
  // 破壊レポート致命傷1: 「対応しない」→「未対応に戻す」で自動送信に乗らない
  await api("/api/settings", { method: "POST", body: { autoReplyDailyCap: 500 } });
  const r3 = st.replies.find((x) => x.id === "r3");
  await api(`/api/replies/${r3.id}`, { method: "PUT", body: { responseText: "人が書いた下書き", status: "unhandled" } });
  await api(`/api/replies/${r3.id}`, { method: "PUT", body: { status: "ignored" } });
  await api(`/api/replies/${r3.id}`, { method: "PUT", body: { status: "unhandled" } });
  st = (await api("/api/state")).data;
  assert.equal(st.replies.find((x) => x.id === "r3").status, "drafted", "下書きがあれば drafted に戻る");
  assert.equal(st.replies.find((x) => x.id === "r3").autoQueued, false, "人が触った下書きは自動送信の列に入らない");
  await _internals.withDb(async (d) => { d.settings.lastAutoReplyAt = ""; });
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  assert.equal(st.replies.find((x) => x.id === "r3").status, "drafted", "戻したコメントは自動送信されない");
  // 致命傷4: id の取り違え → quote 照合で要確認、text が object → 要確認、URL・「さん」→ 要確認
  const seed = async (ids) => _internals.withDb(async (d) => {
    d.replies = d.replies.filter((x) => !ids.includes(x.id));
    for (const rid of ids) d.replies.push({ id: rid, postId: "p1", rootThreadsId: "thread1", text: `コメント${rid}の本文です。教えてください`, username: `u${rid}`, timestamp: "2026-09-19T00:00:00+0000", permalink: "", status: "unhandled", responseText: "", respondedThreadsId: "", fetchedAt: "" });
  });
  for (const [mode, expectStatus, reasonRe] of [["swap", "held", /照合/], ["object-text", "held", /返信文を作れ/], ["url-text", "held", /URL/], ["san-text", "held", /URL/]]) {
    await seed(["r10", "r11"]);
    process.env.FAKE_BATCH_MODE = mode;
    r = await api("/api/replies/draft-batch", { method: "POST" });
    assert.equal(r.status, 200, `${mode}: ${JSON.stringify(r.data)}`);
    st = (await api("/api/state")).data;
    for (const rid of ["r10", "r11"]) {
      const x = st.replies.find((y) => y.id === rid);
      assert.equal(x.status, expectStatus, `${mode}: ${rid} は ${expectStatus}`);
      assert.match(x.holdReason || "", reasonRe, `${mode}: ${rid} の理由`);
      assert.notEqual(x.autoQueued, true, `${mode}: ${rid} は自動送信されない`);
    }
  }
  // 致命傷3: AI が壊れた応答を返し続けても同じ10件で止まらず、3回で要確認へ
  await seed(["r20"]);
  process.env.FAKE_BATCH_MODE = "badjson";
  for (let i = 0; i < 3; i += 1) {
    r = await api("/api/replies/draft-batch", { method: "POST" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.failed, true);
  }
  st = (await api("/api/state")).data;
  assert.equal(st.replies.find((x) => x.id === "r20").status, "held", "3回失敗で要確認");
  assert.match(st.replies.find((x) => x.id === "r20").holdReason, /3回失敗/);
  assert.ok(st.settings.lastDraftFailureAt, "失敗時刻を記録し、自動処理は5分空ける");
  delete process.env.FAKE_BATCH_MODE;
  // 弱点: 本人が Threads アプリから手で返したコメントは responded(external) になり、自動送信もされない
  await seed(["r5"]);
  process.env.FAKE_MY_REPLIES = "r5";
  await _internals.withDb(async (d) => { d.settings.lastAutoFetchAt = ""; });
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  assert.equal(st.replies.find((x) => x.id === "r5").status, "responded");
  assert.equal(st.replies.find((x) => x.id === "r5").external, true, "ツール外で返した印");
  delete process.env.FAKE_MY_REPLIES;
  // 致命傷2: error のコメントを送り直すとき、既に自分の返信が付いていれば送らず返信済みにする
  await _internals.withDb(async (d) => { const x = d.replies.find((y) => y.id === "r4"); x.status = "error"; x.error = "送信に失敗"; x.responseText = "送り直し文"; });
  process.env.FAKE_CHILD_OWNED = "r4";
  r = await api("/api/replies/r4/respond", { method: "POST", body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reply.status, "responded");
  assert.equal(r.data.reply.external, true, "二重送信せず既存の返信を採用");
  delete process.env.FAKE_CHILD_OWNED;
  // 2周目致命傷: 単体の「AIで下書き」は自動送信の列に入らない
  await seed(["r30"]);
  r = await api("/api/replies/draft-batch", { method: "POST" });
  st = (await api("/api/state")).data;
  assert.equal(st.replies.find((x) => x.id === "r30").autoQueued, true);
  r = await api("/api/replies/r30/draft", { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reply.autoQueued, false, "単体の再下書きは検査を通っていないので自動送信しない");
  // quote が括弧付き・全角でも照合できる
  await seed(["r31"]);
  process.env.FAKE_BATCH_MODE = "bracket-quote";
  r = await api("/api/replies/draft-batch", { method: "POST" });
  st = (await api("/api/state")).data;
  assert.equal(st.replies.find((x) => x.id === "r31").status, "drafted", "「」付きの quote でも要確認にしない");
  delete process.env.FAKE_BATCH_MODE;
  // ブロックリスト: ドメインだけのURL・全角メンション・区切りなし電話・ハンドル+さん
  for (const bad of ["example.com を見て", "＠yamada です", "09012345678 に電話ください", "tarouさんのおっしゃる通り", "LINE ID: abc123"]) {
    assert.match(bad, _internals.REPLY_TEXT_BLOCKLIST, `止める: ${bad}`);
  }
  for (const ok of ["たくさんの方に見てもらえて嬉しいです", "みなさんはどう思いますか", "お客さんの声を聞いて考えました"]) {
    assert.doesNotMatch(ok, _internals.REPLY_TEXT_BLOCKLIST, `通す: ${ok}`);
  }
  // 429: 下書きのまま残して一時停止。停止中は送らない
  await seed(["r40"]);
  await api("/api/settings", { method: "POST", body: { autoReplyEnabled: true, autoReplyIntervalSec: 5 } });
  r = await api("/api/replies/draft-batch", { method: "POST" });
  process.env.FAKE_PUBLISH_429 = "1";
  await _internals.withDb(async (d) => { d.settings.lastAutoReplyAt = ""; d.settings.autoReplyPausedUntil = ""; });
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  const r40 = st.replies.find((x) => x.id === "r40");
  assert.equal(r40.status, "drafted", "429 は未送信確定なので下書きのまま");
  assert.equal(r40.autoQueued, true, "資格も残す");
  assert.ok(Date.parse(st.settings.autoReplyPausedUntil) > Date.now(), "一時停止に入る");
  delete process.env.FAKE_PUBLISH_429;
  await _internals.withDb(async (d) => { d.settings.lastAutoReplyAt = ""; });
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  assert.equal(st.replies.find((x) => x.id === "r40").status, "drafted", "停止中は送らない");
  // 停止が明けたら送る。自動送信も直前に自分の返信の有無を確かめる（既にあれば送らず responded/external）
  await _internals.withDb(async (d) => { d.settings.autoReplyPausedUntil = ""; d.settings.lastAutoReplyAt = ""; });
  process.env.FAKE_CHILD_OWNED = "r40";
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  assert.equal(st.replies.find((x) => x.id === "r40").status, "responded");
  assert.equal(st.replies.find((x) => x.id === "r40").external, true, "自動送信の直前確認で二重を防ぐ");
  delete process.env.FAKE_CHILD_OWNED;
  // 1ティック最大3件（間隔5秒）: 3件並べて1ティックで3件送る
  await seed(["r50", "r51", "r52"]);
  r = await api("/api/replies/draft-batch", { method: "POST" });
  await _internals.withDb(async (d) => { d.settings.lastAutoReplyAt = ""; });
  await _internals.autoReplyTick();
  st = (await api("/api/state")).data;
  assert.equal(["r50", "r51", "r52"].filter((rid) => st.replies.find((x) => x.id === rid).status === "responded" && st.replies.find((x) => x.id === rid).auto).length, 3, "間隔5秒なら1ティックで3件");
  await api("/api/settings", { method: "POST", body: { autoReplyEnabled: false } });
  r = await api("/api/settings", { method: "POST", body: { autoReplyIntervalSec: 1 } });
  assert.equal(r.status, 400, "間隔は5秒未満を拒否");
  r = await api("/api/settings", { method: "POST", body: { autoReplyDailyCap: 5000 } });
  assert.equal(r.status, 400, "上限は Threads の1日1,000件を超えられない");
  await api("/api/settings", { method: "POST", body: { autoReplyEnabled: false, aiProvider: "gemini" } });
  delete process.env.FAKE_REPLIES_PAGED;
});

test("Codex 向けスキーマ変換: 入れ子の object に additionalProperties:false、required は全列挙、任意項目は null 許容", () => {
  const strict = _internals.toStrictSchema({ type: "object", properties: { posts: { type: "array", items: { type: "object", properties: { url: { type: "string" }, likes: { type: "number" } }, required: ["url"] } } }, required: ["posts"] });
  assert.equal(strict.additionalProperties, false);
  assert.equal(strict.properties.posts.items.additionalProperties, false);
  assert.deepEqual(strict.properties.posts.items.required, ["url", "likes"]);
  assert.deepEqual(strict.properties.posts.items.properties.likes.type, ["number", "null"]);
  assert.deepEqual(strict.properties.posts.items.properties.url.type, "string", "必須項目の型は変えない");
});

test("AIプロバイダ: Codex CLI 経由で接続テスト・生成・Web検索・Threads公開投稿探索が動く（偽CLI）", async () => {
  let r = await api("/api/settings", { method: "POST", body: { aiProvider: "codex", codexModel: " gpt-5-codex " } });
  assert.equal(r.data.settings.aiProvider, "codex");
  assert.equal(r.data.settings.codexModel, "gpt-5-codex", "モデル名は前後の空白を落として保存");
  r = await api("/api/ai-check", { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.provider, "codex");
  assert.equal(r.data.greeting, "こんにちは(codex)");
  r = await api("/api/generate-posts", { method: "POST", body: { count: 1, topic: "テーマY" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.posts[0].text, /^Codex生成: /);
  assert.equal(r.data.posts[0].origin, "codex");
  r = await api("/api/research", { method: "POST", body: { keyword: "codex検索" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.research.summary, "検索要約(codex)", "--search 付きで起動している");
  assert.deepEqual(r.data.research.sources.map((x) => x.url), ["https://example.com/codex"]);
  process.env.FAKE_THREADS_SEARCH = "empty";
  r = await api("/api/references/search", { method: "POST", body: { keyword: "codex threads" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.via, "web");
  assert.equal(r.data.found, 1);
  delete process.env.FAKE_THREADS_SEARCH;
  const st = (await api("/api/state")).data;
  assert.equal(st.references.find((x) => x.username === "codexmaker").permalink, "https://www.threads.com/@codexmaker/post/XYZ789");
  process.env.FAKE_CODEX_MODE = "not-logged-in";
  r = await api("/api/ai-check", { method: "POST" });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Codex にログインしていません/);
  delete process.env.FAKE_CODEX_MODE;
  const leftovers = readdirSync(join(dataDir, "codex-home")).filter((f) => /-(schema\.json|out\.txt|instructions\.md)$/.test(f));
  assert.deepEqual(leftovers, [], "スキーマ・出力の一時ファイルは毎回消す");
  await api("/api/settings", { method: "POST", body: { aiProvider: "gemini" } });
});

test("AIプロバイダ: Claude Code 未ログインは日本語の案内、コードフェンス付き応答も読める（偽CLI）", async () => {
  await api("/api/settings", { method: "POST", body: { aiProvider: "claude-code" } });
  process.env.FAKE_CLAUDE_MODE = "not-logged-in";
  let r = await api("/api/ai-check", { method: "POST" });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /ログインしていません/);
  process.env.FAKE_CLAUDE_MODE = "prose";
  r = await api("/api/ai-check", { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.greeting, "こんにちは");
  process.env.FAKE_CLAUDE_MODE = "mentions-limit";
  r = await api("/api/ai-check", { method: "POST" });
  assert.equal(r.status, 200, "成功応答の本文に rate limit という語があっても失敗扱いにしない");
  delete process.env.FAKE_CLAUDE_MODE;
  r = await api("/api/settings", { method: "POST", body: { claudeModel: "gpt" } });
  assert.equal(r.status, 400);
  const home = process.env.USERPROFILE || process.env.HOME;
  const homeCred = join(home, ".claude", ".credentials.json");
  if (existsSync(homeCred)) {
    const before = statSync(homeCred).mtimeMs;
    await api("/api/ai-check", { method: "POST" });
    assert.equal(statSync(homeCred).mtimeMs, before, "本体の認証ファイルには書き戻さない");
  }
  await api("/api/settings", { method: "POST", body: { aiProvider: "gemini" } });
});

test("db.json が壊れていたら日次バックアップから復旧し、壊れたファイルは退避する", async () => {
  const { readFile: rf, writeFile: wf, readdir: rd, unlink: ul } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const good = await rf(_internals.DB_PATH, "utf8");
  await _internals.backupDbIfNeeded();
  const backups = (await rd(_internals.BACKUP_DIR)).filter((f) => f.startsWith("db-"));
  assert.ok(backups.length >= 1, "バックアップが1世代できる");
  await wf(_internals.DB_PATH, good.slice(0, 200), "utf8"); // 途中で切れたファイル
  const restored = await _internals.readDbFileWithRecovery();
  assert.ok(Array.isArray(restored.posts), "バックアップから読める");
  assert.match(restored.logs[0].message, /バックアップ db-.*から復旧/);
  // 復旧結果はその場で書き戻され、続けて読んでも退避ファイルは増えない
  const again = JSON.parse(await rf(_internals.DB_PATH, "utf8"));
  assert.ok(Array.isArray(again.posts), "復旧した内容が db.json に書き戻される");
  await _internals.readDbFileWithRecovery();
  await (await api("/api/state")).data;
  const corrupt = (await rd(join(_internals.DB_PATH, ".."))).filter((f) => f.startsWith("db.json.corrupt-"));
  assert.equal(corrupt.length, 1, "壊れたファイルの退避は1つだけ");
  // 壊れたファイルはバックアップ世代に混ざらない
  await wf(_internals.DB_PATH, "{broken", "utf8");
  const bkDir = _internals.BACKUP_DIR;
  const beforeBk = (await rd(bkDir)).filter((f) => f.startsWith("db-"));
  for (const f of beforeBk) await ul(join(bkDir, f));
  await _internals.backupDbIfNeeded.call(null);
  const afterBk = (await rd(bkDir)).filter((f) => f.startsWith("db-"));
  assert.equal(afterBk.length, 0, "壊れた db.json は世代にコピーしない");
  await wf(_internals.DB_PATH, good, "utf8");
  for (const f of corrupt) await ul(join(_internals.DB_PATH, "..", f)).catch(() => {});
  const st = await api("/api/state");
  assert.equal(st.status, 200);
  assert.equal(st.data.schemaVersion, undefined, "schemaVersion は画面には出さない（内部項目）");
});

test("https（認可コールバック用）が自己署名証明書で起動し、Redirect URI の既定は中継ページ（Meta は localhost を保存できない）", async () => {
  const state = await api("/api/state");
  assert.equal(state.data.https.enabled, true, state.data.https.reason);
  assert.equal(state.data.https.port, PORT + 1);
  assert.equal(state.data.settings.threadsRedirectUri, "https://bizcrea.com/threads/callback.html");
  // 旧既定値（localhost）が残っていたら中継ページに置き換える
  await _internals.withDb(async (db) => { db.settings.threadsRedirectUri = `https://localhost:${PORT + 1}/oauth/callback`; });
  const migrated = await api("/api/state");
  assert.equal(migrated.data.settings.threadsRedirectUri, "https://bizcrea.com/threads/callback.html");
  const status = await new Promise((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port: PORT + 1, path: "/oauth/callback?code=x&state=bogus", method: "GET", rejectUnauthorized: false, headers: { host: `localhost:${PORT + 1}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 400, "https 側でもコールバックが処理される（state 不一致で 400）");
});

// 別プロセスでサーバーを起動する（環境変数は読み込み時に固定されるため）。stdout に "ready" か、エラーで終了するまで待つ
function spawnServer(env, port) {
  return new Promise((resolve) => {
    const dataDir = mkdtempSync(join(tmpdir(), "threads-ops-pub-"));
    const code = `import("./server.js").then((m) => m.startServer(${port}, process.env.HOST || "127.0.0.1")).then(() => console.log("ready")).catch((e) => { console.error("FAIL " + e.message); process.exit(3); });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, THREADS_DATA_DIR: dataDir, THREADS_HTTPS: "0", ...env } });
    let out = ""; let err = "";
    child.stdout.on("data", (c) => { out += c; if (out.includes("ready")) resolve({ child, out, err, dataDir }); });
    child.stderr.on("data", (c) => { err += c; });
    child.on("exit", (code) => resolve({ child: null, code, out, err, dataDir }));
  });
}
function rawGet(port, path, headers, method = "GET", body = "") {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
}

test("サーバー運用: 公開URLの裏に置くときはアクセスキー無しで起動しない。公開ドメインの Host/Origin を受け付け、認可の戻り先が公開URLになる", async () => {
  // 1) THREADS_PUBLIC_ORIGIN あり・キー無し → 起動失敗
  let r = await spawnServer({ THREADS_PUBLIC_ORIGIN: "https://threads.example.com" }, 4301);
  assert.equal(r.child, null, "起動しない");
  assert.match(r.err, /アクセスキーが必要/);
  rmSync(r.dataDir, { recursive: true, force: true });
  // 2) キーあり → 起動。公開ドメインの Host は通り、無関係な Host は拒否。Redirect URI の既定が公開URL
  r = await spawnServer({ THREADS_PUBLIC_ORIGIN: "https://threads.example.com", THREADS_ACCESS_KEY: "server-key-0123" }, 4302);
  assert.ok(r.child, r.err);
  try {
    let res = await rawGet(4302, "/api/state", { host: "threads.example.com", "x-threads-key": "server-key-0123" });
    assert.equal(res.status, 200, res.body);
    const st = JSON.parse(res.body);
    assert.equal(st.publicOrigin, "https://threads.example.com");
    assert.equal(st.settings.threadsRedirectUri, "https://threads.example.com/oauth/callback");
    assert.equal(st.https.disabled, true);
    res = await rawGet(4302, "/api/state", { host: "threads.example.com" });
    assert.equal(res.status, 401, "キー無しは 401");
    res = await rawGet(4302, "/api/state", { host: "evil.example.net", "x-threads-key": "server-key-0123" });
    assert.equal(res.status, 421, "別の Host は拒否（既存の DNS リバインディング対策と同じ 421）");
    res = await rawGet(4302, "/threads/delete", { host: "threads.example.com" });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.body).url, /^https:\/\/threads\.example\.com\//, "削除通知の戻り先は公開URL");
    res = await rawGet(4302, "/oauth/callback?code=x&state=bogus", { host: "threads.example.com" });
    assert.equal(res.status, 400, "公開 Host で /oauth/callback に届く（state 不一致で 400 = Host 検査は通過）");
    // Origin 検査（書き込み）
    const key = { host: "threads.example.com", "x-threads-key": "server-key-0123", "x-threads-ops": "1" };
    res = await rawGet(4302, "/api/settings", { ...key, origin: "https://threads.example.com" }, "POST", "{}");
    assert.equal(res.status, 200, res.body);
    res = await rawGet(4302, "/api/settings", { ...key, origin: "https://evil.example.net" }, "POST", "{}");
    assert.equal(res.status, 403, "別 Origin からの書き込みは拒否");
    // 致命傷1: 公開運用ではキーを空にできない。db.json でキーが消えても無認証で通さない
    res = await rawGet(4302, "/api/settings", { ...key, origin: "https://threads.example.com" }, "POST", JSON.stringify({ accessKey: "" }));
    assert.equal(res.status, 400, "キーを空にできない");
    assert.match(JSON.parse(res.body).error, /空にできません/);
    const dbPath = join(r.dataDir, "db.json");
    const raw = JSON.parse(readFileSync(dbPath, "utf8"));
    raw.settings.accessKey = "";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(dbPath, JSON.stringify(raw), "utf8");
    res = await rawGet(4302, "/api/state", { host: "threads.example.com" });
    assert.ok([401, 503].includes(res.status), `キーが消えても無認証で通さない（1回目は古いキーの記憶で 401 でもよい）: ${res.status}`);
    await rawGet(4302, "/api/state", { host: "threads.example.com", "x-threads-key": "server-key-0123" }); // ここで db.json を読み直す
    res = await rawGet(4302, "/api/state", { host: "threads.example.com" });
    assert.equal(res.status, 503, "キーが消えたことを検知したら 503 で閉じる");
    assert.equal(JSON.parse(res.body).detail, "access-key-missing");
    res = await rawGet(4302, "/api/state", { host: "threads.example.com", "x-threads-key": "server-key-0123" });
    assert.equal(res.status, 503, "古いキーでも通さない");
  } finally {
    r.child.kill();
    await new Promise((resolve) => r.child.on("exit", resolve));
    rmSync(r.dataDir, { recursive: true, force: true });
  }
  // 3) HOST=0.0.0.0 でキー無し → 起動拒否。PUBLIC_ORIGIN の形が悪い → 起動拒否
  r = await spawnServer({ HOST: "0.0.0.0" }, 4303);
  assert.equal(r.child, null); assert.match(r.err, /アクセスキーが必要/);
  rmSync(r.dataDir, { recursive: true, force: true });
  for (const bad of ["threads.example.com", "https://threads.example.com/app", "http://threads.example.com"]) {
    r = await spawnServer({ THREADS_PUBLIC_ORIGIN: bad, THREADS_ACCESS_KEY: "server-key-0123" }, 4304);
    assert.equal(r.child, null, `${bad} は起動しない`); assert.match(r.err, /https:\/\/ドメイン の形/);
    rmSync(r.dataDir, { recursive: true, force: true });
  }
});

test("deploy/: Linux 用ファイルに CR が無く、シェルスクリプトの構文が通る", async () => {
  const dir = fileURLToPath(new URL("../deploy/", import.meta.url));
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.equal(text.includes("\r"), false, `${name} に CR が混ざっている`);
  }
  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  if (process.platform === "win32" && !existsSync(bash)) return;
  for (const name of ["install.sh", "update.sh"]) {
    const code = await new Promise((resolve) => spawn(bash, ["-n", join(dir, name)]).on("exit", resolve));
    assert.equal(code, 0, `${name} の構文エラー`);
  }
});

test("MCP サーバー: stdio で initialize / tools/list / tools/call が通り、アクセスキーを db.json から拾い、本体停止時は日本語の案内を返す", async () => {
  const mcpPath = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
  const rpc = (port, dataDir, messages) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpPath], { env: { ...process.env, PORT: String(port), THREADS_DATA_DIR: dataDir } });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", reject);
    child.on("exit", () => resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    child.stdin.end();
  });
  const dataDir = process.env.THREADS_DATA_DIR;
  // 1) 通常: initialize → tools/list → threads_status
  let res = await rpc(PORT, dataDir, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "threads_status", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "threads_list_posts", arguments: { status: "review", limit: 5 } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } }
  ]);
  const byId = (id) => res.find((m) => m.id === id);
  assert.equal(byId(1).result.serverInfo.name, "threads-ops-assistant");
  assert.ok(byId(2).result.tools.length >= 15);
  assert.ok(byId(2).result.tools.every((t) => t.inputSchema && t.description));
  const status = JSON.parse(byId(3).result.content[0].text);
  assert.equal(status.dashboardUrl, `http://localhost:${PORT}`);
  assert.equal(typeof status.threads.connected, "boolean");
  assert.ok(Array.isArray(JSON.parse(byId(4).result.content[0].text).posts));
  assert.equal(byId(5).error.code, -32602, "未知のツールは JSON-RPC エラー");
  // 2) アクセスキーが設定されていても db.json から拾って通る
  await api("/api/settings", { method: "POST", body: { accessKey: "mcp-key-12345" } });
  res = await rpc(PORT, dataDir, [{ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "threads_status", arguments: {} } }]);
  assert.equal(byId(6).result.isError, undefined, byId(6).result.content[0].text);
  await api("/api/settings", { method: "POST", body: { accessKey: "" }, headers: { "x-threads-key": "mcp-key-12345" } });
  // 3) 本体が居ないポート → isError と起動案内
  res = await rpc(4398, dataDir, [{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "threads_status", arguments: {} } }]);
  assert.equal(byId(7).result.isError, true);
  assert.match(byId(7).result.content[0].text, /起動\.cmd/);
});

test("MCP サーバー: 設定更新は許可キーだけ本体へ送り、秘密（accessKey 等）は落とす。protocolVersion は固定。バッチは -32600", async () => {
  const mcpPath = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
  const rpc = (messages, raw = false) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpPath], { env: { ...process.env, PORT: String(PORT), THREADS_DATA_DIR: process.env.THREADS_DATA_DIR } });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", reject);
    child.on("exit", () => resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.write((raw ? messages : messages.map((m) => JSON.stringify(m))).join("\n") + "\n");
    child.stdin.end();
  });
  const before = (await api("/api/state")).data.settings;
  let res = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "9999-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "threads_update_settings", arguments: { brandName: "mcp-brand", accessKey: "leak-key-999", threadsAppSecret: "leak-secret", threadsAccessToken: "leak-token", geminiApiKey: "leak-gemini" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "threads_update_settings", arguments: { accessKey: "only-secret" } } }
  ]);
  const byId = (id) => res.find((m) => m.id === id);
  assert.equal(byId(1).result.protocolVersion, "2025-06-18", "クライアントの未知バージョンをエコーしない");
  const r2 = JSON.parse(byId(2).result.content[0].text);
  assert.deepEqual(r2.updated, ["brandName"]);
  assert.deepEqual(r2.ignored.sort(), ["accessKey", "geminiApiKey", "threadsAccessToken", "threadsAppSecret"]);
  assert.equal(byId(3).result.isError, true, "秘密だけの呼び出しは更新しない");
  const after = (await api("/api/state")).data.settings;
  assert.equal(after.brandName, "mcp-brand");
  assert.equal(after.accessKey, before.accessKey, "accessKey は変わらない");
  assert.equal(after.threadsAppSecret, before.threadsAppSecret);
  assert.equal(after.threadsAccessToken, before.threadsAccessToken);
  // MCP 経由でキーが混入していないことを、認証が要求されないことでも確かめる（accessKey が入ると 401 になる）
  const plain = await realFetch(`${BASE}/api/state`, { headers: { "x-threads-ops": "1" } });
  assert.equal(plain.status, 200, "accessKey が MCP 経由で設定されてしまった");
  await api("/api/settings", { method: "POST", body: { brandName: before.brandName } });
  // バッチ（配列）は非対応と返す。無応答にしない
  res = await rpc(['[{"jsonrpc":"2.0","id":9,"method":"ping"}]'], true);
  assert.equal(res.length, 1);
  assert.equal(res[0].error.code, -32600);
});

test("配布スクリプト: stop.ps1 が threads-ops.env の THREADS_DATA_DIR から server.pid を探す（プラグイン配置の pid 位置）。install.ps1/uninstall.ps1 の静的検査", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const bom = (name) => readFileSync(join(root, name)).subarray(0, 3).toString("hex");
  for (const name of ["install.ps1", "stop.ps1", "uninstall.ps1", "register-autostart.ps1", "hooks/session-start.ps1"]) {
    assert.equal(bom(name), "efbbbf", `${name} は BOM 付き（PS5.1 が CP932 で読むため）`);
  }
  const installPs1 = readFileSync(join(root, "install.ps1"), "utf8");
  for (const needle of ['"stop.ps1"', '"uninstall.ps1"', '"アンインストール.md"', 'Get-ScheduledTask -TaskName $taskName', "server.pid", "GetEncoding(932)", '"停止.cmd"', '"アンインストール.cmd"', ".mcp.json"]) {
    assert.ok(installPs1.includes(needle), `install.ps1 に ${needle} が無い`);
  }
  assert.ok(!/Read-Host/.test(installPs1), "install.ps1 は質問しない");
  for (const name of ["stop.ps1", "uninstall.ps1"]) {
    const text = readFileSync(join(root, name), "utf8");
    assert.ok(!/\$pid\b/.test(text), `${name}: $pid は PowerShell の予約変数（代入できない）`);
  }
  assert.ok(readFileSync(join(root, "stop.ps1"), "utf8").includes("THREADS_DATA_DIR"), "stop.ps1: env から data の場所を読む");
  const uninstallPs1 = readFileSync(join(root, "uninstall.ps1"), "utf8");
  assert.ok(uninstallPs1.includes("stop.ps1"), "uninstall.ps1 は停止を stop.ps1 に任せる");
  assert.ok(uninstallPs1.includes("ConvertFrom-Json") && uninstallPs1.includes("enabledPlugins") && uninstallPs1.includes("installed_plugins.json"), "登録の削除は JSON を読んで書き戻す");
  for (const name of ["停止.cmd", "アンインストール.cmd"]) {
    const buf = readFileSync(join(root, name));
    assert.ok(buf.every((b) => b < 0x80), `${name} の中身は ASCII だけ（文字コードに依存しない）`);
    assert.ok(buf.toString().includes(name === "停止.cmd" ? "stop.ps1" : "uninstall.ps1"));
  }
  // publish-github.ps1: サブフォルダで git archive を実行すると 0 件になり、公開リポの全ファイルを消す（2026-09-22 実測）
  const publish = readFileSync(join(root, "publish-github.ps1"), "utf8");
  assert.ok(publish.includes('git -C "$top" archive'), "publish-github.ps1: archive はトップレベルで実行する");
  assert.ok(publish.includes('"server.js", "install.ps1"') && publish.includes("何も送らない"), "publish-github.ps1: 必須ファイルが無ければ送らない");
  assert.ok(publish.includes("[Console]::OutputEncoding"), "publish-github.ps1: git の UTF-8 出力を正しく読む");
  const installPy = readFileSync(join(root, "install.py"), "utf8");
  for (const needle of ['chmod(0o755)', 'hooks/session-start', 'SuccessfulExit', 'uninstall.py', 'signal.SIGTERM', '.mcp.json']) {
    assert.ok(installPy.includes(needle), `install.py に ${needle} が無い`);
  }
  if (process.platform !== "win32") return;
  // 実行: env が指す data に pid（存在しないプロセス）を置き、stop.ps1 がそこを見て片付けることを確かめる
  const appDir = mkdtempSync(join(tmpdir(), "threads-stop-app-"));
  const dataDir = mkdtempSync(join(tmpdir(), "threads-stop-data-"));
  const { writeFileSync, copyFileSync } = await import("node:fs");
  copyFileSync(join(root, "stop.ps1"), join(appDir, "stop.ps1"));
  writeFileSync(join(appDir, "threads-ops.env"), `# test\nTHREADS_DATA_DIR=${dataDir}\n`, "utf8");
  writeFileSync(join(dataDir, "server.pid"), "999999\n", "utf8");
  writeFileSync(join(appDir, "data-should-not-be-used.txt"), "", "utf8");
  const run = () => new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(appDir, "stop.ps1")], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("exit", (code) => resolve({ code, out }));
  });
  let r = await run();
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(dataDir, "server.pid")), "env が指す data の server.pid を片付ける");
  r = await run();
  assert.ok(r.out.includes(dataDir.split("\\").pop()), `2回目は env の data を指して「見つかりません」: ${r.out}`);
  rmSync(appDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test("配布スクリプト: アンインストール.cmd をダブルクリックと同じ経路（cwd が app 内）で通し、登録・タスク・フォルダが残らない", async () => {
  if (process.platform !== "win32") return;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { writeFileSync, copyFileSync, mkdirSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "threads-uninst-home-"));
  const base = join(home, ".claude", "threads-ops");
  const app = join(base, "app");
  const data = join(base, "data");
  const cache = join(home, ".claude", "plugins", "cache", "joshicrea", "joshicrea-threads-ops", "abc");
  for (const d of [app, data, cache]) mkdirSync(d, { recursive: true });
  copyFileSync(join(root, "uninstall.ps1"), join(app, "uninstall.ps1"));
  copyFileSync(join(root, "stop.ps1"), join(app, "stop.ps1"));
  copyFileSync(join(root, "アンインストール.cmd"), join(app, "アンインストール.cmd"));
  writeFileSync(join(app, "threads-ops.env"), `THREADS_DATA_DIR=${data}\n`, "utf8");
  writeFileSync(join(data, "db.json"), "{}", "utf8");
  writeFileSync(join(cache, "x.txt"), "x", "utf8");
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "joshicrea-secretary@joshicrea": true, "joshicrea-threads-ops@joshicrea": true }, permissions: { allow: [] } }), "utf8");
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "joshicrea-threads-ops@joshicrea": [{ scope: "user" }] } }), "utf8");
  const r = await new Promise((resolve) => {
    // 実際の cmd ラッパーを cwd=app で起動（エクスプローラのダブルクリックと同じ）。Read-Host と pause には stdin から答える
    const child = spawn("cmd.exe", ["/c", join(app, "アンインストール.cmd")], { cwd: app, windowsHide: true, env: { ...process.env, USERPROFILE: home, THREADS_TASK_NAME: "ThreadsOpsAssistantUninstTest" } });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("exit", (code) => resolve({ code, out }));
    child.stdin.write("y\r\n\r\n");
    child.stdin.end();
  });
  assert.equal(r.code, 0, r.out);
  const deadline = Date.now() + 15000;
  while (existsSync(base) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 500));
  assert.ok(!existsSync(base), `~/.claude/threads-ops が残っている:\n${r.out}`);
  assert.ok(!existsSync(join(home, ".claude", "plugins", "cache", "joshicrea", "joshicrea-threads-ops")), "plugins/cache が残っている");
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(settings.enabledPlugins), ["joshicrea-secretary@joshicrea"], "他のプラグインは残す");
  assert.ok(Array.isArray(settings.permissions.allow), "他の設定は残す");
  const installed = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8"));
  assert.deepEqual(Object.keys(installed.plugins), []);
  rmSync(home, { recursive: true, force: true });
});

test("静的配信: パストラバーサル拒否・no-cache", async () => {
  const big = await realFetch(`${BASE}/api/posts`, { method: "POST", headers: { "content-type": "application/json", "x-threads-ops": "1" }, body: JSON.stringify({ text: "x".repeat(1_100_000) }) });
  assert.equal(big.status, 413);
  let res = await realFetch(`${BASE}/`);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  res = await realFetch(`${BASE}/../server.js`);
  assert.notEqual(res.status, 200);
  res = await realFetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
});
