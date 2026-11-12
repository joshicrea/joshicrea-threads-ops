// ライセンス照合（段階A・local 型）。契約: AI組織/自走組織/ライセンス台帳API_契約.md 版0.5 の 4-1。
// 起動時と24時間ごとに check.php を呼び、結果を保存する。最後の成功から7日は、応答なし・5xx・通信失敗でも使い続ける。
// 401/403 の確定した拒否は猶予なしで実行系を止める（閲覧・書き出しは止めない）。許可キーが空なら実行系を止める（既に使っている人は空と分かってから14日の猶予・提供元自身の口座は exempt で免除）。
import { createHash, randomBytes, verify as cryptoVerify } from "node:crypto";
export const LICENSE_SERVICE_ID = "threads-assistant";
export const LICENSE_RECHECK_OK_MS = 24 * 60 * 60 * 1000;
export const LICENSE_RECHECK_RETRY_MS = 15 * 60 * 1000;
export const LICENSE_DEFAULT_GRACE_DAYS = 7;
// 許可キーが空でも止めない猶予(既に使っている人だけ・キーが空と初めて分かった時から数える)。
// COO決定。日数は暫定で、林さんの確定でこの値を変えて公開する(2026-11-08: 許可キー空で止める変更が、キーを受け取る手段が無いまま既存利用者に届いた)
export const LICENSE_NO_KEY_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15_000;
export const LICENSE_DEFAULT_URL = "https://lunettes.co.jp/lic";

// 照合先を決める。空なら提供元の既定。既定のURL以外（利用者が書き換えた先・パスだけ変えたもの）は使わない。
// 検証用に限り、環境変数 THREADS_LICENSE_ALLOW_LOOPBACK=1 のときだけ、このPC自身の http を許す
export function resolveLicenseUrl(raw, { allowLoopback = false } = {}) {
  const text = String(raw || "").trim().replace(/\/+$/, "");
  if (!text || text === LICENSE_DEFAULT_URL) return { ok: true, url: LICENSE_DEFAULT_URL };
  let u;
  try { u = new URL(text); } catch { return { ok: false, url: "" }; }
  if (u.username || u.password || u.search || u.hash) return { ok: false, url: "" };
  if (allowLoopback && u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname.toLowerCase())) return { ok: true, url: text };
  return { ok: false, url: "" }; // 提供元の既定以外（ホストが同じでもパスが違うものを含む）は使わない
}

// 照合結果の保存形。state は db.license にそのまま入る
export function emptyLicenseState() {
  return { installId: "", firstAttemptAt: "", lastAttemptAt: "", lastSuccessAt: "", result: "", reason: "", message: "", expiresOn: "", graceDays: LICENSE_DEFAULT_GRACE_DAYS, capabilities: [], blockedSince: "", detail: "", signed: null, noKeyGraceFrom: "" };
}

// 署名つきの応答（契約 版0.7・署名は版2）。署名する文字列は台帳側 lic_sign_check と同じ:
// v2|service_id|effective|expires_on|checked_at|grace_days|機能名(辞書順)|sha256(許可キー)の先頭16桁|X-Install-Id|nonce
function signedShapeOk(p) {
  return Boolean(p) && typeof p === "object"
    && ["service_id", "effective", "checked_at", "nonce", "sig"].every((k) => typeof p[k] === "string" && p[k])
    && (p.expires_on === null || typeof p.expires_on === "string")
    && Number.isInteger(p.grace_days) && p.grace_days >= 0 // 台帳は (int) で署名する。小数は署名文字列では切り捨てになり、書き換えが通ってしまう
    && /^[A-Za-z0-9_-]{16,64}$/.test(p.nonce)
    && [p.service_id, p.effective, p.checked_at].every((v) => !v.includes("|")) && Number.isFinite(Date.parse(p.checked_at))
    && (p.expires_on === null || !p.expires_on.includes("|"))
    && Array.isArray(p.capabilities) && p.capabilities.every((c) => typeof c === "string" && /^[a-z0-9_]+$/.test(c)); // 区切りの , | を含む書き換えを通さない
}
export function licenseSignString(p, { licenseKey, installId }) {
  const caps = [...p.capabilities].sort();
  return ["v2", p.service_id, p.effective, p.expires_on === null ? "" : p.expires_on, p.checked_at, String(Math.trunc(p.grace_days)), caps.join(","),
    createHash("sha256").update(String(licenseKey || "").trim()).digest("hex").slice(0, 16), installId, p.nonce].join("|");
}
export function verifyLicenseSignature(signed, { licenseKey, installId, publicKeyPem, serviceId = LICENSE_SERVICE_ID }) {
  if (!publicKeyPem || !installId || !signedShapeOk(signed) || signed.service_id !== serviceId) return false;
  try {
    return cryptoVerify("sha256", Buffer.from(licenseSignString(signed, { licenseKey, installId })), publicKeyPem, Buffer.from(signed.sig, "base64"));
  } catch { return false; }
}
function graceDaysOf(signed) {
  const g = Number(signed.grace_days);
  return Number.isFinite(g) && g >= 0 && g <= 30 ? g : LICENSE_DEFAULT_GRACE_DAYS;
}

