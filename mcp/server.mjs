// Threads運用アシスタント MCP サーバー（stdio）
// 実行環境: クロスプラットフォーム（Node.js 20以上・外部依存なし）
//
// 役割: Claude Code / Cursor のチャットから、ローカルで動いている運用アシスタント（http://localhost:4173）を操作する薄い橋渡し。
// 判断や生成はすべて本体サーバー側で行う。ここは HTTP を呼んで結果を返すだけ。
// 本体が動いていなければ、その旨と起動方法を返す（自動返信・予約投稿は本体が常駐している間だけ動く）。
//
// 安全: 公開（threads_publish_now）と返信（threads_reply）は、利用者が本文を見て明示的に指示したときだけ呼ぶ
//       （呼ぶ側の指示は CLAUDE.md / skills に書いてある）。承認前の投稿は本体サーバーが送らない。
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const PORT = Number(process.env.PORT || 4173);
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const START_HINT = process.platform === "win32" ? "起動.cmd" : "起動.command";

// threads_update_settings が受け付けるキー。ここに無いもの（accessKey・トークン・API キー等の秘密）は本体へ送らない
const SETTINGS_PROPS = {
  brandName: { type: "string" }, profile: { type: "string" }, writingRules: { type: "string" }, defaultCta: { type: "string" },
  scheduleTimes: { type: "string", description: "例: 07:00,12:00,20:00（日本時間）" },
  aiProvider: { type: "string", enum: ["claude-code", "codex", "gemini", "claude-api"] }, claudeModel: { type: "string", enum: ["sonnet", "opus", "haiku"] },
  autoPublishEnabled: { type: "boolean" }, autoFetchRepliesEnabled: { type: "boolean" }, autoFetchRepliesMinutes: { type: "integer" },
  autoReplyEnabled: { type: "boolean" }, autoReplyIntervalSec: { type: "integer" }, autoReplyDailyCap: { type: "integer" }, autoInsightsEnabled: { type: "boolean" }
};

// データ置き場（アクセスキーを読むため）。THREADS_DATA_DIR → プラグイン標準の置き場 → 本体フォルダの data/ の順
function dataDirCandidates() {
  const list = [];
  if (process.env.THREADS_DATA_DIR) list.push(process.env.THREADS_DATA_DIR);
  list.push(join(homedir(), ".claude", "threads-ops", "data"));
  list.push(join(here, "..", "data"));
  return list;
}

function readAccessKey() {
  for (const dir of dataDirCandidates()) {
    const p = join(dir, "db.json");
    if (!existsSync(p)) continue;
    try {
      return String(JSON.parse(readFileSync(p, "utf8")).settings?.accessKey || "");
    } catch {
      return "";
    }
  }
  return "";
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json", "x-threads-ops": "1", origin: `http://localhost:${PORT}` };
  const key = readAccessKey();
  if (key) headers["x-threads-key"] = key;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(310_000) });
  } catch (error) {
    throw new Error(`運用アシスタント本体（${BASE}）に接続できません。本体が起動していないようです。${START_HINT} を実行するか、PC を再起動してください。（${error.message}）`);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = { error: `本体から読めない応答（HTTP ${res.status}）` };
  }
  if (!res.ok) throw new Error(`${data.error || `HTTP ${res.status}`}${data.detail ? `（${data.detail}）` : ""}`);
  return data;
}

const STATUS_LABEL = { review: "承認待ち", approved: "承認済み", scheduled: "予約済み", published: "公開済み", rejected: "却下", error: "エラー" };
const REPLY_LABEL = { unhandled: "未対応", drafted: "下書きあり", held: "要確認", responded: "返信済み", ignored: "対応しない", error: "エラー" };

function briefPost(p) {
  return { id: p.id, status: STATUS_LABEL[p.status] || p.status, category: p.category || "", scheduledAt: p.scheduledAt || "", publishedAt: p.publishedAt || "", permalink: p.permalink || "", error: p.error || "", text: p.text };
}
function briefReply(r) {
  return { id: r.id, status: REPLY_LABEL[r.status] || r.status, from: r.username || "", comment: r.text, draft: r.responseText || "", holdReason: r.holdReason || "", autoQueued: Boolean(r.autoQueued), timestamp: r.timestamp || "" };
}

