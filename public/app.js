// Threads運用アシスタント フロント
// 実行環境: ブラウザ（モダンブラウザ想定・ビルド不要）
// サーバーが状態遷移を強制するため、ここでの判定は「ボタンを出すかどうか」だけ。

const state = {
  settings: {},
  posts: [],
  replies: [],
  insights: [],
  research: [],
  references: [],
  referenceAnalysis: null,
  suggestions: [],
  logs: [],
  stats: null,
  editingId: null,
  queueFilter: "all",
  replyFilter: "open"
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
  render({ keepSettingsForm });
}

function showView(name, options = {}) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === name));
  $("#viewTitle").textContent = VIEW_TITLES[name] || name;
  if (options.filter && name === "queue") state.queueFilter = options.filter;
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
  research: () => { renderReferences(); renderResearch(); },
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
  $("#publishDot").classList.toggle("on", on);
  const review = countStatus("review");
  $("#navReviewCount").textContent = review ? review : "";
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

  const todos = [];
  const provider = state.settings.aiProvider || "gemini";
  if (provider === "gemini" && !state.settings.geminiApiKey) todos.push({ text: "Gemini APIキーを設定する（または AIプロバイダを Claude Code に切り替える）", goto: "settings" });
  if (provider === "claude-api" && !state.settings.anthropicApiKey) todos.push({ text: "Claude APIキーを設定する", goto: "settings" });
  if ((provider === "claude-code" || provider === "codex") && state.settings.lastAiCheckProvider !== provider) todos.push({ text: `${provider === "codex" ? "Codex" : "Claude Code"} が使える状態か、設定の「接続テスト」で1回確認する`, goto: "settings" });
  if (!state.settings.threadsAccessToken) todos.push({ text: "Threadsと連携する（投稿・コメント取得・インサイトに必要）", goto: "settings" });
  if (threadsTokenExpired()) todos.push({ text: "Threadsの連携が期限切れです。設定で「Threadsと連携する」をもう一度押す", goto: "settings" });
  if (heldReplies().length) todos.push({ text: `人の確認が必要なコメント（要確認）が${heldReplies().length}件あります`, goto: "replies", filter: "held" });
  if (autoReplyPaused()) todos.push({ text: `自動返信が一時停止中です（${new Date(state.settings.autoReplyPausedUntil).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} に再開）。Threads の返信回数の上限に触れました`, goto: "replies" });
  if (countStatus("review")) todos.push({ text: `承認待ちの投稿が${countStatus("review")}件あります。内容を確認して承認する`, goto: "queue", filter: "review" });
  if (countStatus("approved")) todos.push({ text: `承認済みで未予約の投稿が${countStatus("approved")}件あります。予約するか、すぐ投稿する`, goto: "queue", filter: "approved" });
  if (countStatus("scheduled") && !state.settings.autoPublishEnabled) todos.push({ text: "予約済みの投稿がありますが自動送信がOFFです。設定でONにするか、手動で投稿する", goto: "settings" });
  if (countStatus("error")) todos.push({ text: `エラーになった投稿が${countStatus("error")}件あります。原因を確認して承認し直す`, goto: "queue", filter: "error" });
  if (openReplies().length) todos.push({ text: `未返信のコメントが${openReplies().length}件あります`, goto: "replies" });
  if (!state.posts.length) todos.push({ text: "リサーチで参考投稿を集め、投稿生成で最初の投稿案を作る", goto: "research" });
  const published = countStatus("published");
  if (published >= 3 && !state.suggestions.length) todos.push({ text: "公開済み投稿が溜まってきました。インサイトを取得して改善提案を出す", goto: "analysis" });
  $("#todoList").innerHTML = todos.length
    ? todos.map((t) => `<button class="todo-item" data-goto="${t.goto}" ${t.filter ? `data-filter="${t.filter}"` : ""}>${escapeHtml(t.text)}</button>`).join("")
    : `<p class="notice">今すぐやることはありません。</p>`;

  $("#connectionStatus").innerHTML = [
    aiConnLine(),
    connLine("Threads", Boolean(state.settings.threadsAccessToken) && !threadsTokenExpired(), threadsTokenNote()),
    connLine("自動送信", Boolean(state.settings.autoPublishEnabled), state.settings.autoPublishEnabled ? "予約済みを時刻に送信（サーバー起動中のみ）" : "OFF（手動で投稿）"),
    connLine("自動返信", Boolean(state.settings.autoReplyEnabled) && !autoReplyPaused(), !state.settings.autoReplyEnabled ? "OFF（下書きまで・送信は手動）" : autoReplyPaused() ? `一時停止中（${new Date(state.settings.autoReplyPausedUntil).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} に再開・Threads の返信上限に触れたため）` : `コメントをAIが判定して返信（${state.settings.autoReplyIntervalSec || 20}秒間隔・1日${state.settings.autoReplyDailyCap || 500}件まで・要確認は残す）`)
  ].join("");

  const next = state.posts
    .filter((post) => ["approved", "scheduled"].includes(post.status))
    .sort((a, b) => (a.scheduledAt || "9").localeCompare(b.scheduledAt || "9"))
    .slice(0, 5);
  $("#nextPosts").innerHTML = next.length
    ? next.map((post) => `<div class="mini-card"><div class="post-meta">${statusPill(post.status)} ${escapeHtml(post.category)} / ${post.scheduledAt ? fmtDate(post.scheduledAt) : "日時未設定"}</div><div class="clamp">${nl2br(post.text)}</div></div>`).join("")
    : `<p class="notice">承認済み・予約済みの投稿はありません。</p>`;

  $("#logs").innerHTML = state.logs.slice(0, 8).map((log) => `
    <div class="log-item ${log.level === "error" ? "error" : ""}">
      <div class="post-meta">${fmtDate(log.at)}</div>
      <div>${escapeHtml(log.message)}</div>
      ${log.level === "error" && log.meta?.error ? `<details class="log-detail"><summary>${escapeHtml(log.meta.error.slice(0, 90))}${log.meta.error.length > 90 ? "..." : ""}</summary>${escapeHtml(log.meta.error)}${log.meta.detail ? `<br>${escapeHtml(log.meta.detail)}` : ""}</details>` : ""}
    </div>
  `).join("") || `<p class="notice">ログはまだありません。</p>`;
}

