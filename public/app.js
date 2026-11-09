// Threads運用アシスタント フロント
// 実行環境: ブラウザ（モダンブラウザ想定・ビルド不要）
// サーバーが状態遷移を強制するため、ここでの判定は「ボタンを出すかどうか」だけ。

const state = {
  settings: {},
  posts: [],
  replies: [],
  insights: [],
  research: [],
  researchRuns: [],
  researchJob: null,
  references: [],
  referenceAnalysis: null,
  suggestions: [],
  logs: [],
  stats: null,
  editingId: null,
  // "auto" = 最初に開いたとき、対応が要るものがあれば「要対応」、無ければ「予約済み」を開く（判定は1回だけ）
  queueFilter: "auto",
  replyFilter: "open"
};

// 長い一覧は最初に決まった件数だけ出し、「さらに表示」で足す（全件に届く）
const LIST_STEP = { queue: 20, refs: 20, posts: 20, sugg: 3 };
const listLimit = { ...LIST_STEP };
const ACTION_STATUSES = ["review", "approved", "error"];
// 予約済みのまま予定時刻を過ぎた投稿（自動送信OFF・PC停止などで送られていない）。要対応に入れる
// 安全確認で後ろへずらしている予約は「過ぎている」に入れない（自動送信が時刻を待って片づける）
const isOverdue = (p) => p.status === "scheduled" && Boolean(p.scheduledAt) && Date.parse(p.scheduledAt) < Date.now() && !safetyDeferred(p);
// 失敗から3日を過ぎたエラーは要対応に数えない（通信の一時的な失敗が何週間も要対応に残り、新しい失敗が埋もれていた）。エラーの絞り込みには出す
const STALE_ERROR_DAYS = 3;
const isStaleError = (p) => {
  // 公開されたか分からない失敗は片づけない（Threads 側に出ていれば照合で公開済みに直る。その照合は7日以内のエラーだけを見る）
  if (p.status !== "error" || p.sendUncertainAt || p.sendFailure?.outcome === "unknown") return false;
  // 予約時刻は失敗した時刻ではない（PC停止で溜まった古い予約が今日失敗しても「古い」にしない）
  const at = Date.parse(p.publishFailedAt || p.sendFailure?.attemptedAt || p.updatedAt || "");
  return Number.isFinite(at) && at < Date.now() - STALE_ERROR_DAYS * 86_400_000;
};
let stateLoaded = false;

function moreRowHtml(key, shown, total) {
  if (total <= shown) return total > LIST_STEP[key] ? `<p class="more-note">${total}件をすべて表示しています</p>` : "";
  const next = Math.min(LIST_STEP[key], total - shown);
  return `<div class="more-row"><button class="button secondary" type="button" data-more="${key}">さらに${next}件を表示</button><span class="more-note">${shown} / ${total}件を表示中</span></div>`;
}

const VIEW_DESC = {
  dashboard: "今やることと、投稿・コメントの状況をまとめて見られます。",
  research: "反応を集めている投稿と、事実の裏付けになるWebの情報を集めます。",
  generate: "集めた材料から、AIが投稿案を作ります。承認するまで外には出ません。",
  queue: "投稿案を確かめて、承認・予約します。対応が要るものから並びます。",
  replies: "届いたコメントを取り込み、返信を下書きしてから送ります。",
  analysis: "公開した投稿の反応を集計して、次の投稿の改善につなげます。",
  settings: "AI・Threads連携・発信者の情報・自動で動かす処理を決めます。"
};

const VIEW_TITLES = {
  dashboard: "概要",
  research: "リサーチ",
  generate: "投稿生成",
  queue: "投稿キュー",
  replies: "コメント返信",
  analysis: "分析・改善",
  settings: "設定"
};

const STATUS_LABEL = {
  review: "承認待ち", approved: "承認済み", scheduled: "予約済み",
  published: "公開済み", rejected: "却下", error: "エラー"
};
const REPLY_STATUS_LABEL = { unhandled: "未対応", drafted: "下書きあり", held: "要確認", responded: "返信済み", ignored: "対応しない", error: "エラー" };
const CATEGORY_LABEL_FALLBACK = "未分類";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", weekday: "short" });
}

function toLocalDatetime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalDatetime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

// href に入れるURLは http/https だけ（サーバーでも検証しているが二重に守る）
function safeHref(url) {
  return /^https?:\/\//i.test(String(url || "")) ? escapeHtml(url) : "";
}

// コメントの添付画像は Threads 側の期限付きURL（oe= の時刻を過ぎると 403）。読めないときは壊れた画像の印を出さず、元のコメントへのリンクにする
document.addEventListener("error", (event) => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("reply-media")) return;
  const link = img.closest("a.reply-media-link");
  if (!link) return;
  const permalink = link.dataset.permalink || "";
  const note = document.createElement(permalink ? "a" : "span");
  note.className = "reply-media-expired";
  note.textContent = permalink ? "画像の表示期限が切れました。Threads で見る" : "画像の表示期限が切れました。コメントを取得し直すと出ることがあります";
  if (permalink) { note.href = permalink; note.target = "_blank"; note.rel = "noreferrer"; }
  link.replaceWith(note);
}, true);

let toastTimer;
// エラーは自動で消さない（クリックで閉じる）。detail があれば「詳細」で展開できる
function toast(message, kind = "info", ms = 5000, detail = "") {
  const el = $("#toast");
  el.innerHTML = `<span>${escapeHtml(message)}</span>${detail ? `<details class="toast-detail"><summary>詳細</summary><pre>${escapeHtml(String(detail).slice(0, 1500))}</pre></details>` : ""}${kind === "error" ? `<button type="button" class="toast-close" aria-label="閉じる">×</button>` : ""}`;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (kind !== "error") toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// アクセスキー（設定で決めたときだけ要る）。このブラウザにだけ覚える
function getAccessKey() {
  try { return localStorage.getItem("threadsOpsAccessKey") || ""; } catch { return ""; }
}
function setAccessKey(value) {
  try { if (value) localStorage.setItem("threadsOpsAccessKey", value); else localStorage.removeItem("threadsOpsAccessKey"); } catch { /* プライベートモード等 */ }
}
let askingAccessKey = null; // 入力待ちの Promise（同時に走った呼び出しは同じ入力を待つ）

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "content-type": "application/json", "x-threads-ops": "1", ...(getAccessKey() ? { "x-threads-key": getAccessKey() } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = { error: `サーバーから読めない応答が返りました（HTTP ${res.status}）。` };
  }
  if (res.status === 401 && data.detail === "access-key" && !options.noRetry) {
    if (!askingAccessKey) {
      askingAccessKey = (async () => {
        const entered = window.prompt("この画面にはアクセスキーが設定されています。設定したアクセスキーを入力してください。");
        if (entered === null) throw new Error("アクセスキーが未入力のため、操作を中止しました。");
        setAccessKey(entered.trim());
      })().finally(() => { askingAccessKey = null; });
    }
    await askingAccessKey;
    return api(path, { ...options, noRetry: true });
  }
  if (!res.ok) {
    const error = new Error(data.error || `APIエラー（HTTP ${res.status}）`);
    error.detail = data.detail || "";
    throw error;
  }
  return data;
}

// ボタン連打を防ぐ。処理中はボタンを無効化して文言を変える。
async function busy(button, label, task) {
  if (button?.disabled) return;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = label;
  }
  try {
    return await task();
  } catch (error) {
    toast(error.message, "error", 0, error.detail || "");
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function loadState({ keepSettingsForm = false } = {}) {
  const data = await api("/api/state");
  Object.assign(state, data);
  stateLoaded = true;
  render({ keepSettingsForm });
}

function showView(name, options = {}) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === name));
  $("#viewTitle").textContent = VIEW_TITLES[name] || name;
  $("#viewDesc").textContent = VIEW_DESC[name] || "";
  if (options.filter && name === "queue") { state.queueFilter = options.filter; listLimit.queue = LIST_STEP.queue; }
  if (options.filter && name === "replies") state.replyFilter = options.filter;
  // 切り替えた先を最新の state で描く（設定は未保存編集があれば触らない）
  if (name === "settings") {
    renderSettingsStatus();
    if (!settingsDirty) renderSettings();
  } else {
    VIEW_RENDERERS[name]?.();
  }
  window.scrollTo({ top: 0 });
}

// 設定フォームに未保存の編集があるか（あるあいだは定期更新でフォームを上書きしない）
let settingsDirty = false;

const VIEW_RENDERERS = {
  dashboard: () => {},
  research: () => { renderAutoResearch(); renderReferences(); renderResearch(); },
  generate: renderGenerateInputs,
  queue: renderQueue,
  replies: renderReplies,
  analysis: renderAnalysis,
  settings: renderSettings
};

function activeViewName() {
  return $$(".view").find((v) => v.classList.contains("active"))?.id || "dashboard";
}

// 表示中のビューだけ描き直す（数百件のカードを毎分7ビューぶん作り直さない）。設定は未保存編集があれば触らない
function render({ keepSettingsForm = false } = {}) {
  renderStatus();
  renderDashboard();
  const name = activeViewName();
  if (name === "settings") {
    renderSettingsStatus();
    if (!keepSettingsForm && !settingsDirty) renderSettings();
    return;
  }
  VIEW_RENDERERS[name]?.();
}

// ---------------------------------------------------------------------------
// 概要
// ---------------------------------------------------------------------------
function countStatus(name) {
  return state.posts.filter((post) => post.status === name).length;
}

function openReplies() {
  return state.replies.filter((reply) => ["unhandled", "drafted", "error"].includes(reply.status));
}

function heldReplies() {
  return state.replies.filter((reply) => reply.status === "held");
}

function threadsTokenExpired() {
  const exp = Date.parse(state.settings.threadsTokenExpiresAt || "");
  return Boolean(state.settings.threadsAccessToken) && Boolean(exp) && exp < Date.now();
}

function autoReplyPaused() {
  const until = Date.parse(state.settings.autoReplyPausedUntil || "");
  return Boolean(until) && until > Date.now();
}

function renderStatus() {
  const on = Boolean(state.settings.autoPublishEnabled);
  $("#publishStatus").textContent = on ? "予約投稿の自動送信 ON" : "予約投稿の自動送信 OFF";
  $("#publishStatus").dataset.short = on ? "自動送信 ON" : "自動送信 OFF"; // 狭いスマホ幅の上のバー用
  $("#publishDot").classList.toggle("on", on);
  // 投稿キューのバッジは、開いたときの「要対応」と同じ数（承認待ち・承認済み・エラー・時刻を過ぎた予約）
  const action = actionCount();
  $("#navReviewCount").textContent = action ? action : "";
  const open = openReplies().length + heldReplies().length;
  $("#navReplyCount").textContent = open ? open : "";
}