const tools = [
  {
    name: "threads_status",
    description: "運用アシスタントの状態を返す（Threads 連携・AI・自動処理の設定、投稿とコメントの件数、要確認の件数、画面の URL）。最初にこれを呼んで状況を掴む。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const s = await api("/api/state");
      const count = (list, key) => list.reduce((acc, item) => { acc[key(item)] = (acc[key(item)] || 0) + 1; return acc; }, {});
      const settings = s.settings;
      const tokenExpired = settings.threadsTokenExpiresAt && Date.parse(settings.threadsTokenExpiresAt) < Date.now();
      return {
        dashboardUrl: `http://localhost:${PORT}`,
        version: s.version,
        threads: { connected: Boolean(settings.threadsAccessToken) && !tokenExpired, username: settings.threadsUsername || "", tokenExpiresAt: settings.threadsTokenExpiresAt || "", expired: Boolean(tokenExpired) },
        ai: { provider: settings.aiProvider, lastCheckAt: settings.lastAiCheckAt || "" },
        automation: { autoPublish: Boolean(settings.autoPublishEnabled), autoFetchReplies: Boolean(settings.autoFetchRepliesEnabled), autoReply: Boolean(settings.autoReplyEnabled), autoReplyPausedUntil: settings.autoReplyPausedUntil || "", scheduleTimes: settings.scheduleTimes || "" },
        sender: { brandName: settings.brandName || "", profileFilled: Boolean(settings.profile), writingRulesFilled: Boolean(settings.writingRules) },
        posts: count(s.posts, (p) => STATUS_LABEL[p.status] || p.status),
        replies: count(s.replies, (r) => REPLY_LABEL[r.status] || r.status),
        recentLogs: s.logs.slice(0, 5).map((l) => `${l.at} [${l.level}] ${l.message}`)
      };
    }
  },
  {
    name: "threads_list_posts",
    description: "投稿を一覧する。status で絞れる（review=承認待ち, approved=承認済み, scheduled=予約済み, published=公開済み, rejected=却下, error=エラー）。",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: Object.keys(STATUS_LABEL) }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    run: async ({ status, limit = 20 }) => {
      const s = await api("/api/state");
      const list = s.posts.filter((p) => !status || p.status === status).slice(0, limit).map(briefPost);
      return { count: list.length, posts: list };
    }
  },
  {
    name: "threads_generate_posts",
    description: "投稿案を AI で生成して「承認待ち」に入れる（外部には出ない）。goal=投稿の目的、topic=テーマ、count=本数（1〜12・既定8）、date=投稿日（YYYY-MM-DD・省略なら明日以降の予約枠）。生成後は threads_list_posts で本文を確認し、利用者に承認を求める。",
    inputSchema: { type: "object", properties: { goal: { type: "string" }, topic: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 12 }, date: { type: "string" } }, required: ["goal", "topic"], additionalProperties: false },
    run: async (args) => {
      const r = await api("/api/generate-posts", { method: "POST", body: args });
      return { created: (r.posts || []).map(briefPost) };
    }
  },
  {
    name: "threads_edit_post",
    description: "投稿の本文を書き換える（承認済み・予約済みは承認待ちに戻る。公開済みは変更不可）。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false },
    run: async ({ id, text }) => ({ post: briefPost((await api(`/api/posts/${encodeURIComponent(id)}`, { method: "PUT", body: { text } })).post) })
  },
  {
    name: "threads_post_action",
    description: "投稿の状態を変える。action: approve=承認（利用者が本文を見て承認すると言ったときだけ）, reject=却下, restore=却下から承認待ちへ戻す, schedule=予約（scheduledAt を ISO 8601 で。省略時は次の予約枠）, unschedule=予約解除。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["approve", "reject", "restore", "schedule", "unschedule"] }, scheduledAt: { type: "string" } }, required: ["id", "action"], additionalProperties: false },
    run: async ({ id, action, scheduledAt }) => ({ post: briefPost((await api(`/api/posts/${encodeURIComponent(id)}/transition`, { method: "POST", body: { action, scheduledAt } })).post) })
  },
  {
    name: "threads_publish_now",
    description: "承認済み・予約済みの投稿を今すぐ Threads に公開する（外部に出る）。利用者が投稿 ID か本文を指して「今すぐ投稿して」と明示したときだけ呼ぶ。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: async ({ id }) => ({ post: briefPost((await api(`/api/posts/${encodeURIComponent(id)}/publish`, { method: "POST" })).post) })
  },
  {
    name: "threads_fetch_replies",
    description: "Threads から新着コメントを取り込む（自動取り込み ON なら5分ごとに裏でも行われる）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => api("/api/fetch-replies", { method: "POST" })
  },
  {
    name: "threads_list_replies",
    description: "コメントを一覧する。status で絞れる（unhandled=未対応, drafted=下書きあり, held=要確認, responded=返信済み, ignored=対応しない, error=エラー）。要確認（held）は人が判断する必要があるもの。",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: Object.keys(REPLY_LABEL) }, limit: { type: "integer", minimum: 1, maximum: 200, default: 30 } }, additionalProperties: false },
    run: async ({ status, limit = 30 }) => {
      const s = await api("/api/state");
      const list = s.replies.filter((r) => !status || r.status === status).slice(0, limit).map(briefReply);
      return { count: list.length, replies: list };
    }
  },
  {
    name: "threads_draft_replies",
    description: "未対応のコメントを AI がまとめて判定し、返信の下書きを作る（10件ずつ・送信はしない）。自動返信 ON なら下書きは裏で順に送られる。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => api("/api/replies/draft-batch", { method: "POST" })
  },
  {
    name: "threads_reply",
    description: "コメントに返信を送る（外部に出る）。text を省略すると保存済みの下書きを送る。利用者が本文を見て「この内容で返信して」と明示したときだけ呼ぶ。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: async ({ id, text }) => ({ reply: briefReply((await api(`/api/replies/${encodeURIComponent(id)}/respond`, { method: "POST", body: { text } })).reply) })
  },
  {
    name: "threads_set_reply",
    description: "コメントの下書きを書き換える／対応しないにする／未対応に戻す。status: ignored=対応しない, unhandled=未対応に戻す（下書きがあれば下書きありに戻る）。responseText で下書きを差し替え。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["ignored", "unhandled"] }, responseText: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: async ({ id, ...body }) => ({ reply: briefReply((await api(`/api/replies/${encodeURIComponent(id)}`, { method: "PUT", body })).reply) })
  },
  {
    name: "threads_insights",
    description: "インサイト（閲覧・いいね・返信）を取り込み、カテゴリ別・時間帯別・投稿別の集計を返す。refresh=false なら取り込まず集計だけ。",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean", default: true } }, additionalProperties: false },
    run: async ({ refresh = true }) => {
      const fetched = refresh ? await api("/api/refresh-insights", { method: "POST" }) : null;
      const s = await api("/api/state");
      return { fetched, stats: s.stats };
    }
  },
  {
    name: "threads_suggestions",
    description: "実績（インサイト付きの公開投稿3件以上）から改善提案を AI で作る。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => api("/api/suggestions", { method: "POST" })
  },
  {
    name: "threads_get_settings",
    description: "発信者情報と運用設定を返す（秘密の値は伏字）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const s = (await api("/api/state")).settings;
      const pick = ["aiProvider", "claudeModel", "brandName", "profile", "writingRules", "defaultCta", "scheduleTimes", "autoPublishEnabled", "autoFetchRepliesEnabled", "autoFetchRepliesMinutes", "autoReplyEnabled", "autoReplyIntervalSec", "autoReplyDailyCap", "autoInsightsEnabled", "threadsUsername", "threadsTokenExpiresAt", "threadsRedirectUri"];
      return Object.fromEntries(pick.map((k) => [k, s[k]]));
    }
  },
  {
    name: "threads_update_settings",
    description: "発信者情報・運用設定を更新する（秘密の値は扱わない。Threads 連携やキーは画面で行う）。自動返信 ON など外部に出る設定は、利用者が明示したときだけ変える。",
    inputSchema: { type: "object", properties: SETTINGS_PROPS, additionalProperties: false },
    run: async (args) => {
      // クライアントは additionalProperties を強制しないので、ここで秘密のキーを落とす
      const body = Object.fromEntries(Object.entries(args || {}).filter(([k]) => Object.hasOwn(SETTINGS_PROPS, k)));
      const ignored = Object.keys(args || {}).filter((k) => !Object.hasOwn(SETTINGS_PROPS, k));
      if (!Object.keys(body).length) throw new Error(`更新できる項目がありません。受け付けるのは ${Object.keys(SETTINGS_PROPS).join(", ")} です（秘密の値は画面で設定してください）`);
      const r = await api("/api/settings", { method: "POST", body });
      return { updated: Object.keys(body), ignored, settings: { brandName: r.settings.brandName, autoReplyEnabled: r.settings.autoReplyEnabled, autoPublishEnabled: r.settings.autoPublishEnabled } };
    }
  },
  {
    name: "threads_ai_check",
    description: "AI プロバイダ（Claude Code など）に接続できるか試す（最大3分）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => api("/api/ai-check", { method: "POST" })
  },
  {
    name: "threads_auth_url",
    description: "Threads と連携するための認可 URL を返す（利用者がブラウザで開いて許可する）。連携前にテスター招待の承認が要る。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => api("/api/threads-auth-url")
  }
];

const byName = new Map(tools.map((t) => [t.name, t]));

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "threads-ops-assistant", version: "0.3.1" },
      instructions: "Threads運用アシスタント（ローカル常駐サーバー）を操作するツール群。最初に threads_status を呼ぶ。承認・公開・返信の送信は利用者が本文を見て明示したときだけ行う。"
    });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === "tools/call") {
    const tool = byName.get(params?.name);
    if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const result = await tool.run(params.arguments || {});
      return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (error) {
      return reply(id, { content: [{ type: "text", text: `エラー: ${error.message}` }], isError: true });
    }
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

// 入力が閉じても、処理中の呼び出し（AI 生成など数十秒）が終わるまで待ってから終了する
const pending = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return replyError(null, -32700, "parse error");
  }
  if (Array.isArray(msg) || !msg || typeof msg !== "object") return replyError(null, -32600, "invalid request (batch is not supported)");
  const task = handle(msg).catch((error) => { if (msg.id !== undefined) replyError(msg.id, -32603, error.message); });
  pending.add(task);
  task.finally(() => pending.delete(task));
});
rl.on("close", async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
