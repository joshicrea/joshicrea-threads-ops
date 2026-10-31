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
  replyStyle: { type: "string", description: "返信だけの文体（任意）。空なら投稿の文体ルールに合わせる" }, materials: { type: "string", description: "見せられるもの・素材（作品・商品・日常・実績・こだわり。任意）" }, materialFolder: { type: "string", description: "素材フォルダ（このPC上のパス。任意）。中の .md/.txt を読む" },
  scheduleTimes: { type: "string", description: "例: 07:00,12:00,20:00（日本時間）" },
  aiProvider: { type: "string", enum: ["claude-code", "codex", "gemini", "claude-api"] }, claudeModel: { type: "string", enum: ["sonnet", "opus", "haiku"] },
  autoPublishEnabled: { type: "boolean" }, autoFetchRepliesEnabled: { type: "boolean" }, autoFetchRepliesMinutes: { type: "integer" },
  autoReplyEnabled: { type: "boolean" }, autoReplyIntervalSec: { type: "integer" }, autoReplyDailyCap: { type: "integer" }, autoInsightsEnabled: { type: "boolean" },
  // アカバン防止ガード（出す前の安全確認）。数値は公式上限以外すべて暫定の目安
  safetyGuardEnabled: { type: "boolean", description: "出す前の安全確認。新規は既定ON・以前から使っているアカウントは既定OFF（推奨はON）。OFFでも公式上限の手前（G1 投稿・G11 返信の24時間件数）は止める。利用者が明示したときだけ変える" },
  safetyMaxPostsPer24h: { type: "integer", description: "G1 24時間の公開数の上限（公式250の手前・既定200）" },
  safetyDailyPostLimit: { type: "integer", description: "G2 1日（直近24時間）の投稿の上限。超えるなら止める（既定10・1〜250）。Meta は基準を公開していません。多くするほど止められやすくなる目安" },
  safetySurgeRatio: { type: "number", description: "G3 急増の倍率（注意・既定2・1〜10・小数第1位まで。例: 1.5）" },
  safetyMinIntervalMinutes: { type: "integer", description: "G4 投稿の最小間隔（分・既定10）" },
  safetySimilarBlockPct: { type: "integer", description: "G5 自分の過去投稿との一致率で止める%（既定70）" },
  safetySimilarWarnPct: { type: "integer", description: "G5 注意する%（既定45）" },
  safetyLinkWarnCount: { type: "integer", description: "G6 直近10本中のURL入り本数で注意（既定3）" },
  safetyBannedWords: { type: "string", description: "G9 アカウントごとの追加の禁止語（改行・カンマ区切り）。例（ペット）: お譲りします, 里親募集, 生体販売" },
  safetyReplySimilarPct: { type: "integer", description: "G10 自動返信の一致率で止める%（既定80）" },
  safetyReplyMaxPer24h: { type: "integer", description: "G11 24時間の返信数の上限（公式1,000の80%・既定800）" },
  // 発信テーマと宣伝。配列ごと置き換わる（1つ足すときも、threads_get_settings の今の配列に足して全部を渡す）
  themes: {
    type: "array",
    description: "発信テーマ（10個まで）。テーマを指定せずに投稿案を作ると、ここから割り当てる。空の配列なら今までどおり",
    items: { type: "object", properties: { id: { type: "string" }, name: { type: "string", description: "テーマ名（例: 温活）" }, audience: { type: "string", description: "誰に向けて（任意）" }, note: { type: "string", description: "補足（任意）" }, weight: { type: "integer", enum: [1, 2, 3], description: "出す量 1=たまに 2=ときどき 3=よく" }, everyDays: { type: "integer", minimum: 0, maximum: 30, description: "N日に1回は必ず（0=指定なし）" }, topicTag: { type: "string", description: "トピックタグ1つ（任意・#なし）" }, enabled: { type: "boolean" } }, required: ["name"], additionalProperties: false }
  },
  campaigns: {
    type: "array",
    description: "期間つきの宣伝したいもの（10件まで）。保存しただけでは投稿は作らない。作るのは threads_generate_campaign_posts",
    items: { type: "object", properties: { id: { type: "string" }, title: { type: "string", description: "宣伝したいもの（例: 電子書籍の無料ダウンロード）" }, detail: { type: "string", description: "何を・どう受け取れるか（本人の言葉。ここに無い事実は書かれない）" }, url: { type: "string", description: "URL（任意）" }, startDate: { type: "string", description: "始まり YYYY-MM-DD" }, endDate: { type: "string", description: "終わり YYYY-MM-DD（その日も含む・31日まで）" }, perDay: { type: "integer", enum: [1, 2, 3], description: "1日の本数（既定1）" }, linkInBody: { type: "boolean", description: "本文にURLを入れる（既定false。false ならプロフィールのリンクへ促す）" }, enabled: { type: "boolean" } }, required: ["title", "startDate", "endDate"], additionalProperties: false }
  }
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
  return { id: p.id, status: STATUS_LABEL[p.status] || p.status, category: p.category || "", ...(p.theme ? { theme: p.theme } : {}), ...(p.campaignId ? { campaignId: p.campaignId } : {}), scheduledAt: p.scheduledAt || "", publishedAt: p.publishedAt || "", permalink: p.permalink || "", error: p.error || "", text: p.text };
}
function briefReply(r) {
  return { id: r.id, status: REPLY_LABEL[r.status] || r.status, from: r.username || "", comment: r.text, draft: r.responseText || "", holdReason: r.holdReason || "", autoQueued: Boolean(r.autoQueued), timestamp: r.timestamp || "" };
}