function renderDashboard() {
  $("#reviewCount").textContent = countStatus("review");
  $("#approvedCount").textContent = countStatus("approved");
  $("#scheduledCount").textContent = countStatus("scheduled");
  $("#publishedCount").textContent = countStatus("published");
  $("#errorCount").textContent = countStatus("error");
  $("#unhandledReplyCount").textContent = openReplies().length;
  // 数字は「対応が要るもの」だけ色を付ける（0 は色を付けない）
  const tone = (id, cls, on) => $(`#${id}`).closest(".metric").classList.toggle(cls, on);
  tone("reviewCount", "attn", countStatus("review") > 0);
  tone("approvedCount", "attn", countStatus("approved") > 0);
  tone("errorCount", "alert", countStatus("error") > 0);
  tone("unhandledReplyCount", "attn", openReplies().length > 0);

  // 初めの3手順（AIの確認・Threads連携・最初の投稿案）。全部済むまで今やることの先頭に出す
  const provider = state.settings.aiProvider || "gemini";
  const aiReady = provider === "gemini" ? Boolean(state.settings.geminiApiKey)
    : provider === "claude-api" ? Boolean(state.settings.anthropicApiKey)
      : state.settings.lastAiCheckProvider === provider;
  const threadsReady = Boolean(state.settings.threadsAccessToken) && !threadsTokenExpired();
  const steps = [
    { done: aiReady, title: "AIが使えるか確かめる", note: aiReady ? "済み" : provider === "gemini" ? "Gemini APIキーを設定する（または AIプロバイダを Claude Code に切り替える）" : provider === "claude-api" ? "Claude APIキーを設定する" : `${provider === "codex" ? "Codex" : "Claude Code"} が使える状態か、設定の「接続テスト」で1回確認する`, goto: "settings" },
    { done: threadsReady, title: "Threadsと連携する", note: threadsReady ? "済み" : threadsTokenExpired() ? "Threadsの連携が期限切れです。設定で「Threadsと連携する」をもう一度押す" : "投稿・コメント取得・インサイトに必要です", goto: "settings", focus: "threadsLinkCode" },
    { done: state.posts.length > 0, title: "最初の投稿案を作る", note: state.posts.length ? "済み" : "リサーチで参考投稿を集め、投稿生成で最初の投稿案を作る", goto: "research" }
  ];
  const showSteps = steps.some((s) => !s.done);
  $("#setupSteps").hidden = !showSteps;
  $("#setupSteps").innerHTML = showSteps ? steps.map((s, i) => `
    <li><button class="setup-step ${s.done ? "done" : ""}" type="button" data-goto="${s.goto}"${s.focus && !s.done ? ` data-focus="${s.focus}"` : ""}>
      <span class="step-num">${s.done ? "済" : i + 1}</span>
      <span class="step-body"><strong>${s.title}</strong><span>${escapeHtml(s.note)}</span></span>
      ${s.done ? "" : `<span class="todo-open">開く</span>`}
    </button></li>`).join("") : "";

  // tone: danger=取り消しや失敗に関わる / warn=人の判断待ち / 無し=ふつう
  // （未設定・期限切れは上の手順の欄に出るので、ここには入れない）
  const todos = [];
  const lic = state.license || {};
  if (lic.enforced && !lic.allowed) todos.push({ text: `${lic.message} 自動の投稿・返信・削除は止まっています`, goto: "settings", focus: "licenseKey", tone: "danger" });
  else if (lic.status === "grace" || lic.status === "no_key_grace") todos.push({ text: lic.message, goto: "settings", focus: "licenseKey", tone: "warn" });
  if (countStatus("error")) todos.push({ count: countStatus("error"), text: `エラーになった投稿が${countStatus("error")}件あります。原因を確認して承認し直す`, goto: "queue", filter: "error", tone: "danger" });
  const safetyStopped = state.posts.filter((p) => p.safety?.level === "blocked" && !["published", "rejected"].includes(p.status) && !safetyDeferred(p)).length
    + state.replies.filter((r) => r.safety?.level === "blocked" && r.status !== "responded").length;
  if (safetyStopped) todos.push({ count: safetyStopped, text: `出す前の安全確認で止めている投稿・返信が${safetyStopped}件あります。理由を読んで、直すか「${SAFETY_OVERRIDE_LABEL}」を押す`, goto: "queue", filter: "action", tone: "warn" });
  if (heldReplies().length) todos.push({ count: heldReplies().length, text: `人の確認が必要なコメント（要確認）が${heldReplies().length}件あります`, goto: "replies", filter: "held", tone: "warn" });
  if (autoReplyPaused()) todos.push({ text: `自動返信が一時停止中です（${new Date(state.settings.autoReplyPausedUntil).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} に再開）。Threads の返信回数の上限に触れました`, goto: "replies", tone: "warn" });
  if (countStatus("review")) todos.push({ count: countStatus("review"), text: `承認待ちの投稿が${countStatus("review")}件あります。内容を確認して承認する`, goto: "queue", filter: "review", tone: "warn" });
  if (countStatus("approved")) todos.push({ count: countStatus("approved"), text: `承認済みで未予約の投稿が${countStatus("approved")}件あります。予約するか、すぐ投稿する`, goto: "queue", filter: "approved", tone: "warn" });
  const overdue = state.posts.filter(isOverdue).length;
  if (countStatus("scheduled") && !state.settings.autoPublishEnabled) todos.push({ text: `予約済みの投稿がありますが自動送信がOFFです。設定でONにするか、手動で投稿する${overdue ? "。ONにすると、過ぎた投稿もすぐ送られます。先に内容を確認してください" : ""}`, goto: "settings", focus: "autoPublishEnabled", tone: overdue ? "warn" : "" });
  if (openReplies().length) todos.push({ count: openReplies().length, text: `未返信のコメントが${openReplies().length}件あります`, goto: "replies" });
  const published = countStatus("published");
  if (published >= 3 && !state.suggestions.length) todos.push({ text: "公開済み投稿が溜まってきました。インサイトを取得して改善提案を出す", goto: "analysis" });
  $("#todoList").innerHTML = todos.length
    ? todos.map((t) => `<button class="todo-item ${t.tone ? `t-${t.tone}` : ""}" type="button" data-goto="${t.goto}" ${t.filter ? `data-filter="${t.filter}"` : ""}${t.focus ? ` data-focus="${t.focus}"` : ""}><span class="todo-count">${t.count ?? ""}</span><span class="todo-text">${escapeHtml(t.text)}</span><span class="todo-open">開く</span></button>`).join("")
    : showSteps ? "" : `<p class="empty">今すぐやることはありません。</p>`;

  renderLicenseHold(lic.held || []);

  $("#connectionStatus").innerHTML = [
    aiConnLine(),
    connLine("Threads", Boolean(state.settings.threadsAccessToken) && !threadsTokenExpired(), threadsTokenNote(), true),
    connLine("自動送信", Boolean(state.settings.autoPublishEnabled), state.settings.autoPublishEnabled ? "予約済みを時刻に送信（サーバー起動中のみ）" : "OFF（手動で投稿）"),
    connLine("自動返信", Boolean(state.settings.autoReplyEnabled) && !autoReplyPaused(), !state.settings.autoReplyEnabled ? "OFF（下書きまで・送信は手動）" : autoReplyPaused() ? `一時停止中（${new Date(state.settings.autoReplyPausedUntil).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} に再開・Threads の返信上限に触れたため）` : `コメントをAIが判定して返信（${state.settings.autoReplyIntervalSec || 20}秒間隔・1日${state.settings.autoReplyDailyCap || 500}件まで・要確認は残す）`)
  ].join("");

  renderSafetyPanel();
  // 予定時刻を過ぎた予約は、これからの予定と混ぜずに別枠で先に出す
  const upcoming = state.posts
    .filter((post) => ["approved", "scheduled"].includes(post.status))
    .sort((a, b) => (a.scheduledAt || "9").localeCompare(b.scheduledAt || "9"));
  const late = upcoming.filter(isOverdue);
  const next = upcoming.filter((post) => !isOverdue(post)).slice(0, 5);
  const miniCard = (post) => `<div class="mini-card"><div class="post-meta row">${statusPill(post.status)}<span class="meta-time">${post.scheduledAt ? fmtDate(post.scheduledAt) : "日時未設定"}</span><span>${escapeHtml(post.category)}</span></div><div class="clamp">${nl2br(post.text)}</div></div>`;
  $("#nextPosts").innerHTML = (late.length
    ? `<div class="next-group late"><p class="next-group-label">予定時刻を過ぎています（${late.length}件）<button class="small-button" type="button" data-goto="queue" data-filter="action">投稿キューで見る</button></p>${late.slice(0, 3).map(miniCard).join("")}</div>`
    : "")
    + (next.length
      ? `${late.length ? `<p class="next-group-label">これからの予定</p>` : ""}${next.map(miniCard).join("")}`
      : `<p class="empty">${late.length ? "これからの予定はありません。" : "承認済み・予約済みの投稿はありません。"}</p>`);

  $("#logs").innerHTML = state.logs.slice(0, 8).map((log) => `
    <div class="log-item ${log.level === "error" ? "error" : ""}">
      <span class="log-time">${fmtDate(log.at)}</span>
      <div class="log-msg">${escapeHtml(log.message)}
      ${log.level === "error" && log.meta?.error ? `<details class="log-detail"><summary>${escapeHtml(log.meta.error.slice(0, 90))}${log.meta.error.length > 90 ? "..." : ""}</summary>${escapeHtml(log.meta.error)}${log.meta.detail ? `<br>${escapeHtml(log.meta.detail)}` : ""}</details>` : ""}</div>
    </div>
  `).join("") || `<p class="empty">ログはまだありません。</p>`;
}

// 許可が止まっていた間に予約時刻を過ぎた投稿。1件ずつ「出す」か「破棄」を選ぶ（「出す」が既定）
function renderLicenseHold(held) {
  const box = $("#licenseHold");
  box.hidden = held.length === 0;
  box.innerHTML = held.length ? `<p class="next-group-label">許可が止まっていた間に、予約の時刻を過ぎた投稿が${held.length}件あります。1件ずつ選んでください。</p>`
    + held.map((h) => `<div class="mini-card"><div class="post-meta row"><span class="meta-time">予約: ${fmtDate(h.scheduledAt)}</span></div><div class="clamp">${nl2br(h.text)}</div>
      <div class="row"><button class="button" type="button" data-license-hold="publish" data-id="${escapeHtml(h.id)}">出す</button><button class="button secondary" type="button" data-license-hold="discard" data-id="${escapeHtml(h.id)}">破棄</button></div></div>`).join("") : "";
}

function aiConnLine() {
  const s = state.settings;
  const provider = s.aiProvider || "gemini";
  const checked = s.lastAiCheckProvider === provider && s.lastAiCheckAt;
  const checkedNote = checked ? `接続テスト済み（${new Date(s.lastAiCheckAt).toLocaleString("ja-JP")}）` : "未確認（設定の「接続テスト」で確認）";
  if (provider === "claude-code") return connLine("AI: Claude Code", Boolean(checked), `このPCの Claude Code（モデル: ${s.claudeModel || "sonnet"}）・${checkedNote}`, true);
  if (provider === "claude-api") return connLine("AI: Claude API", Boolean(s.anthropicApiKey), s.anthropicApiKey ? `モデル: ${s.anthropicModel || ""}` : "APIキー未設定", true);
  if (provider === "codex") return connLine("AI: Codex", Boolean(checked), `このPCの Codex CLI（ChatGPT の契約）${s.codexModel ? `（モデル: ${s.codexModel}）` : ""}・${checkedNote}`, true);
  return connLine("AI: Gemini", Boolean(s.geminiApiKey), s.geminiApiKey ? `モデル: ${s.geminiModel || "自動"}` : "APIキー未設定", true);
}

// missing=true は「まだ使えない（未連携・未確認）」。点を中抜きにして、OFF（自分で切っている）と形で分ける
function connLine(name, ok, note, missing = false) {
  return `<div class="conn-line"><span class="status-dot ${ok ? "on" : missing ? "missing" : ""}"></span><strong>${name}</strong><span class="post-meta">${escapeHtml(note)}</span></div>`;
}

function threadsTokenNote() {
  if (!state.settings.threadsAccessToken) return "未連携";
  const exp = state.settings.threadsTokenExpiresAt ? new Date(state.settings.threadsTokenExpiresAt) : null;
  if (!exp) return "連携済み（有効期限不明）";
  const days = Math.floor((exp.getTime() - Date.now()) / 86400000);
  if (days < 0) return `期限切れ（${exp.toLocaleDateString("ja-JP")}）。再連携が必要`;
  return `連携済み・有効期限まで${days}日`;
}

function statusPill(status) {
  return `<span class="status-pill s-${status}">${STATUS_LABEL[status] || status}</span>`;
}

// ---------------------------------------------------------------------------
// リサーチ: 参考投稿
// ---------------------------------------------------------------------------
function renderReferences() {
  const refs = state.references || [];
  const selected = refs.filter((r) => r.selected).length;
  $("#refSelectedCount").textContent = refs.length ? `${selected} / ${refs.length}件を選択中` : "";
  const box = $("#refAnalysisBox");
  if (state.referenceAnalysis?.commonPatterns) {
    box.hidden = false;
    box.innerHTML = `<h4>共通する型（${fmtDate(state.referenceAnalysis.at)} 分析）</h4><div>${nl2br(state.referenceAnalysis.commonPatterns)}</div>`;
  } else {
    box.hidden = true;
  }
  // 並べ替え: 反応の多い順は、いいね数が取れている投稿を先に（多い順）、反応数なしは追加した順のまま後ろへ
  const likesOf = (r) => (r.metrics && Number.isFinite(Number(r.metrics.likes)) && r.metrics.likes !== null ? Number(r.metrics.likes) : null);
  const sorted0 = $("#refSort") && $("#refSort").value === "likes"
    ? [...refs].sort((a, b) => (likesOf(b) ?? -1) - (likesOf(a) ?? -1))
    : refs;
  // 選択中の投稿は「さらに表示」に関係なく必ず見えるよう先頭に寄せる（見えない投稿が分析・生成に使われないように）
  const sorted = [...sorted0.filter((r) => r.selected), ...sorted0.filter((r) => !r.selected)];
  const refLimit = Math.max(listLimit.refs, selected);
  $("#refListMore").innerHTML = moreRowHtml("refs", Math.min(refLimit, refs.length), refs.length);
  $("#refList").innerHTML = refs.length ? sorted.slice(0, refLimit).map((ref) => `
    <article class="ref-card ${ref.selected ? "selected" : ""}">
      <label class="ref-head">
        <input type="checkbox" data-ref-toggle="${ref.id}" ${ref.selected ? "checked" : ""} />
        <span class="post-meta">${ref.username ? `@${escapeHtml(ref.username)}` : "手動追加"}${ref.keyword ? ` / 「${escapeHtml(ref.keyword)}」` : ""}${ref.timestamp ? ` / ${fmtDate(ref.timestamp)}` : ""}${likesOf(ref) !== null ? ` / いいね ${likesOf(ref)}${ref.metrics.replies !== null && ref.metrics.replies !== undefined ? ` / 返信 ${Number(ref.metrics.replies) || 0}` : ""}` : " / 反応数なし"}${ref.verifiedAt ? " / ページで確認済み" : ""}${ref.theme ? ` / テーマ「${escapeHtml(ref.theme)}」` : ""}${ref.autoSelected ? ` / <strong>自動で使う</strong>` : ""}${ref.unverified ? ` / <strong class="unverified-tag">未検証（AI取得・要目視確認）</strong>` : ""}</span>
        <span class="spacer"></span>
        ${safeHref(ref.permalink) ? `<a class="link" href="${safeHref(ref.permalink)}" target="_blank" rel="noreferrer">元投稿</a>` : ""}
        <button class="small-button ghost" data-ref-delete="${ref.id}" type="button">削除</button>
      </label>
      <div class="ref-text">${nl2br(ref.text)}</div>
      ${ref.analysis ? `
        <div class="ref-analysis">
          <div><b>フック</b> ${escapeHtml(ref.analysis.hook)}${ref.analysis.hookType ? `（${escapeHtml(HOOK_TYPE_LABEL[ref.analysis.hookType] || ref.analysis.hookType)}）` : ""}</div>
          <div><b>構造</b> ${escapeHtml(ref.analysis.structure)}</div>
          <div><b>効いている理由</b> ${escapeHtml(ref.analysis.whyItWorks)}</div>
          <div><b>自分ならこう置き換える</b> ${escapeHtml(ref.analysis.howToAdapt)}</div>
        </div>` : ""}
    </article>
  `).join("") : `<p class="notice">まだ候補がありません。上のキーワード検索か、手動貼り付けで追加してください。</p>`;
}