export function licenseConfigured(settings) {
  return Boolean(String(settings?.licenseKey || "").trim());
}

// 照合するべきか（定期・失敗後の再試行）
export function licenseCheckDue(settings, state, nowMs) {
  if (!licenseConfigured(settings)) return false;
  const last = Date.parse(state?.lastAttemptAt || "") || 0;
  if (!last) return true;
  const every = state.result === "ok" ? LICENSE_RECHECK_OK_MS : LICENSE_RECHECK_RETRY_MS;
  if (last > nowMs) return true; // PCの時計が戻った・狂った。照合し直す
  return nowMs - last >= every;
}

// 今、実行系（公開・返信送信・自動削除・自動再投稿）を動かしてよいか。
// status: off(提供元自身で免除) / no_key(許可キー空) / misconfigured(照合先が無い) / active / grace(照合できていないが猶予内) / denied(確定した拒否) / unverified(一度も確認できず猶予も過ぎた) / expired_grace(最後の成功から猶予を超えた)
// 許可キーが空のときは停止する。提供元自身のアカウントだけ、起動時の環境変数（exempt）で免除する
export function licenseDecision(settings, state, nowMs, { serverUrl = "", exempt = false, publicKeyPem = "", serviceId = LICENSE_SERVICE_ID } = {}) {
  if (!licenseConfigured(settings)) {
    if (exempt) return { enforced: false, allowed: true, status: "off", message: "" };
    // noKeyGraceFrom: 既存利用者と判定した時刻(ISO)。"-" は対象外(新しく入れた人)。空はまだ判定していない(止める側に倒す)
    const from = Date.parse(state?.noKeyGraceFrom || "");
    const graceMs = LICENSE_NO_KEY_GRACE_DAYS * DAY_MS;
    if (Number.isFinite(from) && from <= nowMs && nowMs - from <= graceMs) {
      const daysLeft = Math.max(0, Math.ceil((from + graceMs - nowMs) / DAY_MS));
      return { enforced: true, allowed: true, status: "no_key_grace", daysLeft, message: `許可キーがまだ入っていません。あと${daysLeft}日は今までどおり使えます。提供元から届いた許可キーを設定に入れてください。` };
    }
    // 猶予が切れた後なら、停止の始まりは切れた時刻(スリープ明けに気づいても、その間に過ぎた予約を保留できる)
    const blockedFrom = Number.isFinite(from) && from <= nowMs ? from + graceMs : undefined;
    return { enforced: true, allowed: false, status: "no_key", reason: "no_license_key", ...(blockedFrom ? { blockedFrom } : {}), message: "許可キーが入っていません。設定に、提供元から届いた許可キーを入れてください。" };
  }
  if (!serverUrl) return { enforced: true, allowed: false, status: "misconfigured", reason: "bad_server_url", message: "ライセンスの確認先が正しくありません。提供元に連絡してください。" };
  // 猶予の長さ・最後の成功の時刻は、署名が通る控え（state.signed）だけを根拠にする。書き換えた控えは使わない（猶予日数を延ばしても通らない）
  const signed = verifyLicenseSignature(state?.signed, { licenseKey: settings.licenseKey, installId: state?.installId, publicKeyPem, serviceId }) ? state.signed : null;
  const graceMs = (signed ? graceDaysOf(signed) : LICENSE_DEFAULT_GRACE_DAYS) * DAY_MS;
  if (state?.result === "denied") {
    return { enforced: true, allowed: false, status: "denied", reason: state.reason || "denied", message: state.message || "利用が停止されています。担当者にご連絡ください" };
  }
  const lastSuccess = signed ? Math.min(Date.parse(signed.checked_at) || 0, nowMs) : 0; // 台帳の時刻（署名つき）を正とする。未来の時刻で猶予を延ばさせない
  if (state?.result === "ok" && lastSuccess && nowMs - lastSuccess <= graceMs) return { enforced: true, allowed: true, status: "active", message: "" };
  // 一度も確認できていない猶予は、最初に試した時刻から数える。その時刻が空・不正なのに試行の記録がある控えは、猶予をやり直させず未確認として止める
  const first = Date.parse(state?.firstAttemptAt || "");
  const attempted = Boolean(state?.lastAttemptAt);
  const base = lastSuccess || (Number.isFinite(first) ? Math.min(first, nowMs) : attempted ? 0 : nowMs);
  if (nowMs - base <= graceMs) {
    const daysLeft = Math.max(0, Math.ceil((base + graceMs - nowMs) / DAY_MS));
    return { enforced: true, allowed: true, status: "grace", daysLeft, message: `ライセンスの照合ができていません。あと${daysLeft}日は今までどおり使えます。通信の状態を確かめてください。` };
  }
  return {
    enforced: true, allowed: false,
    status: lastSuccess ? "expired_grace" : "unverified",
    reason: "license_unverified",
    blockedFrom: base + graceMs, // 猶予が切れた時刻（スリープ明けに気づいても、停止の始まりはここ）
    message: `ライセンスの確認が${Math.round(graceMs / DAY_MS)}日以上できていないため、投稿・返信の自動実行を止めています。通信の状態を確かめるか、提供元に連絡してください。過去のデータの閲覧と書き出しはできます。`
  };
}