// 利用者が次にやることを1つだけ返す（上から順に、最初に当てはまったもの）
function nextStep(s, tokenExpired) {
  const st = s.settings;
  const hosted = Boolean(st.threadsOAuthExchangeUrl);
  const local = Boolean(st.threadsAppId);
  const review = s.posts.filter((p) => p.status === "review").length;
  if (!hosted && !local) return `連携コードが未入力です。画面（http://localhost:${PORT}）の設定タブ「2. Threads連携」の連携コード欄に、提供元から届いた TOPS1. で始まるコードを貼って保存してください。チャットには貼らないでください。`;
  if (hosted && (!st.threadsOAuthClientToken || !st.expectedThreadsUsername)) return "連携コードの中身が足りません。提供元から届いた連携コードを、画面の設定タブにもう一度そのまま貼って保存してください。";
  if (!st.threadsAccessToken) return "Threads と連携します。threads_auth_url で連携用のページを開き、Threads の画面で許可してください（先に Threads アプリで、届いたテスター招待を承認しておく）。";
  if (tokenExpired) return "Threads の連携が期限切れです。threads_auth_url でもう一度連携してください。";
  if (st.aiProvider === "gemini" && !st.geminiApiKey) return "文章を作る AI が使えない設定です。threads_update_settings で aiProvider を claude-code にしてから、threads_ai_check で確かめてください。";
  if (!st.lastAiCheckAt) return "文章を作る AI がこの PC で動くか、threads_ai_check で確かめてください（最大3分）。";
  if (!st.brandName || !st.profile) return "発信者情報が空です。初回セットアップ（名前・何をしている人か・文体・最後の一言）を1問ずつ聞いて、threads_update_settings で保存してください。文体は好みを聞く前に、利用者が過去に書いた文章を2〜3本貼ってもらい、そこから決まりごとの下書きを作って本人に確かめてください（手順は threads_guide の「3. はじめて使う人」）。";
  if (review) return `承認待ちの投稿が ${review} 件あります。threads_list_posts（status=review）で本文を見せて、承認するか聞いてください。`;
  if ((st.themes || []).some((t) => t.enabled !== false)) return "投稿案を作れます。発信テーマが設定済みなので、テーマは聞かずに、目的だけ聞いて threads_generate_posts を topic なしで呼んでください（テーマは設定から自動で割り当てます）。";
  return "投稿案を作れます。目的とテーマを1つずつ聞いてから threads_generate_posts を呼んでください。";
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
      let safety = "";
      try {
        const g = await api("/api/safety");
        safety = g.enabled
          ? `安全確認ON: 直近24時間 ${g.posts.last24h}本（1日の上限${g.posts.dailyLimit}本・超えたら止める／今の設定の1日の投稿数${g.plannedPostsPerDay}本／公式上限250）・返信${g.replies.last24h}件・止めている投稿${g.blocked.posts}件/返信${g.blocked.replies}件。${g.disclaimer}`
          : "安全確認OFF（出す前の確認をしていません）";
      } catch (error) {
        safety = `安全確認の状態を読めませんでした（${error.message}）`;
      }
      return {
        dashboardUrl: `http://localhost:${PORT}`,
        safety,
        version: s.version,
        threads: { connected: Boolean(settings.threadsAccessToken) && !tokenExpired, username: settings.threadsUsername || "", tokenExpiresAt: settings.threadsTokenExpiresAt || "", expired: Boolean(tokenExpired) },
        ai: { provider: settings.aiProvider, lastCheckAt: settings.lastAiCheckAt || "" },
        automation: { autoPublish: Boolean(settings.autoPublishEnabled), autoFetchReplies: Boolean(settings.autoFetchRepliesEnabled), autoReply: Boolean(settings.autoReplyEnabled), autoReplyPausedUntil: settings.autoReplyPausedUntil || "", scheduleTimes: settings.scheduleTimes || "" },
        sender: { brandName: settings.brandName || "", profileFilled: Boolean(settings.profile), writingRulesFilled: Boolean(settings.writingRules) },
        posts: count(s.posts, (p) => STATUS_LABEL[p.status] || p.status),
        replies: count(s.replies, (r) => REPLY_LABEL[r.status] || r.status),
        recentLogs: s.logs.slice(0, 5).map((l) => `${l.at} [${l.level}] ${l.message}`),
        link: { expectedUsername: settings.expectedThreadsUsername || "", hostSet: Boolean(settings.threadsOAuthExchangeUrl), codeSet: Boolean(settings.threadsOAuthClientToken) },
        next: nextStep(s, Boolean(tokenExpired))
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
    description: "投稿案を AI で生成して「承認待ち」に入れる（外部には出ない）。goal=投稿の目的、topic=テーマ（省略可。設定に発信テーマがあり topic を省略すると、テーマを比率と「N日に1回」どおりに自動で割り当てる。発信テーマが無ければ聞いてから渡す）、count=本数（1〜12・既定8）、date=投稿日（YYYY-MM-DD・省略なら明日以降の予約枠）。生成後は threads_list_posts で本文を確認し、利用者に承認を求める。",
    inputSchema: { type: "object", properties: { goal: { type: "string" }, topic: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 12 }, date: { type: "string" } }, required: ["goal"], additionalProperties: false },
    run: async (args) => {
      const r = await api("/api/generate-posts", { method: "POST", body: args });
      return { created: (r.posts || []).map(briefPost), ...(r.themePlan ? { themes: r.themePlan } : {}) };
    }
  },
  {
    name: "threads_generate_campaign_posts",
    description: "設定の「宣伝したいもの」1件から、期間の日数×1日の本数ぶんの宣伝投稿を作り「承認待ち」に入れる（外部には出ない・自動で承認や予約はしない）。予約日時は期間内の各日にばらして入る。期間外の日時には承認・予約・公開できない。campaignId は threads_get_settings の campaigns[].id。宣伝の投稿は伸びにくいので、本数は少なめを勧める。作ったあとは threads_list_posts で全文を見せて、承認を求める。",
    inputSchema: { type: "object", properties: { campaignId: { type: "string" } }, required: ["campaignId"], additionalProperties: false },
    run: async ({ campaignId }) => {
      const r = await api(`/api/campaigns/${encodeURIComponent(campaignId)}/generate`, { method: "POST", body: {} });
      return { created: (r.posts || []).map(briefPost), planned: r.planned, missing: r.missing, skipped: r.skipped || [], skippedDays: r.skippedDays || [] };
    }
  },
  {
    name: "threads_research",
    description: "同じジャンルで反応を集めている Threads の投稿をまとめて調べる（裏で進むジョブ。1テーマで5〜10分ほど、最大20分で打ち切り）。keyword を省略すると、設定の発信テーマ（最大3つ）ごとに調べる。keyword を渡すときは、設定のどの発信テーマの分かを theme に入れる（入れると、そのテーマの投稿を作るときに使われる。入れなければその場の調べものとして扱い、次のその場の調べもので入れ替わる）。候補は Threads のページで全文と実際のいいね・返信数を確かめたものだけを残し、日本語でないもの・確かめられないものを除き、反応の大きい順に pick 件（既定5）を投稿生成の参考に自動で使い、型（フックの種類・構造）を分析する。minLikes=いいねの下限、maxAgeDays=何日以内の投稿だけにするか（0は制限なし）。開始したら threads_research_status で進み具合と結果を確かめる。",
    inputSchema: { type: "object", properties: { keyword: { type: "string" }, theme: { type: "string" }, minLikes: { type: "integer", minimum: 0 }, maxAgeDays: { type: "integer", minimum: 0 }, pick: { type: "integer", minimum: 1, maximum: 8 } }, additionalProperties: false },
    run: async (args) => {
      const r = await api("/api/research/run", { method: "POST", body: args });
      return { job: r.job, alreadyRunning: Boolean(r.alreadyRunning), targets: r.targets || [], next: "数分おきに threads_research_status で確かめる（待つ間に他の作業をしてよい）" };
    }
  },
  {
    name: "threads_research_status",
    description: "threads_research の進み具合と結果を返す。cancel=true で進行中のリサーチを止める（今開いているページが終わったところで止まり、集め終わった分は残る）。終わっていれば、テーマごとの件数（候補→ページで確かめられた→使う）・除外の理由・自動で使うことにした投稿（いいね・返信・フックの種類・本文の冒頭・元投稿のURL）を返す。結果は利用者に、数字とURLを添えてそのまま見せる。",
    inputSchema: { type: "object", properties: { jobId: { type: "string" }, cancel: { type: "boolean" } }, additionalProperties: false },
    run: async ({ jobId, cancel }) => {
      const target = encodeURIComponent(jobId || "latest");
      if (cancel) await api(`/api/research/jobs/${target}/cancel`, { method: "POST", body: {} });
      return api(`/api/research/jobs/${target}`);
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
    name: "threads_safety_override",
    description: "出す前の安全確認で止まった投稿（type=post）またはコメント返信（type=reply）を、理由を確認したうえで出せるようにする（画面の「理由を確認して出す」と同じ）。必ず先に confirm を付けずに呼んで、返ってきた本文と止めた理由（規則名・日本語の理由）を利用者にそのまま全文見せ、利用者が「理由を確認した、出してよい」と明示したときだけ confirm=true で呼ぶ。利用者の同意なしに confirm=true で呼ばない。これ自体は公開・返信をしない（公開・予約・返信は別の操作）。本文を変えると解除は無効になり、本数・間隔の理由（G2・G4）の解除は24時間で切れる。公式上限（G1・G11）は解除できない。",
    inputSchema: { type: "object", properties: { type: { type: "string", enum: ["post", "reply"] }, id: { type: "string" }, confirm: { type: "boolean", description: "利用者が本文と理由を見て明示的に同意したときだけ true" } }, required: ["type", "id"], additionalProperties: false },
    run: async ({ type, id, confirm }) => {
      if (confirm !== true) {
        const s = await api("/api/state");
        const item = type === "post" ? s.posts.find((p) => p.id === id) : s.replies.find((r) => r.id === id);
        if (!item) throw new Error(`${type === "post" ? "投稿" : "コメント"}が見つかりません: ${id}`);
        const reasons = (item.safety?.reasons || []).map((r) => ({ rule: r.rule, name: r.name, level: r.level === "blocked" ? "止めた" : "注意", message: r.message }));
        return {
          confirmed: false,
          text: type === "post" ? item.text : item.responseText || "",
          reasons,
          disclaimer: s.safety?.disclaimer || "",
          next: reasons.some((r) => r.level === "止めた") ? "この本文と理由を利用者にそのまま見せ、同意を得てから confirm=true で呼んでください。" : "安全確認で止まっていません。"
        };
      }
      const path = type === "post" ? `/api/posts/${encodeURIComponent(id)}/safety-override` : `/api/replies/${encodeURIComponent(id)}/safety-override`;
      const result = await api(path, { method: "POST", body: { confirm: true } });
      return type === "post" ? { confirmed: true, post: briefPost(result.post) } : { confirmed: true, reply: briefReply(result.reply) };
    }
  },
  {
    name: "threads_set_reply",
    description: "コメントの下書きを書き換える／対応しないにする／未対応に戻す。status: ignored=対応しない, unhandled=未対応に戻す（下書きがあれば下書きありに戻る）。responseText で下書きを差し替え。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["ignored", "unhandled"] }, responseText: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: async ({ id, ...body }) => ({ reply: briefReply((await api(`/api/replies/${encodeURIComponent(id)}`, { method: "PUT", body })).reply) })
  },
  {
    name: "threads_insights",
    description: "インサイト（閲覧・いいね・返信）を取り込み、カテゴリ別・時間帯別・テーマ別（byTheme）・投稿別の集計と、1文目の型別の実績（typeStats。本数5未満の型は判定不能）を返す。テーマ別は閲覧数・反応の平均で、フォロワーがどのテーマで増えたかは分からない。refresh=false なら取り込まず集計だけ。",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean", default: true } }, additionalProperties: false },
    run: async ({ refresh = true }) => {
      const fetched = refresh ? await api("/api/refresh-insights", { method: "POST" }) : null;
      const s = await api("/api/state");
      return { fetched, stats: s.stats, typeStats: await api("/api/pattern-stats") };
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
      const pick = ["expectedThreadsUsername", "threadsOAuthExchangeUrl", "aiProvider", "claudeModel", "brandName", "profile", "writingRules", "defaultCta", "scheduleTimes", "autoPublishEnabled", "autoFetchRepliesEnabled", "autoFetchRepliesMinutes", "autoReplyEnabled", "autoReplyIntervalSec", "autoReplyDailyCap", "autoInsightsEnabled", "threadsUsername", "threadsTokenExpiresAt", "threadsRedirectUri"];
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
  },
  {
    name: "threads_guide",
    description: "利用者を案内するための指示書（再接続・初回設定・安全な初期値・詰まったとき）を返す。接続したら最初に読み、その順で利用者を案内する。Claude Code でも Codex でも同じ内容が返る。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const p = join(here, "..", "指示書.md");
      if (!existsSync(p)) throw new Error("指示書が見つかりません。インストールをもう一度実行してください（提供元に連絡してもよい）。");
      return readFileSync(p, "utf8");
    }
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
      serverInfo: { name: "threads-ops-assistant", version: "0.4.0" },
      instructions: "Threads運用アシスタント（ローカル常駐サーバー）を操作するツール群。接続したら最初に threads_guide を呼んで指示書を読み、その順で利用者を案内する。続けて threads_status を呼ぶ。承認・公開・返信の送信は利用者が本文を見て明示したときだけ行う。"
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
      return reply(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] });
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