// ---------------------------------------------------------------------------
// リサーチ: まとめてリサーチ（裏で進むジョブ。終わるまで数秒おきに状態を聞く）
// ---------------------------------------------------------------------------
const HOOK_TYPE_LABEL = { question: "問いかけ", empathy: "あるある・共感", story: "体験談", "bold-claim": "言い切り", contrarian: "常識の逆", list: "まとめ", other: "その他" };
let researchPollTimer = null;
let researchPollFailures = 0;
function renderAutoResearch() {
  const box = $("#autoResearchStatus");
  const job = state.researchJob;
  const runs = state.researchRuns || [];
  const btn = $("#autoResearchBtn");
  if (job && job.status === "running") {
    box.hidden = false;
    box.innerHTML = `<h4>調べています</h4><div>${escapeHtml(job.step || "")}${job.total ? `（${job.done} / ${job.total}件）` : ""}</div><div class="input-note">この画面を離れても進みます。</div>`;
    btn.disabled = true;
    $("#autoResearchCancelBtn").hidden = false;
    if (!researchPollTimer) researchPollTimer = setInterval(pollResearchJob, 4000);
    return;
  }
  btn.disabled = false;
  $("#autoResearchCancelBtn").hidden = true;
  if (job && job.status === "error") {
    box.hidden = false;
    box.innerHTML = `<h4>リサーチが止まりました</h4><div>${nl2br(job.error || "")}</div>`;
  } else if (job && job.status === "done") {
    box.hidden = false;
    box.innerHTML = `<h4>リサーチの結果（${fmtDate(job.finishedAt)}）</h4><div>${nl2br(job.message || "")}</div><div class="input-note">使う投稿は下の候補に「自動で使う」と表示され、次の投稿生成に入ります（その回のテーマに合うものだけ）。</div>`;
  } else if (runs.length) {
    box.hidden = false;
    const latest = runs.filter((r) => r.at === runs[0].at || Date.parse(runs[0].at) - Date.parse(r.at) < 3_600_000);
    box.innerHTML = `<h4>前回のリサーチ（${fmtDate(runs[0].at)}）</h4><div>${latest.map((r) => `「${escapeHtml(r.theme)}」: 候補${r.candidates}件 → 確かめられた${r.verified}件 → 使う${(r.pickedIds || []).length}件`).join("<br>")}</div>`;
  } else {
    box.hidden = true;
  }
}
async function pollResearchJob() {
  const job = state.researchJob;
  if (!job) { clearInterval(researchPollTimer); researchPollTimer = null; return; }
  try {
    const r = await api(`/api/research/jobs/${encodeURIComponent(job.id)}`);
    researchPollFailures = 0;
    state.researchJob = r.job;
    if (r.job.status !== "running") {
      clearInterval(researchPollTimer);
      researchPollTimer = null;
      await loadState();
      toast(r.job.status === "done" ? "リサーチが終わりました。結果を確認してください。" : "リサーチが止まりました。", r.job.status === "done" ? "info" : "error");
    }
    renderAutoResearch();
  } catch (error) {
    researchPollFailures += 1;
    if (researchPollFailures < 3) return;
    clearInterval(researchPollTimer);
    researchPollTimer = null;
    researchPollFailures = 0;
    state.researchJob = null;
    renderAutoResearch();
    toast(`リサーチの進み具合を確かめられませんでした: ${error.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// リサーチ: Web参照元
// ---------------------------------------------------------------------------
function renderResearch() {
  const items = state.research || [];
  const selected = items.flatMap((i) => i.sources || []).filter((s) => s.selected).length;
  $("#srcSelectedCount").textContent = selected ? `${selected}件を選択中` : "";
  $("#researchResults").innerHTML = items.length ? items.map((item) => `
    <article class="post-card">
      <div class="post-meta row">
        <span>${fmtDate(item.createdAt)} / 「${escapeHtml(item.keyword)}」</span>
        <span class="spacer"></span>
        <button class="small-button ghost" data-research-delete="${item.id}" type="button">削除</button>
      </div>
      <div class="clamp-6">${nl2br(item.summary || "")}</div>
      <div class="source-list">
        ${(item.sources || []).map((source) => `
          <label class="source-item">
            <input type="checkbox" data-source="${source.id}" ${source.selected ? "checked" : ""} />
            <span><strong>${escapeHtml(source.title)}</strong>${safeHref(source.url) ? `<a class="link" href="${safeHref(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>` : escapeHtml(source.url)}</span>
          </label>
        `).join("") || `<p class="notice">参照元URLは返りませんでした。</p>`}
      </div>
    </article>
  `).join("") : `<p class="notice">まだ検索結果はありません。</p>`;
}

// ---------------------------------------------------------------------------
// 投稿生成
// ---------------------------------------------------------------------------
// 使う設定になっている発信テーマ（保存済みの値）
function activeThemes() {
  return (state.settings.themes || []).filter((t) => t.enabled !== false && t.name);
}

function renderGenerateInputs() {
  $("#topicThemeNote").hidden = !activeThemes().length;
  const refs = (state.references || []).filter((r) => r.selected).length;
  const srcs = (state.research || []).flatMap((i) => i.sources || []).filter((s) => s.selected).length;
  const analyzed = Boolean(state.referenceAnalysis?.commonPatterns);
  const top = (state.stats?.top || []).length;
  // 1日の投稿数が1以上なら、その数が予定数（固定の予約時刻は使わない）。0なら予約時刻の数
  const perDay = Number(state.settings.postsPerDay) >= 1 ? Number(state.settings.postsPerDay) : (state.settings.scheduleTimes || []).length;
  const none = "まだありません";
  $("#generateInputs").innerHTML = `
    <div class="input-chip ${refs ? "on" : ""}">参考投稿 ${refs ? `${refs}件` : none}${analyzed ? "（型を分析済み）" : ""}</div>
    <div class="input-chip ${srcs ? "on" : ""}">Webで集めた参考 ${srcs ? `${srcs}件` : none}</div>
    <div class="input-chip ${top ? "on" : ""}">過去の反応上位 ${top ? `${top}件` : none}</div>
    <div class="input-chip ${state.settings.profile ? "on" : ""}">プロフィール${state.settings.profile ? "あり" : "未設定"}</div>
    <div class="input-chip on">1日あたりの投稿予定数 ${perDay}件</div>
    ${activeThemes().length ? `<div class="input-chip on">発信テーマ ${activeThemes().length}個</div>` : ""}
    ${!refs || !srcs || !top ? `<p class="input-note">「まだありません」は、まだ集めていないだけです（不具合ではありません）。</p>` : ""}
  `;
}

// ---------------------------------------------------------------------------
// 投稿キュー
// ---------------------------------------------------------------------------
function postActions(post) {
  const b = (action, label, cls = "") => `<button class="small-button ${cls}" data-action="${action}" data-id="${post.id}" type="button">${label}</button>`;
  // 行の主ボタン（primary・薄い地）は状態ごとに1つ。外へ公開される操作（今すぐ投稿）と削除は右端に離す。朱は削除だけ
  switch (post.status) {
    case "review":
      return [b("approve", "承認", "primary"), b("edit", "編集"), b("reject", "却下", "ghost")];
    case "approved":
      return [b("schedule", "予約する", "primary"), b("edit", "編集"), b("reject", "却下", "ghost"), b("publish", "今すぐ投稿", "publish")];
    case "scheduled":
      return [b("edit", "編集"), b("unschedule", "予約を解除"), b("publish", "今すぐ投稿", "publish")];
    case "published":
      return [safeHref(post.permalink) ? `<a class="small-button link-button" href="${safeHref(post.permalink)}" target="_blank" rel="noreferrer">Threadsで見る</a>` : ""];
    case "error":
      return [b("approve", "承認し直す", "primary"), b("edit", "編集"), b("reject", "却下", "ghost")];
    case "rejected":
      return [b("restore", "承認待ちに戻す"), b("delete", "削除", "danger")];
    default:
      return [];
  }
}

// 自動の判定は、データを読み込んでから最初に投稿キューを開いた1回だけ。以後は押した絞り込みのまま（0件になっても勝手に切り替えない）
function queueFilterNow() {
  if (state.queueFilter !== "auto") return state.queueFilter;
  const picked = state.posts.some((p) => matchesQueueFilter(p, "action")) ? "action" : "scheduled";
  if (stateLoaded) state.queueFilter = picked;
  return picked;
}

function matchesQueueFilter(post, filter) {
  if (filter === "all") return true;
  if (filter === "action") return (ACTION_STATUSES.includes(post.status) && !isStaleError(post)) || isOverdue(post);
  return post.status === filter;
}

function actionCount() {
  return state.posts.filter((p) => matchesQueueFilter(p, "action")).length;
}

function renderQueue() {
  const filter = queueFilterNow();
  $$("#queueFilters .chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.status === filter);
    const n = state.posts.filter((post) => matchesQueueFilter(post, chip.dataset.status)).length;
    const count = chip.querySelector(".chip-count");
    if (count) count.textContent = n ? String(n) : "";
  });
  const order = { error: 0, review: 1, approved: 2, scheduled: 3, published: 4, rejected: 5 };
  const posts = state.posts
    .filter((post) => matchesQueueFilter(post, filter))
    .slice()
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)
      || (["published", "rejected"].includes(a.status) ? (b.publishedAt || b.updatedAt || "").localeCompare(a.publishedAt || a.updatedAt || "") : (a.scheduledAt || "9").localeCompare(b.scheduledAt || "9")));
  $("#bulkApproveBtn").disabled = !countStatus("review");
  const stale = state.posts.filter(isStaleError).length;
  $("#clearStaleBtn").hidden = !stale;
  $("#clearStaleBtn").textContent = `${STALE_ERROR_DAYS}日以上前のエラーを片づける（${stale}件）`;
  const shown = posts.slice(0, listLimit.queue);
  $("#postList").innerHTML = shown.length ? shown.map((post) => {
    const actions = postActions(post).filter(Boolean);
    const isRisky = (a) => a.includes(" danger\"") || a.includes(" publish\"");
    const risky = actions.filter(isRisky);
    const normal = actions.filter((a) => !isRisky(a));
    const publishNote = risky.some((a) => a.includes(" publish\"")) ? `<span class="public-note">Threadsへ公開されます</span>` : "";
    const retryNote = post.status === "error" ? `<span class="action-hint">${isStaleError(post) ? `${STALE_ERROR_DAYS}日以上前の失敗なので、要対応には数えていません。` : ""}原因が通信なら、つながってから押します</span>` : "";
    return `
    <article class="post-row s-${post.status}">
      <div class="post-row-head">
        ${statusPill(post.status)}
        <span class="meta-time">${post.status === "published" ? `公開 ${fmtDate(post.publishedAt)}${post.deletedFromThreadsAt ? "（反応が少なく自動削除済み）" : ""}` : post.scheduledAt ? `予定 ${fmtDate(post.scheduledAt)}` : "日時未設定"}</span>
        ${isOverdue(post) ? `<span class="overdue-note">予定時刻を過ぎています</span>` : ""}
        ${safetyDeferred(post) ? `<span class="defer-note">安全確認で後ろへずらしています（${fmtClock(post.retryAfter)}以降）</span>` : ""}
        <span class="post-meta">${escapeHtml(post.category || CATEGORY_LABEL_FALLBACK)}${post.format !== "TEXT" ? ` / ${post.format}` : ""}</span>
        ${post.theme ? `<span class="post-meta">テーマ: ${escapeHtml(post.theme)}</span>` : ""}
        ${post.campaignId ? `<span class="post-meta">宣伝の期間 ${escapeHtml(shortDay(post.campaignStartDate))}〜${escapeHtml(shortDay(post.campaignEndDate))}</span>` : ""}
      </div>
      <div class="post-text ${["published", "rejected"].includes(post.status) ? "clamp" : ""}">${nl2br(post.text)}</div>
      ${post.copyOverlapWarning ? `<div class="error-box">参考投稿との一致率が${post.copyOverlapWarning.ratio}%あります（「${escapeHtml(post.copyOverlapWarning.sourceSnippet)}...」と近い）。承認は本文を見直すか、内容を確認したうえで進めてください。</div>` : ""}
      ${post.styleWarnings && post.styleWarnings.length ? `<div class="warn-box">文章の目安: ${post.styleWarnings.map((w) => escapeHtml(friendlyStyleWarning(w))).join(" / ")}。そのまま出せます</div>` : ""}
      ${["published", "rejected"].includes(post.status) ? "" : safetyBlockHtml(post, "post")}
      ${post.error && !(post.safety?.level === "blocked" && /安全確認/.test(post.error)) ? errorBoxHtml(post.error) : ""}
      ${post.rejectReason ? `<div class="notice">却下理由: ${escapeHtml(post.rejectReason)}</div>` : ""}
      ${actions.length ? `<div class="post-row-actions">${normal.join("")}${retryNote}${risky.length ? `<span class="spacer"></span><span class="risky-actions">${publishNote}${risky.join("")}</span>` : ""}</div>` : ""}
    </article>`;
  }).join("") : `<p class="empty">${!state.posts.length ? "投稿はまだありません。「投稿生成」で作るか、「手動で追加」してください。" : filter === "action" ? "対応が要る投稿はありません。" : "この状態の投稿はありません。"}</p>`;
  $("#postListMore").innerHTML = moreRowHtml("queue", shown.length, posts.length);
}