function safeMessage(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= 200 ? text : "";
}

// check.php を1回呼ぶ。戻り値は state に混ぜる差分。通信失敗・5xx・429・応答の形の誤りは result:"unreachable"（猶予の対象）
export async function runLicenseCheck({ settings, serverUrl, installId, version, fetchImpl = fetch, nowIso, serviceId = LICENSE_SERVICE_ID, allowLoopback = false, publicKeyPem = "" }) {
  const resolved = resolveLicenseUrl(serverUrl, { allowLoopback });
  if (!resolved.ok) return { result: "unreachable", reason: "https_required", message: "", detail: "照合先が提供元のものではありません" };
  const base = resolved.url;
  const headers = { "content-type": "application/json", "x-license-key": String(settings.licenseKey || "").trim(), "x-install-id": installId };
  const nonce = randomBytes(16).toString("hex"); // 毎回新しく作る。古い応答の再送を通さない
  let response;
  try {
    response = await fetchImpl(`${base}/check.php`, {
      method: "POST",
      redirect: "error", // 転送先へ許可キーを送らない
      headers,
      body: JSON.stringify({ service_id: serviceId, version: String(version || ""), nonce }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
  } catch (error) {
    return { result: "unreachable", reason: "network_error", message: "", detail: String(error?.cause?.code || error?.name || "error") };
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  const status = response.status;
  if (status === 200 && data?.ok === true) {
    // 署名を確かめる（版0.7）。署名が無い・nonce が違う・版が違う・検証が通らない応答は成功にしない（猶予の中で理由だけ残す）
    if (!publicKeyPem) return { result: "unreachable", reason: "no_public_key", message: "", detail: "署名の公開鍵が入っていません" };
    const signed = { service_id: data.service_id, effective: data.effective, expires_on: data.expires_on ?? null, checked_at: data.checked_at, grace_days: data.grace_days, capabilities: data.capabilities, nonce: data.nonce, sig: data.sig };
    const sigOk = data.sig_ver === "v2" && data.sig_alg === "rsa-sha256" && data.nonce === nonce
      && verifyLicenseSignature(signed, { licenseKey: settings.licenseKey, installId, publicKeyPem, serviceId });
    if (!sigOk) return { result: "unreachable", reason: "bad_signature", message: "", detail: data.sig ? "署名が一致しません" : "署名がありません" };
    return {
      result: "ok", reason: "", message: "", detail: "", lastSuccessAt: nowIso, signed,
      expiresOn: signed.expires_on || "",
      graceDays: graceDaysOf(signed),
      capabilities: signed.capabilities.slice(0, 50)
    };
  }
  // 確定した拒否: 401（unknown_key）と 403（suspended / expired / service_mismatch / version_too_old / device_limit_exceeded）。
  // 拒否の応答には署名が付かない。HTTP が 401/403 なら、本文の形や署名の有無によらず即時の停止として扱う（猶予に回さない）
  if (status === 401 || status === 403) {
    const reason = String(data?.reason || "denied").replace(/[^a-z_]/g, "").slice(0, 40) || "denied";
    return { result: "denied", reason, message: safeMessage(data?.message), detail: "", expiresOn: typeof data?.expires_on === "string" ? data.expires_on : "" };
  }
  // 400（こちらの呼び方の誤り）・429・5xx・形の違う応答は、止める根拠にしない。猶予の中で理由だけ残す
  return { result: "unreachable", reason: status === 429 ? "rate_limited" : status >= 500 ? "service_unavailable" : "bad_response", message: "", detail: `HTTP ${status}` };
}