function aiConnLine() {
  const s = state.settings;
  const provider = s.aiProvider || "gemini";
  const checked = s.lastAiCheckProvider === provider && s.lastAiCheckAt;
  const checkedNote = checked ? `接続テスト済み（${new Date(s.lastAiCheckAt).toLocaleString("ja-JP")}）` : "未確認（設定の「接続テスト」で確認）";
  if (provider === "claude-code") return connLine("AI: Claude Code", Boolean(checked), `このPCの Claude Code（モデル: ${s.claudeModel || "sonnet"}）・${checkedNote}`);
  if (provider === "claude-api") return connLine("AI: Claude API", Boolean(s.anthropicApiKey), s.anthropicApiKey ? `モデル: ${s.anthropicModel || ""}` : "APIキー未設定");
  if (provider === "codex") return connLine("AI: Codex", Boolean(checked), `このPCの Codex CLI（ChatGPT の契約）${s.codexModel ? `（モデル: ${s.codexModel}）` : ""}・${checkedNote}`);
  return connLine("AI: Gemini", Boolean(s.geminiApiKey), s.geminiApiKey ? `モデル: ${s.geminiModel || "自動"}` : "APIキー未設定");
}

function connLine(name, ok, note) {
  return `<div class="conn-line"><span class="status-dot ${ok ? "on" : ""}"></span><strong>${name}</strong><span class="post-meta">${escapeHtml(note)}</span></div>`;
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
  $("#refList").innerHTML = refs.length ? refs.map((ref) => `
    <article class="ref-card ${ref.selected ? "selected" : ""}">
      <label class="ref-head">
        <input type="checkbox" data-ref-toggle="${ref.id}" ${ref.selected ? "checked" : ""} />
        <span class="post-meta">${ref.username ? `@${escapeHtml(ref.username)}` : "手動追加"}${ref.keyword ? ` / 「${escapeHtml(ref.keyword)}」` : ""}${ref.timestamp ? ` / ${fmtDate(ref.timestamp)}` : ""}${ref.metrics ? ` / いいね ${Number(ref.metrics.likes) || 0} / 返信 ${Number(ref.metrics.replies) || 0}` : ""}</span>
        <span class="spacer"></span>
        ${safeHref(ref.permalink) ? `<a class="link" href="${safeHref(ref.permalink)}" target="_blank" rel="noreferrer">元投稿</a>` : ""}
        <button class="small-button ghost" data-ref-delete="${ref.id}" type="button">削除</button>
      </label>
      <div class="ref-text">${nl2br(ref.text)}</div>
      ${ref.analysis ? `
        <div class="ref-analysis">
          <div><b>フック</b> ${escapeHtml(ref.analysis.hook)}</div>
          <div><b>構造</b> ${escapeHtml(ref.analysis.structure)}</div>
          <div><b>効いている理由</b> ${escapeHtml(ref.analysis.whyItWorks)}</div>
          <div><b>自分ならこう置き換える</b> ${escapeHtml(ref.analysis.howToAdapt)}</div>
        </div>` : ""}
    </article>
  `).join("") : `<p class="notice">まだ候補がありません。上のキーワード検索か、手動貼り付けで追加してください。</p>`;
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
function renderGenerateInputs() {
  const refs = (state.references || []).filter((r) => r.selected).length;
  const srcs = (state.research || []).flatMap((i) => i.sources || []).filter((s) => s.selected).length;
  const analyzed = Boolean(state.referenceAnalysis?.commonPatterns);
  const top = (state.stats?.top || []).length;
  $("#generateInputs").innerHTML = `
    <div class="input-chip ${refs ? "on" : ""}">参考投稿 ${refs}件${analyzed ? "（型を分析済み）" : ""}</div>
    <div class="input-chip ${srcs ? "on" : ""}">Web参照元 ${srcs}件</div>
    <div class="input-chip ${top ? "on" : ""}">過去の反応上位 ${top}件</div>
    <div class="input-chip ${state.settings.profile ? "on" : ""}">プロフィール${state.settings.profile ? "あり" : "未設定"}</div>
    <div class="input-chip on">予約時刻 ${(state.settings.scheduleTimes || []).length}枠/日</div>
  `;
}

// ---------------------------------------------------------------------------
// 投稿キュー
// ---------------------------------------------------------------------------
function postActions(post) {
  const b = (action, label, cls = "") => `<button class="small-button ${cls}" data-action="${action}" data-id="${post.id}" type="button">${label}</button>`;
  switch (post.status) {
    case "review":
      return [b("edit", "編集"), b("approve", "承認", "primary"), b("reject", "却下", "ghost")];
    case "approved":
      return [b("edit", "編集"), b("schedule", "予約する", "primary"), b("publish", "今すぐ投稿", "danger"), b("reject", "却下", "ghost")];
    case "scheduled":
      return [b("edit", "編集"), b("unschedule", "予約を解除"), b("publish", "今すぐ投稿", "danger")];
    case "published":
      return [safeHref(post.permalink) ? `<a class="small-button link-button" href="${safeHref(post.permalink)}" target="_blank" rel="noreferrer">Threadsで見る</a>` : ""];
    case "error":
      return [b("edit", "編集"), b("approve", "承認し直す", "primary"), b("reject", "却下", "ghost")];
    case "rejected":
      return [b("restore", "承認待ちに戻す"), b("delete", "削除", "ghost")];
    default:
      return [];
  }
}

function renderQueue() {
  $$("#queueFilters .chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.status === state.queueFilter));
  const order = { review: 0, approved: 1, scheduled: 2, error: 3, published: 4, rejected: 5 };
  const posts = state.posts
    .filter((post) => state.queueFilter === "all" || post.status === state.queueFilter)
    .slice()
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (a.scheduledAt || "9").localeCompare(b.scheduledAt || "9"));
  $("#bulkApproveBtn").disabled = !countStatus("review");
  $("#postList").innerHTML = posts.length ? posts.map((post) => `
    <article class="post-row s-${post.status}">
      <div class="post-row-head">
        ${statusPill(post.status)}
        <span class="post-meta">${escapeHtml(post.category || CATEGORY_LABEL_FALLBACK)}${post.format !== "TEXT" ? ` / ${post.format}` : ""}</span>
        <span class="post-meta">${post.status === "published" ? `公開 ${fmtDate(post.publishedAt)}` : post.scheduledAt ? `予定 ${fmtDate(post.scheduledAt)}` : "日時未設定"}</span>
        <span class="spacer"></span>
        <div class="row-actions">${postActions(post).join("")}</div>
      </div>
      <div class="post-text">${nl2br(post.text)}</div>
      ${post.error ? `<div class="error-box">${escapeHtml(post.error)}</div>` : ""}
    </article>
  `).join("") : `<p class="notice">${state.queueFilter === "all" ? "投稿はまだありません。「投稿生成」で作るか、「手動で追加」してください。" : "この状態の投稿はありません。"}</p>`;
}

function openEditor(post = {}) {
  state.editingId = post.id || null;
  $("#dialogTitle").textContent = post.id ? "投稿を編集" : "投稿を手動で追加";
  $("#editNotice").textContent = ["approved", "scheduled"].includes(post.status) ? "本文・形式・メディアURLを変更すると承認待ちに戻ります。" : post.id ? "" : "追加した投稿は承認待ちに入ります。";
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
  const past = post.scheduledAt && Date.parse(post.scheduledAt) < Date.now() - 60_000;
  if (action === "schedule" && (!post.scheduledAt || past)) {
    scheduledAt = await askScheduleDatetime(nextScheduleSlot(), past ? "割り当て済みの予約時刻が過ぎているので、日時を選び直してください。" : "");
    if (!scheduledAt) return;
  }
  await busy(button, "処理中", async () => {
    await api(`/api/posts/${encodeURIComponent(id)}/transition`, { method: "POST", body: { action, scheduledAt } });
    await loadState();
    toast({ approve: "承認しました。", schedule: "予約しました。", unschedule: "予約を解除しました。", reject: "却下しました。", restore: "承認待ちに戻しました。" }[action] || "更新しました。");
  });
}

// 設定の予約時刻（HH:MM・日本時間）から、今より後の直近の枠を返す（ローカル時刻で計算）
function nextScheduleSlot() {
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
        ${safeHref(reply.permalink) ? `<a class="link" href="${safeHref(reply.permalink)}" target="_blank" rel="noreferrer">Threadsで見る</a>` : ""}
      </div>
      <div class="quote">元投稿: ${escapeHtml(postText(reply).slice(0, 90))}${postText(reply).length > 90 ? "..." : ""}</div>
      <div class="reply-text">${nl2br(reply.text)}</div>
      ${reply.status === "responded"
        ? `<div class="responded">返信済み（${fmtDate(reply.respondedAt)}）: ${nl2br(reply.responseText)}</div>`
        : reply.status === "ignored"
          ? `<div class="row-actions"><button class="small-button ghost" data-reply-action="reopen" data-id="${reply.id}" type="button">未対応に戻す</button></div>`
          : `
          ${reply.status === "held" ? `<div class="notice inline">要確認: ${escapeHtml(reply.holdReason || "")}。内容を見て、返信するなら文を直して「この内容で返信する」、しないなら「対応しない」</div>` : ""}
          <textarea class="reply-input" data-reply-input="${reply.id}" rows="3" placeholder="返信文（「AIで下書き」を押すか、直接入力）">${escapeHtml(reply.responseText || "")}</textarea>
          ${reply.error ? `<div class="error-box">${escapeHtml(reply.error)}</div>` : ""}
          <div class="row-actions">
            <button class="small-button" data-reply-action="draft" data-id="${reply.id}" type="button">AIで下書き</button>
            <button class="small-button primary" data-reply-action="send" data-id="${reply.id}" type="button">この内容で返信する</button>
            ${reply.status === "drafted" && reply.autoQueued && state.settings.autoReplyEnabled ? `<button class="small-button" data-reply-action="unqueue" data-id="${reply.id}" type="button">自動送信をやめる（下書きは残す）</button>` : ""}
            <button class="small-button ghost" data-reply-action="ignore" data-id="${reply.id}" type="button">対応しない</button>
          </div>`}
    </article>
  `).join("") : `<p class="notice">${filter === "open" ? "未対応のコメントはありません。「コメントを取得」で最新を取り込めます。" : "該当するコメントはありません。"}</p>`;
}

async function replyAction(action, id, button) {
  const input = $(`[data-reply-input="${id}"]`);
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
function renderAnalysis() {
  const stats = state.stats || { publishedWithInsights: 0, byCategory: {}, byTimeSlot: {}, top: [] };
  const latest = new Map();
  for (const item of state.insights) if (!latest.has(item.postId)) latest.set(item.postId, item);
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

  const rows = state.posts
    .filter((post) => post.status === "published" && latest.has(post.id))
    .map((post) => ({ post, m: latest.get(post.id).metrics || {} }))
    .sort((a, b) => (b.m.views || 0) - (a.m.views || 0));
  $("#postInsightTable").innerHTML = rows.length
    ? `<table><thead><tr><th>公開</th><th>カテゴリ</th><th>本文</th><th>閲覧</th><th>いいね</th><th>返信</th><th>再投稿</th></tr></thead><tbody>${rows.map(({ post, m }) => `<tr><td>${fmtDate(post.publishedAt)}</td><td>${escapeHtml(post.category)}</td><td class="cell-text">${escapeHtml(post.text.slice(0, 80))}${safeHref(post.permalink) ? ` <a class="link" href="${safeHref(post.permalink)}" target="_blank" rel="noreferrer">開く</a>` : ""}</td><td>${m.views || 0}</td><td>${m.likes || 0}</td><td>${m.replies || 0}</td><td>${m.reposts || 0}</td></tr>`).join("")}</tbody></table>`
    : `<p class="notice">データなし</p>`;

  $("#suggestionList").innerHTML = state.suggestions.length ? state.suggestions.map((s) => `
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
  `).join("") : `<p class="notice">改善提案はまだありません。インサイト付きの公開投稿が3件以上になると生成できます。</p>`;
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
  $("#researchProviderNote").textContent = (s.aiProvider || "gemini") === "claude-api" ? "Web参照元の検索は Claude API では使えません（Gemini または Claude Code に切り替えてください）。" : "";
  $("#threadsAppId").value = s.threadsAppId || "";
  $("#threadsAppSecret").value = s.threadsAppSecret || "";
  $("#threadsRedirectUri").value = s.threadsRedirectUri || "";
  $("#threadsScopes").value = s.threadsScopes || "";
  $("#threadsAccessToken").value = s.threadsAccessToken || "";
  $("#accessKey").value = s.accessKey || "";
  renderSettingsStatus();
  $("#brandName").value = s.brandName || "";
  $("#defaultCta").value = s.defaultCta || "";
  $("#profile").value = s.profile || "";
  $("#writingRules").value = s.writingRules || "";
  $("#scheduleTimes").value = (s.scheduleTimes || []).join(",");
  $("#autoPublishEnabled").checked = Boolean(s.autoPublishEnabled);
  $("#autoFetchRepliesEnabled").checked = s.autoFetchRepliesEnabled !== false;
  $("#autoFetchRepliesMinutes").value = s.autoFetchRepliesMinutes || 5;
  $("#autoReplyEnabled").checked = Boolean(s.autoReplyEnabled);
  $("#autoReplyIntervalSec").value = s.autoReplyIntervalSec || 20;
  $("#autoReplyDailyCap").value = s.autoReplyDailyCap || 500;
  $("#autoInsightsEnabled").checked = s.autoInsightsEnabled !== false;
}

// 設定タブのうち、入力欄ではない表示（接続状態・注記）だけを更新する。未保存編集があっても呼んでよい
function renderSettingsStatus() {
  const s = state.settings;
  $("#threadsConnection").innerHTML = connLine("Threads", Boolean(s.threadsAccessToken) && !threadsTokenExpired(), threadsTokenNote())
    + (s.threadsUsername || s.threadsUserId ? `<div class="post-meta">${s.threadsUsername ? `@${escapeHtml(s.threadsUsername)} / ` : ""}ユーザーID: ${escapeHtml(s.threadsUserId || "")}</div>` : "")
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
    threadsAppSecret: $("#threadsAppSecret").value,
    threadsRedirectUri: $("#threadsRedirectUri").value,
    threadsScopes: $("#threadsScopes").value,
    threadsAccessToken: $("#threadsAccessToken").value,
    accessKey: $("#accessKey").value,
    brandName: $("#brandName").value,
    defaultCta: $("#defaultCta").value,
    profile: $("#profile").value,
    writingRules: $("#writingRules").value,
    scheduleTimes: $("#scheduleTimes").value,
    autoPublishEnabled: $("#autoPublishEnabled").checked,
    autoFetchRepliesEnabled: $("#autoFetchRepliesEnabled").checked,
    autoFetchRepliesMinutes: $("#autoFetchRepliesMinutes").value,
    autoReplyEnabled: $("#autoReplyEnabled").checked,
    autoReplyIntervalSec: $("#autoReplyIntervalSec").value,
    autoReplyDailyCap: $("#autoReplyDailyCap").value,
    autoInsightsEnabled: $("#autoInsightsEnabled").checked
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
    if (goto) showView(goto.dataset.goto, { filter: goto.dataset.filter });
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
  $("#refSearchBtn").addEventListener("click", (e) => busy(e.currentTarget, "検索中", async () => {
    const keyword = $("#refKeyword").value.trim();
    if (!keyword) throw new Error("キーワードを入力してください。");
    const result = await api("/api/references/search", { method: "POST", body: { keyword, searchType: $("#refSearchType").value } });
    await loadState();
    toast(`${result.via === "web" ? "Web検索経由で" : "Threads APIで"}${result.found}件見つかり、${result.added}件を候補に追加しました。`);
  }));
  $("#draftBatchBtn").addEventListener("click", (e) => busy(e.currentTarget, "AIがまとめて判定中", async () => {
    const result = await api("/api/replies/draft-batch", { method: "POST" });
    await loadState();
    toast(`下書き${result.drafted}件・要確認${result.held}件（10件ずつ処理します。未対応が残っていればもう一度押してください）。`);
  }));
  $("#refManualAddBtn").addEventListener("click", (e) => busy(e.currentTarget, "追加中", async () => {
    await api("/api/references", { method: "POST", body: { text: $("#refManualText").value, username: $("#refManualUser").value.replace(/^@/, ""), permalink: $("#refManualUrl").value } });
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
    $("#generatedList").innerHTML = result.posts.map((post) => `<div class="mini-card"><div class="post-meta">${statusPill(post.status)} ${escapeHtml(post.category)} / ${fmtDate(post.scheduledAt)}</div><div>${nl2br(post.text)}</div></div>`).join("");
    toast(`${result.posts.length}件の投稿案を作りました。投稿キューで承認してください。`);
  }));

  // 投稿キュー
  $("#queueFilters").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.queueFilter = chip.dataset.status;
    renderQueue();
  });
  $("#addPostBtn").addEventListener("click", () => openEditor());
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
  $("#settings").addEventListener("input", (e) => {
    if (e.target.closest("#settingsForm, .form-grid")) { settingsDirty = true; $("#settingsDirtyNote").hidden = false; }
  });
  $("#toast").addEventListener("click", (e) => { if (e.target.closest(".toast-close")) $("#toast").hidden = true; });
  window.addEventListener("beforeunload", (e) => { if (settingsDirty) { e.preventDefault(); e.returnValue = ""; } });
  $("#aiCheckBtn").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    if (!(await saveSettings(button))) return;
    await busy(button, "テスト中（最大3分）", async () => {
      const result = await api("/api/ai-check", { method: "POST" });
      toast(`${{ gemini: "Gemini", "claude-code": "Claude Code", "claude-api": "Claude API", codex: "Codex" }[result.provider] || result.provider} に接続できました（${(result.ms / 1000).toFixed(1)}秒・応答「${result.greeting}」）。`, "ok", 6000, result.command ? `使ったコマンド: ${result.command}` : "");
      await load({ keepSettingsForm: true });
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