// 通信エラーの記号を日本語の一言に。元の文字は消さずに小さく残す（原因を調べるときに要る）
const ERROR_HINTS = [
  [/ENOTFOUND|EAI_AGAIN/, "インターネットに接続できませんでした"],
  [/ERR_TLS|CERT_/, "通信の安全確認に失敗しました（Wi-Fiやセキュリティソフトが原因のことがあります）"],
  [/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|ECONNRESET|ECONNREFUSED|fetch failed/, "Threadsに届きませんでした（通信が途中で切れたか、時間がかかりすぎました）"],
  [/UNSPECIFIED/, "原因の分からない失敗です（Threads側）"]
];
function errorBoxHtml(error) {
  const hit = ERROR_HINTS.find(([re]) => re.test(String(error)));
  return hit
    ? `<div class="error-box"><span class="error-lead">${escapeHtml(hit[1])}</span><span class="error-raw">${escapeHtml(error)}</span></div>`
    : `<div class="error-box">${escapeHtml(error)}</div>`;
}
// ---------------------------------------------------------------------------
// 出す前の安全確認（アカバン防止ガード）の表示。止めた理由・注意・「理由を確認して出す」・要約・守備範囲
// ---------------------------------------------------------------------------
const SAFETY_OVERRIDE_LABEL = "理由を確認して出す"; // server.js の SAFETY_OVERRIDE_BUTTON と同じ文言
function safetyDeferred(p) {
  return p.status === "scheduled" && p.safety?.level === "blocked" && Date.parse(p.retryAfter || "") > Date.now();
}
function fmtClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return `${sameDay ? "" : `${d.getMonth() + 1}月${d.getDate()}日 `}${d.getHours()}時${String(d.getMinutes()).padStart(2, "0")}分`;
}
function safetyReasonItems(reasons) {
  return reasons.map((r) => `<li><span class="safety-rule">${escapeHtml(r.rule)} ${escapeHtml(r.name || "")}</span> ${escapeHtml(r.message)}</li>`).join("");
}
function safetyBlockHtml(item, kind) {
  const s = item.safety;
  if (!s || !Array.isArray(s.reasons) || !s.reasons.length) return "";
  const blocked = s.reasons.filter((r) => r.level === "blocked");
  const warns = s.reasons.filter((r) => r.level !== "blocked");
  if (kind === "post" && safetyDeferred(item)) {
    return `<div class="safety-note s-defer">安全確認で後ろへずらしています（${fmtClock(item.retryAfter)}以降）。時刻が来たら自動でもう一度確かめて送ります。<ul>${safetyReasonItems(blocked)}</ul></div>`;
  }
  if (blocked.length) {
    const canOverride = blocked.some((r) => !["G1", "G11"].includes(r.rule));
    const attr = kind === "post" ? `data-action="safety-override"` : `data-reply-action="safety-override"`;
    return `<div class="safety-note s-blocked"><strong>出す前の安全確認で止めています</strong><ul>${safetyReasonItems(blocked)}</ul>${warns.length ? `<p class="safety-sub">注意（止めていません）</p><ul>${safetyReasonItems(warns)}</ul>` : ""}<div class="safety-actions">${canOverride ? `<button class="small-button" ${attr} data-id="${item.id}" type="button">${SAFETY_OVERRIDE_LABEL}</button><span class="action-hint">直して保存し直すか、理由を読んだうえでこのボタンを押します${kind === "post" && item.status === "error" ? "。押したあと「承認し直す」と「予約する」が要ります（予定の時刻が過ぎていたら、編集で日時を直してから）" : ""}</span>` : `<span class="action-hint">公式上限の手前で止めています。解除はできません。時間をおくと出せます</span>`}</div></div>`;
  }
  return `<div class="safety-note s-warn"><strong>安全確認の注意</strong>（止めていません。そのまま出せます）<ul>${safetyReasonItems(warns)}</ul></div>`;
}
async function safetyOverride(kind, id, button, replyText) {
  const item = kind === "post" ? state.posts.find((p) => p.id === id) : state.replies.find((r) => r.id === id);
  if (!item?.safety) return;
  const blocked = (item.safety.reasons || []).filter((r) => r.level === "blocked");
  const text = kind === "post" ? item.text : (replyText || item.responseText || "");
  const lines = blocked.map((r) => `・${r.rule} ${r.name || ""}: ${r.message}`).join("\n");
  const ok = confirm(`止めた理由をすべて読んでください。\n\n${lines}\n\n本文:\n${text}\n\n理由を読んだうえで、止めるのをやめます。これだけでは公開・返信はされません（${kind === "post" ? "承認・予約・今すぐ投稿" : "「この内容で返信する」"}は別に押します）。本文を変えると、もう一度確かめます。本数・間隔の理由の解除は24時間で切れます。\n${state.safety?.disclaimer || ""}`);
  if (!ok) return;
  await busy(button, "解除中", async () => {
    const path = kind === "post" ? `/api/posts/${encodeURIComponent(id)}/safety-override` : `/api/replies/${encodeURIComponent(id)}/safety-override`;
    await api(path, { method: "POST", body: kind === "post" ? { confirm: true } : { confirm: true, text } });
    await loadState();
    toast("止めるのをやめました。出すときは、いつもの操作で承認・予約・返信してください。");
  });
}
function renderSafetyPanel() {
  const el = $("#safetySummary");
  if (!el) return;
  const s = state.safety;
  if (!s) { el.innerHTML = ""; return; }
  const wasOpen = Boolean(el.querySelector("details.safety-recommend")?.open);
  const a = s.account || {};
  const p = s.posts || {};
  const r = s.replies || {};
  const b = s.blocked || {};
  const line = (label, value) => `<div class="safety-line"><span>${label}</span><strong>${value}</strong></div>`;
  const g12 = (s.rules || []).find((x) => x.rule === "G12");
  const stopped = (b.posts || 0) - (b.deferredPosts || 0) + (b.replies || 0);
  el.innerHTML = `
    <p class="safety-state">${s.enabled ? `<span class="status-dot on"></span>ON` : `<span class="status-dot"></span>OFF`}</p>
    ${s.enabled ? "" : `<p class="hint">${escapeHtml(s.offNote || "")}</p>`}
    ${line("直近24時間の投稿", `${p.last24h ?? 0}本（前の24時間 ${p.previous24h ?? 0}本）`)}
    ${line("直近24時間の返信", `${r.last24h ?? 0}件`)}
    ${line("1日の上限", `${p.dailyLimit ?? "-"}本（今の1日の投稿数 ${s.plannedPostsPerDay ?? 0}本）`)}
    ${line("24時間の上限", `投稿 ${p.safeLimit ?? "-"}件・返信 ${r.safeLimit ?? "-"}件（公式は250件・1,000件）`)}
    ${line("止めている", `投稿 ${Math.max(0, (b.posts || 0) - (b.deferredPosts || 0))}件・返信 ${b.replies || 0}件${b.deferredPosts ? `・後ろへずらし中 ${b.deferredPosts}件` : ""}`)}
    ${stopped ? `<p class="safety-go"><button class="small-button" type="button" data-goto="queue" data-filter="action">投稿キューで理由を見る</button></p>` : ""}
    ${g12 && g12.state !== "ok" ? `<p class="hint">${escapeHtml(g12.name)}: ${escapeHtml(g12.state)}</p>` : ""}
    <p class="safety-scope">${escapeHtml(s.disclaimer || "")} ${escapeHtml(s.scope || "")}</p>
    <details class="safety-recommend"${wasOpen ? " open" : ""}><summary>推奨の設定を見る</summary>
      <ul>${(s.recommendedNotes || []).map((n) => `<li><span class="safety-rule">${escapeHtml(n.label)}</span> ${escapeHtml(n.value)}。${escapeHtml(n.note)}</li>`).join("")}</ul>
      ${s.enabled ? `<p class="hint">いまONです。数値は暫定の目安です。数字と追加の禁止語は、設定の画面の7番、出す前の安全確認の数値で変えられます。</p>` : `<p class="hint">いまOFFです。ONにすると、上の目安を超える投稿・返信を公開の前に止めます。${safetyEnableNote(s)}数値は暫定の目安です。</p><button class="button secondary" type="button" data-safety-act="enable">安全確認をONにする</button>`}
    </details>`;
}
// ONにする前の説明: 1日の上限・今の1日の投稿数。多い分は後ろへずれ、24時間でエラーになる
function safetyEnableNote(s) {
  const p = s?.posts || {};
  const planned = Number(s?.plannedPostsPerDay) || 0;
  const over = Number.isFinite(Number(p.dailyLimit)) && planned > Number(p.dailyLimit);
  return `1日の上限は${p.dailyLimit ?? "-"}本です（今の設定の1日の投稿数は${planned}本）。1日の投稿数が上限より多いと、多い分は後ろへずれ、予約の時刻から24時間たつとエラーになります。${over ? "ONにする前に、1日の投稿数を上限以下にしてください。" : ""}`;
}
async function enableSafetyGuard(button) {
  if (!confirm(`出す前の安全確認をONにします。目安を超える投稿・返信は公開の前に止まり、投稿キューやコメントの行に理由が出ます。\n\n${safetyEnableNote(state.safety)}\n\nよろしいですか。`)) return;
  await busy(button, "保存中", async () => {
    await api("/api/settings", { method: "POST", body: { safetyGuardEnabled: true } });
    await loadState({ keepSettingsForm: settingsDirty });
    toast("安全確認をONにしました。");
  });
}
function friendlyStyleWarning(w) {
  const long = String(w).match(/^長すぎます（(\d+)字/);
  if (long) return `長めです（${long[1]}字）。短いほうが読まれやすいです`;
  const steps = String(w).match(/^手順や項目が(\d+)つ並んでいます/);
  if (steps) return `手順や項目が${steps[1]}つ並んでいます。解説っぽく見えることがあります`;
  return w;
}

function openEditor(post = {}) {
  state.editingId = post.id || null;
  $("#dialogTitle").textContent = post.id ? "投稿を編集" : "投稿を手動で追加";
  $("#editNotice").textContent = post.status === "scheduled" ? "本文・形式・画像や動画のURL・画像の説明文・話題のタグを変更すると承認待ちに戻ります。予約も外れます。"
    : post.status === "approved" ? "本文・形式・画像や動画のURL・画像の説明文・話題のタグを変更すると承認待ちに戻ります。"
      : post.id ? "" : "追加した投稿は承認待ちに入ります。";
  $("#editText").value = post.text || "";
  $("#editCategory").value = post.category || "";
  $("#editScheduledAt").value = toLocalDatetime(post.scheduledAt);
  $("#editFormat").value = post.format || "TEXT";
  $("#editMediaUrl").value = post.mediaUrl || "";
  $("#editAltText").value = post.altText || "";
  $("#editTopicTag").value = post.topicTag || "";
  updateEditCount();
  $("#editDialog").showModal();
}

function updateEditCount() {
  const length = [...$("#editText").value].length;
  const el = $("#editCount");
  el.textContent = `${length} / 500文字`;
  el.classList.toggle("over", length > 500);
}

async function savePost(event) {
  event.preventDefault();
  const payload = {
    text: $("#editText").value,
    category: $("#editCategory").value,
    scheduledAt: fromLocalDatetime($("#editScheduledAt").value),
    format: $("#editFormat").value,
    mediaUrl: $("#editMediaUrl").value,
    altText: $("#editAltText").value,
    topicTag: $("#editTopicTag").value
  };
  await busy($("#savePostBtn"), "保存中", async () => {
    if (state.editingId) await api(`/api/posts/${encodeURIComponent(state.editingId)}`, { method: "PUT", body: payload });
    else await api("/api/posts", { method: "POST", body: payload });
    $("#editDialog").close();
    await loadState();
    toast("保存しました。");
  });
}

async function transition(id, action, button) {
  const post = state.posts.find((item) => item.id === id);
  if (!post) return;
  let scheduledAt;
  let reason;
  const past = post.scheduledAt && Date.parse(post.scheduledAt) < Date.now() - 60_000;
  if (action === "schedule" && (!post.scheduledAt || past)) {
    scheduledAt = await askScheduleDatetime(nextScheduleSlot(), past ? "割り当て済みの予約時刻が過ぎているので、日時を選び直してください。" : "");
    if (!scheduledAt) return;
  }
  if (action === "reject") {
    // 却下理由を一言だけ聞く（Q044で新設）。あとで「書き直せば出せる」かを判断する材料にする。空欄でも却下できる。
    reason = window.prompt("却下する理由を一言で（あとで書き直すかの判断材料にします。空でもOK）", "");
    if (reason === null) return;
  }
  await busy(button, "処理中", async () => {
    await api(`/api/posts/${encodeURIComponent(id)}/transition`, { method: "POST", body: { action, scheduledAt, reason } });
    await loadState();
    toast({ approve: "承認しました。", schedule: "予約しました。", unschedule: "予約を解除しました。", reject: "却下しました。", restore: "承認待ちに戻しました。" }[action] || "更新しました。");
  });
}

// 設定の予約時刻（HH:MM・日本時間）から、今より後の直近の枠を返す（ローカル時刻で計算）
function nextScheduleSlot() {
  if (Number(state.settings.postsPerDay) >= 1) {
    const from = Number(state.settings.scheduleFromHour ?? 7);
    const to = Number(state.settings.scheduleToHour ?? 21);
    const now = new Date();
    for (let day = 0; day < 8; day += 1) {
      const lo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, from, 0, 0, 0).getTime();
      const hi = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, to, 0, 0, 0).getTime();
      const start = Math.max(lo, now.getTime() + 5 * 60_000);
      if (start < hi) return new Date(start + Math.floor(Math.random() * (hi - start))).toISOString();
    }
  }
  const times = (state.settings.scheduleTimes || []).filter((t) => /^\d{2}:\d{2}$/.test(t)).sort();
  const now = new Date();
  for (let day = 0; day < 8; day += 1) {
    for (const t of times) {
      const [h, m] = t.split(":").map(Number);
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, h, m, 0, 0);
      if (d.getTime() > now.getTime() + 5 * 60_000) return d.toISOString();
    }
  }
  return new Date(now.getTime() + 60 * 60_000).toISOString();
}

function askScheduleDatetime(defaultIso, note = "") {
  return new Promise((resolve) => {
    const dialog = $("#scheduleDialog");
    const input = $("#scheduleDialogInput");
    $("#scheduleDialogNote").textContent = note;
    input.value = toLocalDatetime(defaultIso);
    const done = (value) => { dialog.close(); dialog.removeEventListener("close", onClose); resolve(value); };
    const onClose = () => done("");
    dialog.addEventListener("close", onClose);
    $("#scheduleDialogOk").onclick = (e) => {
      e.preventDefault();
      const iso = fromLocalDatetime(input.value);
      if (!iso) return toast("日時を選んでください。", "error");
      if (Date.parse(iso) < Date.now()) return toast("過去の日時は選べません。", "error");
      done(iso);
    };
    $("#scheduleDialogCancel").onclick = (e) => { e.preventDefault(); done(""); };
    dialog.showModal();
  });
}

async function publishPost(id, button) {
  const post = state.posts.find((item) => item.id === id);
  if (!post) return;
  if (!confirm(`この投稿をThreadsへ公開します。取り消せません。\n\n${post.text.slice(0, 200)}${post.text.length > 200 ? "..." : ""}`)) return;
  await busy(button, "送信中", async () => {
    try {
      await api(`/api/posts/${encodeURIComponent(id)}/publish`, { method: "POST" });
      toast("Threadsへ公開しました。");
    } finally {
      await loadState();
    }
  });
}

async function deletePost(id, button) {
  if (!confirm("この投稿を削除します。よろしいですか。")) return;
  await busy(button, "削除中", async () => {
    await api(`/api/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadState();
    toast("削除しました。");
  });
}

// ---------------------------------------------------------------------------
// コメント返信
// ---------------------------------------------------------------------------
function renderReplies() {
  // 入力中の返信欄は再描画後に値とカーソルを戻す
  const active = document.activeElement;
  const keepId = active?.dataset?.replyInput;
  const keepValue = keepId ? active.value : null;
  const keepPos = keepId ? active.selectionStart : 0;
  renderRepliesList();
  if (keepId) {
    const el = $(`[data-reply-input="${keepId}"]`);
    if (el) {
      el.value = keepValue;
      el.focus();
      el.setSelectionRange(keepPos, keepPos);
    }
  }
}

function renderRepliesList() {
  $$("#replyFilters .chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.status === state.replyFilter));
  const filter = state.replyFilter;
  const replies = state.replies.filter((reply) =>
    filter === "all" ? true : filter === "open" ? ["unhandled", "drafted", "held", "error"].includes(reply.status) : reply.status === filter
  );
  const postText = (reply) => state.posts.find((p) => p.id === reply.postId)?.text || "";
  $("#replyList").innerHTML = replies.length ? replies.map((reply) => `
    <article class="reply-card">
      <div class="post-row-head">
        <span class="status-pill r-${reply.status}">${REPLY_STATUS_LABEL[reply.status] || reply.status}</span>
        ${reply.status === "responded" && reply.auto ? `<span class="status-pill r-auto">自動返信</span>` : ""}
        ${reply.status === "responded" && reply.external ? `<span class="status-pill r-auto">Threadsアプリで返信済み</span>` : ""}
        ${reply.status === "drafted" && reply.autoQueued && state.settings.autoReplyEnabled ? `<span class="status-pill r-queued">自動送信待ち（${state.settings.autoReplyIntervalSec || 20}秒間隔で順に送信）</span>` : ""}
        ${reply.sendingAt ? `<span class="status-pill r-queued">送信中</span>` : ""}
        <strong>${reply.username ? `@${escapeHtml(reply.username)}` : "名前不明"}</strong>
        <span class="post-meta">${fmtDate(reply.timestamp)}</span>
        <span class="spacer"></span>
        ${reply.hidden ? `<span class="status-pill r-ignored">スパムとして非表示済み</span>` : ""}
        ${reply.status === "responded" && reply.respondedThreadsId ? `<button class="small-button" data-reply-action="open-response" data-id="${reply.id}" type="button">返信をThreadsで見る</button>` : ""}
        ${safeHref(reply.permalink) ? `<a class="link" href="${safeHref(reply.permalink)}" target="_blank" rel="noreferrer">コメントをThreadsで見る</a>` : ""}
        ${reply.hidden
          ? `<button class="small-button ghost" data-reply-action="unhide" data-id="${reply.id}" type="button">非表示を解除</button>`
          : `<button class="small-button ghost danger-text" data-reply-action="hide" data-id="${reply.id}" type="button">スパムとして非表示</button>`}
      </div>
      <div class="quote">元投稿: ${escapeHtml(postText(reply).slice(0, 90))}${postText(reply).length > 90 ? "..." : ""}</div>
      <div class="reply-text">${nl2br(reply.text)}</div>
      ${safeHref(reply.mediaUrl) ? `<a class="reply-media-link" href="${safeHref(reply.mediaUrl)}" data-permalink="${safeHref(reply.permalink) || ""}" target="_blank" rel="noreferrer"><img class="reply-media" src="${safeHref(reply.mediaUrl)}" alt="コメントに添付された画像" loading="lazy" referrerpolicy="no-referrer" style="max-width:240px;max-height:240px;border-radius:8px;margin:6px 0;display:block"></a>` : ""}
      ${reply.status === "responded"
        ? `<div class="responded">返信済み（${fmtDate(reply.respondedAt)}）: ${nl2br(reply.responseText)}</div>`
        : reply.status === "ignored"
          ? `<div class="row-actions"><button class="small-button ghost" data-reply-action="reopen" data-id="${reply.id}" type="button">未対応に戻す</button></div>`
          : `
          ${reply.status === "held" ? `<div class="notice inline">要確認: ${escapeHtml(reply.holdReason || "")}。内容を見て、返信するなら文を直して「この内容で返信する」、しないなら「対応しない」</div>` : ""}
          ${safetyBlockHtml(reply, "reply")}
          <textarea class="reply-input" data-reply-input="${reply.id}" rows="3" placeholder="返信文（「AIで下書き」を押すか、直接入力）">${escapeHtml(reply.responseText || "")}</textarea>
          ${reply.error && !(reply.safety?.level === "blocked" && /安全確認/.test(reply.error)) ? errorBoxHtml(reply.error) : ""}
          <div class="row-actions">
            <button class="small-button primary" data-reply-action="send" data-id="${reply.id}" type="button">この内容で返信する</button>
            <span class="public-note">Threadsへ公開されます</span>
            ${reply.sendUncertainAt ? `<button class="small-button" data-reply-action="reconcile" data-id="${reply.id}" type="button">Threadsで確認する</button><span class="public-note">送れたかどうかが不明です。Threadsで実際に返信が付いているか確かめます（送信はしません）</span>` : ""}
            <button class="small-button" data-reply-action="draft" data-id="${reply.id}" type="button">AIで下書き</button>
            ${reply.status === "drafted" && reply.autoQueued && state.settings.autoReplyEnabled ? `<button class="small-button" data-reply-action="unqueue" data-id="${reply.id}" type="button">自動送信をやめる（下書きは残す）</button>` : ""}
            <span class="spacer"></span>
            <button class="small-button ghost" data-reply-action="ignore" data-id="${reply.id}" type="button">対応しない</button>
          </div>`}
    </article>
  `).join("") : `<p class="notice">${filter === "open" ? "未対応のコメントはありません。「コメントを取得」で最新を取り込めます。" : "該当するコメントはありません。"}</p>`;
}

async function replyAction(action, id, button) {
  const input = $(`[data-reply-input="${id}"]`);
  if (action === "safety-override") return safetyOverride("reply", id, button, (input?.value || "").trim());
  if (action === "draft") {
    await busy(button, "作成中", async () => {
      const result = await api(`/api/replies/${encodeURIComponent(id)}/draft`, { method: "POST" });
      if (input) input.value = result.reply.responseText;
      await loadState();
      toast("下書きを作りました。内容を確認してから送信してください。");
    });
  }
  if (action === "send") {
    const text = (input?.value || "").trim();
    if (!text) return toast("返信文が空です。", "error");
    if (!confirm(`この返信を Threads に外部公開します（取り消せません）。\n\n${text}`)) return;
    await busy(button, "送信中", async () => {
      try {
        await api(`/api/replies/${encodeURIComponent(id)}/respond`, { method: "POST", body: { text } });
        toast("返信しました。");
      } finally {
        await loadState();
      }
    });
  }
  if (action === "reconcile") {
    await busy(button, "確認中", async () => {
      try {
        const result = await api(`/api/replies/${encodeURIComponent(id)}/reconcile`, { method: "POST" });
        toast(result.outcome === "responded" ? "Threadsに返信が付いていました。返信済みにしました。" : "Threadsに返信は付いていませんでした。送れる状態に戻しました。内容を見て送信してください。");
      } finally {
        await loadState();
      }
    });
    return;
  }
  if (action === "open-response") {
    const win = window.open("", "_blank"); // 非同期の後に開くとブロックされるので、先に空の窓を開けておく
    try {
      const result = await api(`/api/replies/${encodeURIComponent(id)}/response-link`);
      if (win) { win.opener = null; win.location.href = result.url; } else window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      if (win) win.close();
      toast(`返信のURLを取得できませんでした: ${error.message}`, "error");
    }
    return;
  }
  if (action === "hide") {
    if (!confirm("このコメントをスパムとして非表示にします。Threads上で全員に対して非表示になります（削除ではなく、Threadsの画面から元に戻せます）。")) return;
    await busy(button, "非表示中", async () => {
      await api(`/api/replies/${encodeURIComponent(id)}/hide`, { method: "POST", body: { hide: true } });
      await loadState();
      toast("スパムとして非表示にしました。");
    });
    return;
  }
  if (action === "unhide") {
    await busy(button, "解除中", async () => {
      await api(`/api/replies/${encodeURIComponent(id)}/hide`, { method: "POST", body: { hide: false } });
      await loadState();
      toast("非表示を解除しました。");
    });
    return;
  }
  if (action === "ignore" || action === "reopen" || action === "unqueue") {
    await busy(button, "更新中", async () => {
      // unqueue: 「未対応に戻す」と同じ経路で、下書きは残しつつ自動送信の資格だけ外す
      await api(`/api/replies/${encodeURIComponent(id)}`, { method: "PUT", body: { status: action === "ignore" ? "ignored" : "unhandled", responseText: input?.value } });
      await loadState();
      if (action === "unqueue") toast("自動送信の列から外しました。送るときは「この内容で返信する」を押してください。");
    });
  }
}

// 入力途中の返信文を保存しておく（画面の再描画で消えないように）
async function persistReplyDraft(id, text) {
  const reply = state.replies.find((r) => r.id === id);
  if (!reply || reply.responseText === text) return;
  reply.responseText = text;
  try {
    await api(`/api/replies/${encodeURIComponent(id)}`, { method: "PUT", body: { responseText: text } });
  } catch (error) {
    console.warn(error);
  }
}

// ---------------------------------------------------------------------------
// 分析・改善
// ---------------------------------------------------------------------------
// 長い一覧（投稿キュー・参考投稿・投稿別の表・改善提案）は「さらに表示」で足していく
const MORE_RENDER = { queue: () => renderQueue(), refs: () => renderReferences(), posts: () => renderAnalysis(), sugg: () => renderAnalysis() };
function limitedSlice(key, items) {
  return items.slice(0, listLimit[key]);
}
function moreHtml(key, total) {
  return moreRowHtml(key, Math.min(listLimit[key], total), total);
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-more]");
  if (!button || button.disabled) return;
  const key = button.dataset.more;
  listLimit[key] += LIST_STEP[key];
  MORE_RENDER[key]?.();
});

function renderAnalysis() {
  const stats = state.stats || { publishedWithInsights: 0, byCategory: {}, byTimeSlot: {}, top: [] };
  const latest = new Map();
  for (const item of state.insights) if (!latest.has(item.postId)) latest.set(item.postId, item);
  for (const post of state.posts) if (post.finalMetrics && !latest.has(post.id)) latest.set(post.id, { postId: post.id, metrics: post.finalMetrics }); // 削除した投稿の最後の数字
  const totals = {};
  for (const item of latest.values()) for (const [k, v] of Object.entries(item.metrics || {})) totals[k] = (totals[k] || 0) + Number(v || 0);
  const labels = { views: "閲覧", likes: "いいね", replies: "返信", reposts: "再投稿", quotes: "引用", shares: "シェア" };
  $("#insightSummary").innerHTML = latest.size
    ? `<div class="analysis-card"><span>集計対象</span><h3>${latest.size}投稿</h3></div>` + Object.entries(labels).map(([k, label]) => `<div class="analysis-card"><span>${label}</span><h3>${(totals[k] || 0).toLocaleString()}</h3></div>`).join("")
    : `<p class="notice">まだインサイトがありません。公開済みの投稿ができたら「インサイトを取得」を押してください（公開直後は数値が0のことがあります）。</p>`;

  const groupTable = (obj) => {
    const rows = Object.entries(obj).sort((a, b) => b[1].avgViews - a[1].avgViews);
    if (!rows.length) return `<p class="notice">データなし</p>`;
    return `<table><thead><tr><th></th><th>本数</th><th>平均閲覧</th><th>平均いいね</th><th>平均返信</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v.count}</td><td>${v.avgViews.toLocaleString()}</td><td>${v.avgLikes}</td><td>${v.avgReplies}</td></tr>`).join("")}</tbody></table>`;
  };
  $("#categoryTable").innerHTML = groupTable(stats.byCategory);
  $("#timeSlotTable").innerHTML = groupTable(stats.byTimeSlot);
  $("#themeTable").innerHTML = groupTable(stats.byTheme || {});

  const rows = state.posts
    .filter((post) => post.status === "published" && latest.has(post.id))
    .map((post) => ({ post, m: latest.get(post.id).metrics || {} }))
    .sort((a, b) => (b.m.views || 0) - (a.m.views || 0));
  $("#postInsightTable").innerHTML = rows.length
    ? `<table><thead><tr><th>公開</th><th>カテゴリ</th><th>本文</th><th>閲覧</th><th>いいね</th><th>返信</th><th>再投稿</th></tr></thead><tbody>${limitedSlice("posts", rows).map(({ post, m }) => `<tr><td>${fmtDate(post.publishedAt)}</td><td>${escapeHtml(post.category)}</td><td class="cell-text">${escapeHtml(post.text.slice(0, 80))}${safeHref(post.permalink) ? ` <a class="link" href="${safeHref(post.permalink)}" target="_blank" rel="noreferrer">開く</a>` : ""}</td><td>${m.views || 0}</td><td>${m.likes || 0}</td><td>${m.replies || 0}</td><td>${m.reposts || 0}</td></tr>`).join("")}</tbody></table>${moreHtml("posts", rows.length)}`
    : `<p class="notice">データなし</p>`;

  $("#suggestionList").innerHTML = state.suggestions.length ? limitedSlice("sugg", state.suggestions).map((s) => `
    <article class="post-card">
      <div class="post-meta">${fmtDate(s.at)} / インサイト付き${s.basedOn}投稿をもとに生成</div>
      <p>${nl2br(s.summary)}</p>
      <div class="sug-grid">
        <div><h4>伸ばす</h4><ul>${(s.doMore || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>
        <div><h4>減らす</h4><ul>${(s.avoid || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>
        <div><h4>次のテーマ案</h4><ul>${(s.nextTopics || []).map((x) => `<li>${escapeHtml(x)} <button class="small-button ghost" data-use-topic="${escapeHtml(x)}" type="button">生成に使う</button></li>`).join("")}</ul></div>
        <div><h4>文体・構成</h4><ul>${(s.styleNotes || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>
      </div>
    </article>
  `).join("") + moreHtml("sugg", state.suggestions.length) : `<p class="notice">改善提案はまだありません。インサイト付きの公開投稿が3件以上になると生成できます。</p>`;
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
function renderSettings() {
  const s = state.settings;
  $("#aiProvider").value = s.aiProvider || "gemini";
  $("#claudeModel").value = s.claudeModel || "sonnet";
  $("#codexModel").value = s.codexModel || "";
  $("#anthropicApiKey").value = s.anthropicApiKey || "";
  $("#anthropicModel").value = s.anthropicModel || "claude-sonnet-5";
  updateProviderFields();
  $("#geminiApiKey").value = s.geminiApiKey || "";
  $("#geminiModel").value = s.geminiModel || "";
  $("#geminiModelAuto").checked = s.geminiModelAuto !== false;
  $("#geminiModel").disabled = $("#geminiModelAuto").checked;
  $("#geminiModel").placeholder = $("#geminiModelAuto").checked ? "自動選択（最初の呼び出し時に決定）" : "例: gemini-2.5-flash-lite";
  $("#geminiStatus").textContent = s.geminiApiKey ? `APIキー設定済み / モデル: ${s.geminiModel || "自動（初回呼び出し時に決定）"}` : "APIキー未設定";
  $("#researchProviderNote").textContent = (s.aiProvider || "gemini") === "claude-api" ? "Webで集めた参考の検索は Claude API では使えません（Gemini または Claude Code に切り替えてください）。" : "";
  $("#threadsAppId").value = s.threadsAppId || "";
  $("#expectedThreadsUsername").value = s.expectedThreadsUsername || "";
  $("#threadsLinkCode").value = "";
  updateThreadsAuthHint();
  $("#threadsLinkStatus").textContent = s.threadsOAuthExchangeUrl && s.threadsOAuthClientToken && s.expectedThreadsUsername ? `連携コード: 設定済み（@${s.expectedThreadsUsername}）` : (s.threadsAppId ? "" : "連携コード: まだ入っていません");
  $("#threadsAppSecret").value = s.threadsAppSecret || "";
  $("#threadsOAuthExchangeUrl").value = s.threadsOAuthExchangeUrl || "";
  $("#threadsOAuthClientToken").value = s.threadsOAuthClientToken || "";
  $("#licenseKey").value = s.licenseKey || "";
  $("#licenseResumeMode").value = s.licenseResumeMode === "auto" ? "auto" : "ask";
  $("#threadsRedirectUri").value = s.threadsRedirectUri || "";
  $("#threadsScopes").value = s.threadsScopes || "";
  $("#threadsAccessToken").value = s.threadsAccessToken || "";
  $("#accessKey").value = s.accessKey || "";
  renderSettingsStatus();
  $("#brandName").value = s.brandName || "";
  $("#defaultCta").value = s.defaultCta || "";
  $("#profile").value = s.profile || "";
  $("#writingRules").value = s.writingRules || "";
  $("#replyStyle").value = s.replyStyle || "";
  $("#materials").value = s.materials || "";
  $("#materialFolder").value = s.materialFolder || "";
  $("#scheduleTimes").value = (s.scheduleTimes || []).join(",");
  $("#postsPerDay").value = s.postsPerDay || 0;
  $("#safetyDailyPostLimit").value = s.safetyDailyPostLimit ?? 10;
  $("#safetyMinIntervalMinutes").value = s.safetyMinIntervalMinutes ?? 10;
  $("#safetySimilarBlockPct").value = s.safetySimilarBlockPct ?? 70;
  $("#safetySimilarWarnPct").value = s.safetySimilarWarnPct ?? 45;
  $("#safetyMaxPostsPer24h").value = s.safetyMaxPostsPer24h ?? 200;
  $("#safetySurgeRatio").value = s.safetySurgeRatio ?? 2;
  $("#safetyLinkWarnCount").value = s.safetyLinkWarnCount ?? 3;
  $("#safetyReplySimilarPct").value = s.safetyReplySimilarPct ?? 80;
  $("#safetyReplyMaxPer24h").value = s.safetyReplyMaxPer24h ?? 800;
  $("#safetyBannedWords").value = s.safetyBannedWords || "";
  $("#rebuzzEnabled").checked = Boolean(s.rebuzzEnabled);
  $("#rebuzzPerDay").value = s.rebuzzPerDay ?? 5;
  $("#rebuzzMinViews").value = s.rebuzzMinViews ?? 500;
  $("#rebuzzCooldownDays").value = s.rebuzzCooldownDays ?? 7;
  $("#repostEnabled").checked = Boolean(s.repostEnabled);
  $("#repostPerDay").value = s.repostPerDay ?? 3;
  $("#repostMinViews").value = s.repostMinViews ?? 500;
  $("#repostCooldownDays").value = s.repostCooldownDays ?? 14;
  $("#scheduleFromHour").value = s.scheduleFromHour ?? 7;
  $("#scheduleToHour").value = s.scheduleToHour ?? 21;
  $("#autoPublishEnabled").checked = Boolean(s.autoPublishEnabled);
  $("#autoFetchRepliesEnabled").checked = s.autoFetchRepliesEnabled !== false;
  $("#autoFetchRepliesMinutes").value = s.autoFetchRepliesMinutes || 5;
  $("#autoReplyEnabled").checked = Boolean(s.autoReplyEnabled);
  $("#autoReplyIntervalSec").value = s.autoReplyIntervalSec || 20;
  $("#autoReplyDailyCap").value = s.autoReplyDailyCap || 500;
  $("#autoInsightsEnabled").checked = s.autoInsightsEnabled !== false;
  $("#autoDeleteLowLikesEnabled").checked = Boolean(s.autoDeleteLowLikesEnabled);
  $("#autoDeleteMaxLikes").value = Number.isInteger(s.autoDeleteMaxLikes) ? s.autoDeleteMaxLikes : 2;
  $("#autoDeleteMaxReplies").value = Number.isInteger(s.autoDeleteMaxReplies) ? s.autoDeleteMaxReplies : 2;
  $("#themeRows").innerHTML = (s.themes || []).map((t) => themeRowHtml(t)).join("") || `<p class="empty" data-empty>まだ登録していません。</p>`;
  $("#campaignRows").innerHTML = (s.campaigns || []).map((c, i) => campaignRowHtml(c, i)).join("") || `<p class="empty" data-empty>まだ登録していません。</p>`;
}

// ---------------------------------------------------------------------------
// 発信テーマ・宣伝したいもの（設定の行）
// ---------------------------------------------------------------------------
const THEME_WEIGHTS = [[3, "よく"], [2, "ときどき"], [1, "たまに"]];
const THEME_EVERY = [[0, "指定なし"], [1, "毎日"], [2, "2日に1回"], [3, "3日に1回"], [4, "4日に1回"], [5, "5日に1回"], [7, "1週間に1回"], [14, "2週間に1回"], [30, "30日に1回"]];
function optionsHtml(list, value) {
  return list.map(([v, label]) => `<option value="${v}"${Number(value) === v ? " selected" : ""}>${label}</option>`).join("");
}
function shortDay(ymd) {
  const m = String(ymd || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])}/${Number(m[2])}` : "";
}
function themeRowHtml(t = {}) {
  const every = THEME_EVERY.some(([v]) => v === Number(t.everyDays || 0)) ? THEME_EVERY : [...THEME_EVERY, [Number(t.everyDays), `${t.everyDays}日に1回`]];
  return `
  <div class="setting-row theme-row" data-id="${escapeHtml(t.id || "")}">
    <div class="form-grid">
      <label>テーマ名<input data-f="name" maxlength="40" value="${escapeHtml(t.name || "")}" placeholder="例: 60代の生き方" /></label>
      <label>誰に向けて（任意）<input data-f="audience" maxlength="200" value="${escapeHtml(t.audience || "")}" placeholder="例: 韓国ドラマ好きの50〜60代" /></label>
      <label>出す量<select data-f="weight">${optionsHtml(THEME_WEIGHTS, t.weight ?? 2)}</select></label>
      <label>何日に1回は必ず<select data-f="everyDays">${optionsHtml(every, t.everyDays || 0)}</select></label>
      <label class="wide">補足（任意・このテーマで書いてほしいこと）<input data-f="note" maxlength="500" value="${escapeHtml(t.note || "")}" /></label>
      <label>トピックタグ（任意・1つだけ・#は不要）<input data-f="topicTag" maxlength="50" value="${escapeHtml(t.topicTag || "")}" /></label>
      <label class="toggle-row"><input data-f="enabled" type="checkbox"${t.enabled === false ? "" : " checked"} /> このテーマを使う</label>
    </div>
    <div class="setting-row-actions"><button class="button text-button" type="button" data-remove-row>このテーマを消す</button></div>
  </div>`;
}
function campaignRowHtml(c = {}, index = 0) {
  const made = c.id ? state.posts.filter((p) => p.campaignId === c.id && p.status !== "rejected") : [];
  const waiting = made.filter((p) => p.status === "review").length;
  return `
  <div class="setting-row campaign-row" data-id="${escapeHtml(c.id || "")}">
    <div class="form-grid">
      <label class="wide">宣伝したいもの<input data-f="title" maxlength="100" value="${escapeHtml(c.title || "")}" placeholder="例: 電子書籍の無料ダウンロード" /></label>
      <label class="wide">内容（何を・どう受け取れるか。ここに書いたことだけを使って書きます）<textarea data-f="detail" rows="3" maxlength="1000">${escapeHtml(c.detail || "")}</textarea></label>
      <label>始まりの日<input data-f="startDate" type="date" value="${escapeHtml(c.startDate || "")}" /></label>
      <label>終わりの日（この日も含む）<input data-f="endDate" type="date" value="${escapeHtml(c.endDate || "")}" /></label>
      <label>1日の本数<select data-f="perDay">${optionsHtml([[1, "1本"], [2, "2本"], [3, "3本"]], c.perDay || 1)}</select></label>
      <label>URL（任意）<input data-f="url" type="url" maxlength="2000" value="${escapeHtml(c.url || "")}" placeholder="https://" /></label>
      <label class="toggle-row"><input data-f="linkInBody" type="checkbox"${c.linkInBody ? " checked" : ""} /> <span>本文の最後にURLを入れる<span class="sub-note">入れないときは「プロフィールのリンクから」と書きます。リンクの多い投稿は宣伝に見えやすくなります</span></span></label>
      <label class="toggle-row"><input data-f="enabled" type="checkbox"${c.enabled === false ? "" : " checked"} /> この宣伝を使う</label>
    </div>
    <div class="setting-row-actions">
      <button class="button secondary" type="button" data-campaign-generate="${index}"${made.length ? " disabled" : ""}>宣伝投稿を作る</button>
      <span class="hint inline">${made.length ? `作成済み ${made.length}本（承認待ち ${waiting}本）。投稿キューで確認してください。作り直すときは、今ある分を却下してから押します` : "押すと、期間の毎日の分が承認待ちに入ります（設定も保存します）"}</span>
      <span class="spacer"></span>
      <button class="button text-button" type="button" data-remove-row>この宣伝を消す</button>
    </div>
  </div>`;
}
function collectRows(selector, fields) {
  return $$(selector).map((row) => {
    const item = row.dataset.id ? { id: row.dataset.id } : {};
    for (const [key, kind] of fields) {
      const input = row.querySelector(`[data-f="${key}"]`);
      item[key] = kind === "bool" ? input.checked : kind === "num" ? Number(input.value) : input.value;
    }
    return item;
  });
}
function collectThemes() {
  return collectRows("#themeRows .theme-row", [["name"], ["audience"], ["weight", "num"], ["everyDays", "num"], ["note"], ["topicTag"], ["enabled", "bool"]]);
}
function collectCampaigns() {
  return collectRows("#campaignRows .campaign-row", [["title"], ["detail"], ["startDate"], ["endDate"], ["perDay", "num"], ["url"], ["linkInBody", "bool"], ["enabled", "bool"]]);
}
function markSettingsDirty() {
  settingsDirty = true;
  $("#settingsDirtyNote").hidden = false;
}
function addSettingRow(container, html) {
  container.querySelector("[data-empty]")?.remove();
  container.insertAdjacentHTML("beforeend", html);
  container.lastElementChild.querySelector("input")?.focus();
  markSettingsDirty();
}
async function generateCampaign(button) {
  const index = Number(button.dataset.campaignGenerate);
  const row = $$("#campaignRows .campaign-row")[index];
  const title = row?.querySelector('[data-f="title"]').value.trim() || "この宣伝";
  if (!confirm(`「${title}」の宣伝投稿を作ります。設定を保存してから、期間の毎日の分を承認待ちに入れます。外にはまだ出ません。続けますか。`)) return;
  if (settingsDirty || !row?.dataset.id) {
    if (!(await saveSettings($("#saveSettingsBtn")))) return;
  }
  const campaign = (state.settings.campaigns || [])[index];
  if (!campaign) { toast("宣伝したいものを保存できませんでした。名前と期間を確かめてください。"); return; }
  const target = $$("#campaignRows [data-campaign-generate]")[index] || button;
  await busy(target, "作成中（1分ほど）", async () => {
    const result = await api(`/api/campaigns/${encodeURIComponent(campaign.id)}/generate`, { method: "POST", body: {} });
    await loadState();
    if (!settingsDirty) renderSettings();
    toast(`「${campaign.title}」の宣伝投稿を${result.posts.length}件作りました${result.missing ? `（予定${result.planned}本のうち${result.missing}本は作れませんでした。ログに理由があります）` : ""}${(result.skippedDays || []).length ? `（予約できる時刻が足りない日が${result.skippedDays.length}日あり、合わせて${result.skippedDays.reduce((n, x) => n + (Number(x.missing) || 0), 0)}本を作れませんでした。ログに理由があります）` : ""}。投稿キューで本文を確かめて、承認してください。`);
  });
}

// 「Threadsと連携する」の横の一言。連携コード欄が空で、まだ連携の準備ができていないときだけ出す
function updateThreadsAuthHint() {
  const s = state.settings;
  const prepared = Boolean(s.threadsOAuthExchangeUrl && s.threadsOAuthClientToken && s.expectedThreadsUsername) || Boolean(s.threadsAppId);
  $("#threadsAuthHint").hidden = prepared || Boolean($("#threadsLinkCode").value.trim());
}

// 設定タブのうち、入力欄ではない表示（接続状態・注記）だけを更新する。未保存編集があっても呼んでよい
function renderSettingsStatus() {
  const s = state.settings;
  updateThreadsAuthHint();
  const linkedNow = Boolean(s.threadsAccessToken) && !threadsTokenExpired();
  $("#threadsConnection").innerHTML = connLine("Threads", linkedNow, threadsTokenNote(), true)
    + (s.threadsUsername || s.threadsUserId
      ? linkedNow
        ? `<div class="post-meta">${s.threadsUsername ? `@${escapeHtml(s.threadsUsername)} / ` : ""}ユーザーID: ${escapeHtml(s.threadsUserId || "")}</div>`
        : `<div class="post-meta">前回連携したアカウント: ${s.threadsUsername ? `@${escapeHtml(s.threadsUsername)}` : `ユーザーID ${escapeHtml(s.threadsUserId || "")}`}<span class="nowrap">（今は未連携）</span></div>`
      : "")
    + (state.https?.enabled || state.https?.disabled ? "" : `<div class="error-box">認可コールバック用の https が起動していません: ${escapeHtml(state.https?.reason || "")}</div>`)
    + (state.publicOrigin ? `<div class="post-meta">公開URL: ${escapeHtml(state.publicOrigin)}（サーバー運用）</div>` : "");
  $("#settingsDirtyNote").hidden = !settingsDirty;
  $("#appVersion").textContent = state.version ? `v${state.version}` : "";
  $("#dataDirNote").textContent = state.dataDir ? `データの保存先: ${state.dataDir}（キーやトークンが入ります。他の人と共有するフォルダに置かないでください）` : "";
}

function updateProviderFields() {
  const provider = $("#aiProvider").value;
  $$("[data-provider]").forEach((el) => { el.hidden = el.dataset.provider !== provider; });
}

function collectSettings() {
  return {
    aiProvider: $("#aiProvider").value,
    claudeModel: $("#claudeModel").value,
    codexModel: $("#codexModel").value,
    anthropicApiKey: $("#anthropicApiKey").value,
    anthropicModel: $("#anthropicModel").value,
    geminiApiKey: $("#geminiApiKey").value,
    geminiModel: $("#geminiModel").value,
    geminiModelAuto: $("#geminiModelAuto").checked,
    threadsAppId: $("#threadsAppId").value,
    expectedThreadsUsername: $("#expectedThreadsUsername").value,
    threadsLinkCode: $("#threadsLinkCode").value,
    threadsAppSecret: $("#threadsAppSecret").value,
    threadsOAuthExchangeUrl: $("#threadsOAuthExchangeUrl").value,
    threadsOAuthClientToken: $("#threadsOAuthClientToken").value,
    licenseKey: $("#licenseKey").value,
    licenseResumeMode: $("#licenseResumeMode").value,
    threadsRedirectUri: $("#threadsRedirectUri").value,
    threadsScopes: $("#threadsScopes").value,
    threadsAccessToken: $("#threadsAccessToken").value,
    accessKey: $("#accessKey").value,
    brandName: $("#brandName").value,
    defaultCta: $("#defaultCta").value,
    profile: $("#profile").value,
    writingRules: $("#writingRules").value,
    replyStyle: $("#replyStyle").value,
    materials: $("#materials").value,
    materialFolder: $("#materialFolder").value,
    scheduleTimes: $("#scheduleTimes").value,
    postsPerDay: $("#postsPerDay").value,
    safetyDailyPostLimit: $("#safetyDailyPostLimit").value,
    safetyMinIntervalMinutes: $("#safetyMinIntervalMinutes").value,
    safetySimilarBlockPct: $("#safetySimilarBlockPct").value,
    safetySimilarWarnPct: $("#safetySimilarWarnPct").value,
    safetyMaxPostsPer24h: $("#safetyMaxPostsPer24h").value,
    safetySurgeRatio: $("#safetySurgeRatio").value,
    safetyLinkWarnCount: $("#safetyLinkWarnCount").value,
    safetyReplySimilarPct: $("#safetyReplySimilarPct").value,
    safetyReplyMaxPer24h: $("#safetyReplyMaxPer24h").value,
    safetyBannedWords: $("#safetyBannedWords").value,
    rebuzzEnabled: $("#rebuzzEnabled").checked,
    rebuzzPerDay: $("#rebuzzPerDay").value,
    rebuzzMinViews: $("#rebuzzMinViews").value,
    rebuzzCooldownDays: $("#rebuzzCooldownDays").value,
    repostEnabled: $("#repostEnabled").checked,
    repostPerDay: $("#repostPerDay").value,
    repostMinViews: $("#repostMinViews").value,
    repostCooldownDays: $("#repostCooldownDays").value,
    scheduleFromHour: $("#scheduleFromHour").value,
    scheduleToHour: $("#scheduleToHour").value,
    autoPublishEnabled: $("#autoPublishEnabled").checked,
    autoFetchRepliesEnabled: $("#autoFetchRepliesEnabled").checked,
    autoFetchRepliesMinutes: $("#autoFetchRepliesMinutes").value,
    autoReplyEnabled: $("#autoReplyEnabled").checked,
    autoReplyIntervalSec: $("#autoReplyIntervalSec").value,
    autoReplyDailyCap: $("#autoReplyDailyCap").value,
    autoInsightsEnabled: $("#autoInsightsEnabled").checked,
    autoDeleteLowLikesEnabled: $("#autoDeleteLowLikesEnabled").checked,
    autoDeleteMaxLikes: $("#autoDeleteMaxLikes").value,
    autoDeleteMaxReplies: $("#autoDeleteMaxReplies").value,
    themes: collectThemes(),
    campaigns: collectCampaigns()
  };
}

async function saveSettings(button) {
  const enteredKey = $("#accessKey").value.trim();
  const wasOn = Boolean(state.settings.autoPublishEnabled);
  if ($("#autoPublishEnabled").checked && !wasOn) {
    if (!confirm("予約投稿の自動送信をONにします。予約済みの投稿は、時刻になるとThreadsへ外部公開されます。続けますか。")) {
      $("#autoPublishEnabled").checked = false;
      return false;
    }
  }
  const result = await busy(button, "保存中", async () => {
    await api("/api/settings", { method: "POST", body: collectSettings() });
    // 保存は旧キーで通す。通ったあとに、このブラウザが覚えるキーを新しい値へ切り替える
    if (enteredKey && !enteredKey.includes("*")) setAccessKey(enteredKey);
    if (!enteredKey) setAccessKey("");
    settingsDirty = false;
    await loadState();
    renderSettings();
    $("#settingsNotice").textContent = `保存しました（${new Date().toLocaleTimeString("ja-JP")}）`;
    toast("設定を保存しました。");
    return true;
  });
  return Boolean(result);
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------
function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.body.addEventListener("click", (event) => {
    const goto = event.target.closest("[data-goto]");
    if (goto) {
      showView(goto.dataset.goto, { filter: goto.dataset.filter });
      if (goto.dataset.focus) focusField(goto.dataset.focus);
    }
    const hold = event.target.closest("[data-license-hold]");
    if (hold) {
      const action = hold.dataset.licenseHold;
      busy(hold, action === "publish" ? "出しています" : "破棄しています", async () => {
        await api(`/api/posts/${encodeURIComponent(hold.dataset.id)}/license-hold`, { method: "POST", body: { action } });
        await loadState();
        toast(action === "discard" ? "破棄しました（却下に移しました）。" : state.settings.autoPublishEnabled ? "出すことにしました。まもなく公開します。" : "予約し直しました。自動送信がOFFなので、投稿キューで「今すぐ投稿」を押してください。", "info", 8000);
        return true;
      });
    }
    const tab = event.target.closest(".tab");
    if (tab) {
      const group = tab.closest(".tabs");
      group.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      group.parentElement.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === tab.dataset.tab));
    }
    const topic = event.target.closest("[data-use-topic]");
    if (topic) {
      $("#topicInput").value = topic.dataset.useTopic;
      showView("generate");
      toast("テーマに入れました。");
    }
  });

  $("#reloadBtn").addEventListener("click", (e) => busy(e.currentTarget, "読込中", loadState));

  // リサーチ
  $("#refSearchBtn").addEventListener("click", (e) => busy(e.currentTarget, "検索中（最大5分・見つからないときはWeb検索に切り替えます）", async () => {
    const keyword = $("#refKeyword").value.trim();
    if (!keyword) throw new Error("キーワードを入力してください。");
    const result = await api("/api/references/search", { method: "POST", body: { keyword, searchType: $("#refSearchType").value, minLikes: $("#refMinLikes").value } });
    await loadState();
    const note = result.minLikes > 0 ? `（いいね${result.minLikes}未満の${result.belowMin}件は除きました。反応数が取れた投稿は${result.withMetrics}件）` : (result.withMetrics === 0 ? "（反応数は取れませんでした）" : "");
    toast(`${result.via === "web" ? "Web検索経由で" : "Threads APIで"}${result.found}件見つかり、${result.added}件を候補に追加しました。${note}`);
  }));
  $("#refSort").addEventListener("change", renderReferences);
  $("#refAccountBtn").addEventListener("click", (e) => busy(e.currentTarget, "集めています", async () => {
    const username = $("#refAccount").value.trim().replace(/^@/, "");
    if (!username) throw new Error("アカウント名を入力してください。");
    const minLikes = Math.max(0, Math.floor(Number($("#refMinLikes").value) || 0));
    const result = await api("/api/profile-posts", { method: "POST", body: { username, limit: 100, save: true } });
    await loadState();
    const hit = (result.posts || []).filter((p) => p.likes !== null && p.likes >= minLikes).length;
    toast(result.withMetrics
      ? `@${result.username}の投稿${result.count}件のうち、${result.saved}件を候補に追加しました（いいね${minLikes}以上は${hit}件。並べ替えで上に出ます）。`
      : `@${result.username}の投稿${result.count}件を候補に追加しました。反応数は取れませんでした。`);
  }));
  $("#draftBatchBtn").addEventListener("click", (e) => busy(e.currentTarget, "AIがまとめて判定中", async () => {
    const result = await api("/api/replies/draft-batch", { method: "POST" });
    await loadState();
    toast(`下書き${result.drafted}件・要確認${result.held}件（10件ずつ処理します。未対応が残っていればもう一度押してください）。`);
  }));
  // 下書きのまま残っているコメント返信を、1件ずつ順に送る（個別送信と同じ /respond を使い、間隔は自動返信の間隔に合わせる）
  $("#sendDraftsBtn").addEventListener("click", (e) => busy(e.currentTarget, "送信中（1件ずつ順に送っています）", async () => {
    const drafts = state.replies.filter((r) => r.status === "drafted" && String(r.responseText || "").trim());
    if (!drafts.length) { toast("送信できる下書きはありません。"); return; }
    const gapSec = Math.max(5, Number(state.settings.autoReplyIntervalSec) || 20);
    const eta = Math.ceil(((drafts.length - 1) * gapSec) / 60);
    if (!window.confirm(`下書き${drafts.length}件を、Threadsにそのまま送信します（${gapSec}秒間隔・約${eta}分）。送信すると取り消せません。よろしいですか。`)) return;
    let sent = 0;
    const failed = [];
    for (const [i, reply] of drafts.entries()) {
      try {
        await api(`/api/replies/${encodeURIComponent(reply.id)}/respond`, { method: "POST", body: { text: reply.responseText } });
        sent += 1;
      } catch (error) {
        failed.push(`@${reply.username || "名前不明"}: ${error.message}`);
      }
      if (i < drafts.length - 1) await new Promise((resolve) => setTimeout(resolve, gapSec * 1000));
    }
    await loadState();
    toast(`${drafts.length}件中、${sent}件を送信しました。${failed.length ? `失敗${failed.length}件` : ""}`, failed.length ? "error" : "info", 8000, failed.join(String.fromCharCode(10)));
  }));
  // 「要確認」のコメントを全部「対応しない」にする（返信は送らない。後から1件ずつ「未対応」に戻せる）
  $("#ignoreHeldBtn").addEventListener("click", (e) => busy(e.currentTarget, "処理中", async () => {
    const held = heldReplies();
    if (!held.length) { toast("「要確認」のコメントはありません。"); return; }
    if (!window.confirm(`「要確認」のコメント${held.length}件を、すべて「対応しない」にします（返信は送りません）。よろしいですか。`)) return;
    let done = 0;
    const failed = [];
    for (const reply of held) {
      try {
        await api(`/api/replies/${encodeURIComponent(reply.id)}`, { method: "PUT", body: { status: "ignored", responseText: reply.responseText || "" } });
        done += 1;
      } catch (error) {
        failed.push(`@${reply.username || "名前不明"}: ${error.message}`);
      }
    }
    await loadState();
    toast(`${held.length}件中、${done}件を「対応しない」にしました。${failed.length ? `失敗${failed.length}件` : ""}`, failed.length ? "error" : "info", 8000, failed.join(String.fromCharCode(10)));
  }));
  $("#refManualAddBtn").addEventListener("click", (e) => busy(e.currentTarget, "追加中", async () => {
    await api("/api/references", { method: "POST", body: { text: $("#refManualText").value, username: $("#refManualUser").value.replace(/^@/, ""), permalink: $("#refManualUrl").value, likes: $("#refManualLikes").value, replies: $("#refManualReplies").value } });
    $("#refManualLikes").value = "";
    $("#refManualReplies").value = "";
    $("#refManualText").value = "";
    $("#refManualUser").value = "";
    $("#refManualUrl").value = "";
    await loadState();
    toast("候補に追加しました（選択済み）。");
  }));
  $("#refAnalyzeBtn").addEventListener("click", (e) => busy(e.currentTarget, "分析中（30秒ほど）", async () => {
    const result = await api("/api/references/analyze", { method: "POST" });
    await loadState();
    toast(`${result.items.length}件の型を分析しました。`);
  }));
  $("#refClearBtn").addEventListener("click", (e) => busy(e.currentTarget, "解除中", async () => {
    for (const ref of state.references.filter((r) => r.selected)) {
      await api(`/api/references/${encodeURIComponent(ref.id)}`, { method: "PUT", body: { selected: false } });
    }
    await loadState();
  }));
  $("#refList").addEventListener("change", async (event) => {
    const refId = event.target.dataset.refToggle;
    if (!refId) return;
    try {
      await api(`/api/references/${encodeURIComponent(refId)}`, { method: "PUT", body: { selected: event.target.checked } });
      await loadState();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#refList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-ref-delete]");
    if (button) busy(button, "削除中", async () => {
      await api(`/api/references/${encodeURIComponent(button.dataset.refDelete)}`, { method: "DELETE" });
      await loadState();
    });
  });
  $("#autoResearchBtn").addEventListener("click", (e) => busy(e.currentTarget, "開始中", async () => {
    const r = await api("/api/research/run", { method: "POST", body: { keyword: $("#autoResearchKeyword").value.trim(), minLikes: $("#autoResearchMinLikes").value, maxAgeDays: $("#autoResearchMaxAge").value } });
    state.researchJob = r.job;
    renderAutoResearch();
    toast(r.alreadyRunning ? "前のリサーチがまだ進んでいます。終わるまでお待ちください。" : `リサーチを始めました（${(r.targets || []).map((t) => `「${t.keyword}」`).join("・")}）。1テーマで5〜10分ほど、最大20分で打ち切りです。`);
  }));
  $("#autoResearchCancelBtn").addEventListener("click", (e) => busy(e.currentTarget, "止めています", async () => {
    if (!state.researchJob) return;
    const r = await api(`/api/research/jobs/${encodeURIComponent(state.researchJob.id)}/cancel`, { method: "POST" });
    state.researchJob = r.job;
    renderAutoResearch();
  }));
  $("#researchBtn").addEventListener("click", (e) => busy(e.currentTarget, "検索中（30秒ほど）", async () => {
    const keyword = $("#researchKeyword").value.trim();
    if (!keyword) throw new Error("キーワードを入力してください。");
    const result = await api("/api/research", { method: "POST", body: { keyword } });
    await loadState();
    toast(`${result.research.sources.length}件の参照元候補を取得しました。使うものにチェックを入れてください。`);
  }));
  $("#researchResults").addEventListener("change", async (event) => {
    const sourceId = event.target.dataset.source;
    if (!sourceId) return;
    try {
      await api(`/api/research/sources/${encodeURIComponent(sourceId)}`, { method: "PUT", body: { selected: event.target.checked } });
      await loadState();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#researchResults").addEventListener("click", (event) => {
    const button = event.target.closest("[data-research-delete]");
    if (button) busy(button, "削除中", async () => {
      await api(`/api/research/${encodeURIComponent(button.dataset.researchDelete)}`, { method: "DELETE" });
      await loadState();
    });
  });

  // 投稿生成
  $("#generateBtn").addEventListener("click", (e) => busy(e.currentTarget, "生成中（1分ほど）", async () => {
    const payload = { goal: $("#goalInput").value, topic: $("#topicInput").value, date: $("#dateInput").value, count: Number($("#countInput").value || 8) };
    const result = await api("/api/generate-posts", { method: "POST", body: payload });
    await loadState();
    $("#generateResultPanel").hidden = false;
    $("#strategyMemo").textContent = result.strategyMemo || "";
    $("#generatedList").innerHTML = result.posts.map((post) => `<div class="mini-card"><div class="post-meta">${statusPill(post.status)} ${escapeHtml(post.category)}${post.theme ? ` / テーマ: ${escapeHtml(post.theme)}` : ""}${post.hookType ? ` / 型: ${escapeHtml(Object.hasOwn(HOOK_TYPE_LABEL, post.hookType) ? HOOK_TYPE_LABEL[post.hookType] : String(post.hookType))}` : ""} / ${fmtDate(post.scheduledAt)}</div><div>${nl2br(post.text)}</div></div>`).join("");
    toast(`${result.posts.length}件の投稿案を作りました。投稿キューで承認してください。`);
  }));

  // 投稿キュー
  $("#queueFilters").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.queueFilter = chip.dataset.status;
    listLimit.queue = LIST_STEP.queue;
    renderQueue();
  });
  $("#addPostBtn").addEventListener("click", () => openEditor());
  // 古いエラーは却下に移す（却下の一覧から「承認待ちに戻す」で戻せる）
  $("#clearStaleBtn").addEventListener("click", (e) => {
    const targets = state.posts.filter(isStaleError);
    if (!targets.length) return;
    if (!confirm(`${STALE_ERROR_DAYS}日以上前に失敗した${targets.length}件を却下に移します。あとで却下の一覧から承認待ちに戻せます。`)) return;
    busy(e.currentTarget, "片づけ中", async () => {
      // 1件が失敗しても残りを続け、最後に必ず読み直す（途中で止まると画面が古いまま残る）
      let done = 0;
      const failed = [];
      try {
        for (const post of targets) {
          try {
            await api(`/api/posts/${encodeURIComponent(post.id)}/transition`, { method: "POST", body: { action: "reject", reason: `${STALE_ERROR_DAYS}日以上前の送信エラーをまとめて片づけ` } });
            done += 1;
          } catch (err) {
            failed.push(err.message);
          }
        }
      } finally {
        await loadState();
      }
      toast(failed.length ? `${done}件を却下に移しました。${failed.length}件は移せませんでした: ${failed[0]}` : `${done}件を却下に移しました。`);
    });
  });
  $("#bulkApproveBtn").addEventListener("click", (e) => {
    if (!confirm(`承認待ち${countStatus("review")}件をすべて承認します。内容は確認済みですか。`)) return;
    busy(e.currentTarget, "承認中", async () => {
      const result = await api("/api/posts/bulk-approve", { method: "POST" });
      await loadState();
      const skipped = result.skipped || [];
      toast(`${result.count}件を承認しました。${skipped.length ? `\n承認できなかった${skipped.length}件: ${skipped.map((s) => `「${s.text}…」${s.reason}`).join(" / ")}` : ""}`, skipped.length ? "error" : "info", skipped.length ? 12000 : 5000);
    });
  });
  $("#postList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === "edit") return openEditor(state.posts.find((post) => post.id === id));
    if (action === "publish") return publishPost(id, button);
    if (action === "safety-override") return safetyOverride("post", id, button);
    if (action === "delete") return deletePost(id, button);
    return transition(id, action, button);
  });
  $("#editForm").addEventListener("submit", savePost);
  $("#editText").addEventListener("input", updateEditCount);
  $("#cancelEditBtn").addEventListener("click", () => $("#editDialog").close());

  // コメント返信
  $("#fetchRepliesBtn").addEventListener("click", (e) => busy(e.currentTarget, "取得中", async () => {
    const result = await api("/api/fetch-replies", { method: "POST" });
    await loadState();
    toast(`新しいコメントを${result.added}件取り込みました${result.failed ? `（${result.failed}件の投稿で取得失敗。ログを確認）` : ""}。`);
  }));
  $("#replyFilters").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.replyFilter = chip.dataset.status;
    renderReplies();
  });
  $("#safetySummary").addEventListener("click", (event) => {
    const button = event.target.closest("[data-safety-act]");
    if (button?.dataset.safetyAct === "enable") enableSafetyGuard(button);
  });
  $("#replyList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reply-action]");
    if (button) replyAction(button.dataset.replyAction, button.dataset.id, button);
  });
  $("#replyList").addEventListener("change", (event) => {
    const id = event.target.dataset.replyInput;
    if (id) persistReplyDraft(id, event.target.value);
  });

  // 分析
  $("#refreshInsightsBtn").addEventListener("click", (e) => busy(e.currentTarget, "取得中", async () => {
    const result = await api("/api/refresh-insights", { method: "POST" });
    await loadState();
    toast(`インサイトを取得しました（成功${result.fetched}件 / 失敗${result.failed}件）。`);
  }));
  $("#suggestBtn").addEventListener("click", (e) => busy(e.currentTarget, "生成中（30秒ほど）", async () => {
    await api("/api/suggestions", { method: "POST" });
    await loadState();
    toast("改善提案を生成しました。");
  }));

  // 設定
  $("#saveSettingsBtn").addEventListener("click", (e) => saveSettings(e.currentTarget));
  $("#geminiModelAuto").addEventListener("change", (e) => { $("#geminiModel").disabled = e.target.checked; });
  $("#aiProvider").addEventListener("change", updateProviderFields);
  $("#threadsLinkCode").addEventListener("input", updateThreadsAuthHint);
  $("#addThemeBtn").addEventListener("click", () => addSettingRow($("#themeRows"), themeRowHtml({ weight: 2, everyDays: 0 })));
  $("#addCampaignBtn").addEventListener("click", () => addSettingRow($("#campaignRows"), campaignRowHtml({ perDay: 1 }, $$("#campaignRows .campaign-row").length)));
  $("#settings").addEventListener("click", (e) => {
    const remove = e.target.closest("[data-remove-row]");
    if (remove) {
      remove.closest(".setting-row").remove();
      $$("#campaignRows [data-campaign-generate]").forEach((b, i) => { b.dataset.campaignGenerate = String(i); });
      markSettingsDirty();
      return;
    }
    const gen = e.target.closest("[data-campaign-generate]");
    if (gen) generateCampaign(gen);
  });
  $("#settings").addEventListener("input", (e) => {
    if (e.target.closest("#settingsForm, .form-grid")) { settingsDirty = true; $("#settingsDirtyNote").hidden = false; }
  });
  $("#settings").addEventListener("change", (e) => {
    if (e.target.closest(".setting-row")) markSettingsDirty();
  });
  $("#toast").addEventListener("click", (e) => { if (e.target.closest(".toast-close")) $("#toast").hidden = true; });
  window.addEventListener("beforeunload", (e) => { if (settingsDirty) { e.preventDefault(); e.returnValue = ""; } });
  $("#aiCheckBtn").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    if (!(await saveSettings(button))) return;
    await busy(button, "テスト中（最大3分）", async () => {
      const result = await api("/api/ai-check", { method: "POST" });
      toast(`${{ gemini: "Gemini", "claude-code": "Claude Code", "claude-api": "Claude API", codex: "Codex" }[result.provider] || result.provider} に接続できました（${(result.ms / 1000).toFixed(1)}秒・応答「${result.greeting}」）。`, "ok", 6000, result.command ? `使ったコマンド: ${result.command}` : "");
      await loadState({ keepSettingsForm: true });
    });
  });
  $("#autoGeminiModelBtn").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    if (!(await saveSettings(button))) return;
    await busy(button, "取得中", async () => {
      const result = await api("/api/gemini-models", { method: "POST" });
      await loadState();
      toast(`使えるモデル${result.models.length}件。自動選択: ${result.selected.name}`);
    });
  });
  $("#threadsAuthBtn").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    if (!(await saveSettings(button))) return;
    await busy(button, "準備中", async () => {
      const result = await api("/api/threads-auth-url");
      window.open(result.url, "_blank", "noopener,noreferrer");
      toast("別タブでThreadsの認可画面を開きました。許可したら、この画面で「再読み込み」を押してください。", "info", 10000);
      const help = $("#threadsSetupHelp");
      if (help) help.open = true;
    });
  });
  $("#refreshThreadsTokenBtn").addEventListener("click", (e) => busy(e.currentTarget, "更新中", async () => {
    const result = await api("/api/refresh-threads-token", { method: "POST" });
    await loadState();
    toast(`トークンを更新しました。有効期限: ${fmtDate(result.expiresAt) || "不明"}`);
  }));
  $("#threadsDisconnectBtn").addEventListener("click", (e) => {
    if (!confirm("Threads連携を解除します（保存済みのアクセストークンを消します）。よろしいですか。")) return;
    busy(e.currentTarget, "解除中", async () => {
      await api("/api/threads-disconnect", { method: "POST" });
      await loadState();
      toast("連携を解除しました。");
    });
  });
}

// 設定の該当欄を画面の中ほどへ送り、少しのあいだ枠で目立たせる
function focusField(id) {
  const input = document.getElementById(id);
  if (!input) return;
  const target = input.closest("label") || input;
  target.scrollIntoView({ block: "center" });
  target.classList.remove("flash");
  void target.offsetWidth; // 続けて押しても毎回光らせる
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 2400);
  input.focus({ preventScroll: true });
}

// スマホ幅のナビ: 右に続きがあるあいだだけ右端を薄くする。選んでいる項目は見える位置へ寄せる
function updateNavEdge() {
  const nav = $(".nav");
  nav.classList.toggle("more-right", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4);
  nav.classList.toggle("more-left", nav.scrollLeft > 4);
}
$(".nav").addEventListener("scroll", updateNavEdge, { passive: true });
window.addEventListener("resize", updateNavEdge);
$$(".nav-item").forEach((item) => item.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 760px)").matches) item.scrollIntoView({ inline: "nearest", block: "nearest" });
  updateNavEdge();
}));
updateNavEdge();

$("#dateInput").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
bindEvents();
loadState().catch((error) => toast(`読み込みに失敗しました: ${error.message}`, "error", 15000));
// 定期更新。設定タブを開いている間はフォームの値を触らない（入力中の上書きを防ぐ）
setInterval(() => {
  if (document.hidden) return;
  const el = document.activeElement;
  if (el && ["TEXTAREA", "INPUT", "SELECT"].includes(el.tagName)) return; // 入力中は再描画しない
  loadState({ keepSettingsForm: settingsDirty }).catch(() => {});
}, 60_000);
