// リサーチ: Threads の公開投稿をページの実データで確かめ、足切りして並べる。
// 実行環境: クロスプラットフォーム（Windows / macOS / Linux・Node.js 20以上）。
//
// なぜページを Chrome で開くか（2026-10-22 実測）:
//   - Threads API の keyword_search は審査前だと自分の投稿しか返さない
//   - curl ではページに本文も反応数も入っていない（like_count 0件）
//   - ヘッドレス Chrome で開くと、ページ内の <script type="application/json"> に投稿のデータ（全文・いいね・返信・再投稿・日時）が入る
//   - AI（WebFetch）にページを読ませると数字を創作する（2026-09-23 実測）。数字は必ずこのファイルの解析から取る
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, setPriority, constants as osConstants } from "node:os";
import { join } from "node:path";

export const THREADS_POST_URL = /^https?:\/\/(?:www\.)?threads\.(?:com|net)\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/;
// 1ページの上限。実測（2026-10-22・1本ずつ・画像なし）: 17〜108秒、本物のリサーチ1回で12ページ平均約22秒
export const PAGE_TIMEOUT_MS = 75_000;
// 1回のリサーチで開くページの上限。1テーマなら10、2〜3テーマならテーマごとに6（合計18まで）
export const MAX_VERIFY = 10;
export const MAX_VERIFY_MULTI = 6;
// ページとページの間を2秒あける（Threads への負荷を人の閲覧並みに抑える）
export const PAGE_GAP_MS = 2_000;
// 1本ずつ開く。実測（2026-10-22）: 3本同時では3件中2件が90秒で終わらなかった。1本ずつ・画像なしでは取れた
export const VERIFY_CONCURRENCY = 1;

// Chrome / Edge の場所。THREADS_CHROME_PATH があればそれを使う（試験では偽の .mjs を渡す）
export function findChrome(env = process.env, platform = process.platform) {
  if (env.THREADS_CHROME_PATH) return existsSync(env.THREADS_CHROME_PATH) ? env.THREADS_CHROME_PATH : null;
  const home = env.HOME || env.USERPROFILE || "";
  const candidates = platform === "win32"
    ? [
      join(env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
      join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
      join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
      join(env.PROGRAMFILES || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe")
    ]
    : platform === "darwin"
      ? ["/Applications", home ? join(home, "Applications") : ""].filter(Boolean).flatMap((dir) => [
        join(dir, "Google Chrome.app/Contents/MacOS/Google Chrome"),
        join(dir, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        join(dir, "Chromium.app/Contents/MacOS/Chromium")
      ])
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  return candidates.find((p) => p && existsSync(p)) || null;
}

// 子プロセスを、Chrome が起こした子ごと止める（Windows は taskkill /T。他は親を止めればレンダラーも終わる）
function killTree(child) {
  if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGKILL");
}

// 一時プロフィールを消す。Chrome が掴んでいる間は消せないので、少し待って3回まで試す
function removeProfile(dir, tries = 3) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    if (tries > 1) setTimeout(() => removeProfile(dir, tries - 1), 2_000).unref();
  }
}

// ページをヘッドレスで開いて、描画後の HTML を返す。利用者の Chrome のプロフィール（ログイン状態）は使わず、毎回空の一時プロフィールで開く
export function dumpDom(url, chromePath, timeoutMs = PAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const profile = mkdtempSync(join(tmpdir(), "threads-research-"));
    const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      "--blink-settings=imagesEnabled=false", "--mute-audio",
      // 投稿のデータは読み込み直後の埋め込みに入る。2秒待ちで取れることを実測（2026-10-22）。余裕を見て3秒
      `--user-data-dir=${profile}`, "--virtual-time-budget=3000", "--dump-dom", url];
    const script = /\.(m?js)$/i.test(chromePath);
    const child = spawn(script ? process.execPath : chromePath, script ? [chromePath, ...args] : args, { windowsHide: true, shell: false });
    // 優先度を下げる（同じPCの常駐サーバーの応答を邪魔しないように）。2026-10-22 実測: Chrome を開いている間、別の常駐サーバーの応答が
    // 13回中3回15秒を超えた（開いていないときは25回中0回）。下げられるのは起動した親だけで、Chrome が起こす子プロセスは
    // Chrome 自身が優先度を決める（実測: 子を含む114回の観測で 通常以下57・通常24・低24・通常以上9）。イベントループは止めない（最大0.75秒）
    try { if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 権限が無い環境では通常のまま */ }
    const out = [];
    let err = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(new Error(`ページの読み込みが${Math.round(timeoutMs / 1000)}秒で終わりませんでした`)));
    }, timeoutMs);
    child.stdout.on("data", (c) => out.push(c)); // Buffer のまま集めて最後に1回だけ文字にする（途中で日本語の字が割れて化けないように）
    child.stderr.on("data", (c) => { err = (err + c).slice(-2000); });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => {
      removeProfile(profile);
      const html = Buffer.concat(out).toString("utf8");
      finish(() => (html.length ? resolve(html) : reject(new Error(`ページを読めませんでした（終了コード ${code}）${err ? `: ${err.split("\n").slice(-3).join(" ").slice(0, 200)}` : ""}`))));
    });
  });
}

// ページの埋め込みデータから、投稿ID（URL末尾の code）に一致する投稿を1つ取り出す。無ければ null
// 原理的に取りこぼす型（取りこぼしは「未確認」に倒れ、嘘の数字にはならない）:
//   投稿データが JSON の文字列の中にさらに JSON として入っている形 / 読み込みの3秒後に通信で入る形 / /t/CODE など別形式の URL
export function extractThreadsPost(html, code) {
  const blocks = [...String(html).matchAll(/<script\b[^>]*\btype="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let hit = null;
  const walk = (o, depth) => {
    if (hit || !o || typeof o !== "object" || depth > 60) return;
    if (o.code === code && Object.prototype.hasOwnProperty.call(o, "like_count")) { hit = o; return; }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  for (const b of blocks) {
    if (!b.includes(code)) continue;
    try { walk(JSON.parse(b), 0); } catch { /* JSON でないブロックは飛ばす */ }
    if (hit) break;
  }
  if (!hit) return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const info = hit.text_post_app_info || {};
  const taken = num(hit.taken_at);
  return {
    text: String(hit.caption?.text || ""),
    username: String(hit.user?.username || ""),
    likes: num(hit.like_count),
    replies: num(info.direct_reply_count),
    reposts: num(info.repost_count),
    quotes: num(info.quote_count),
    timestamp: taken ? new Date(taken * 1000).toISOString() : ""
  };
}

// 文字のうち、ひらがな・カタカナ・漢字の割合（英数字・記号・空白・絵文字は数えない）。
// 漢字だけの文（中国語）を日本語と数えないよう、かなが文字の1割未満なら0とする（中国語に紛れる「の」1字では通らない）
export function japaneseRatio(text) {
  const s = String(text || "");
  const letters = s.match(/[\p{L}]/gu) || [];
  if (!letters.length) return 0;
  const kana = s.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
  if (kana.length < Math.max(2, letters.length * 0.1)) return 0;
  const ja = s.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) || [];
  return ja.length / letters.length;
}

// 反応の点数: 返信は「いいね」より強い信号として2倍に数える
export const reactionScore = (m) => (m && m.likes !== null && m.likes !== undefined ? m.likes + 2 * (m.replies || 0) : -1);

// 足切り。除外した理由ごとに数える。opts.now は試験用
export function filterCandidates(items, { minLikes = 0, maxAgeDays = 0, minJaRatio = 0.3, now = Date.now() } = {}) {
  const kept = [];
  const seen = new Set();
  const dropped = { duplicate: 0, notVerified: 0, notJapanese: 0, belowMinLikes: 0, tooOld: 0, empty: 0 };
  for (const it of items) {
    const key = it.threadsId || it.permalink;
    if (key && seen.has(key)) { dropped.duplicate += 1; continue; }
    if (key) seen.add(key);
    if (!it.text || it.text.trim().length < 10) { dropped.empty += 1; continue; }
    if (japaneseRatio(it.text) < minJaRatio) { dropped.notJapanese += 1; continue; }
    if (it.unverified) { dropped.notVerified += 1; continue; }
    if (maxAgeDays > 0 && it.timestamp && now - Date.parse(it.timestamp) > maxAgeDays * 86_400_000) { dropped.tooOld += 1; continue; }
    if (minLikes > 0 && (it.metrics?.likes ?? -1) < minLikes) { dropped.belowMinLikes += 1; continue; }
    kept.push(it);
  }
  kept.sort((a, b) => reactionScore(b.metrics) - reactionScore(a.metrics));
  return { kept, dropped };
}

// 候補（permalink つき）を Chrome で開いて実データに置き換える。確かめられなかったものは unverified のまま返す。
// 確かめたとみなす条件: 投稿IDが一致する投稿がページにあり、本文があり、いいね数が数として見え、URL の @ユーザー名 とページの投稿者が一致する
export async function verifyCandidates(candidates, { chromePath, fetchPage = dumpDom, max = MAX_VERIFY, gapMs = PAGE_GAP_MS, deadline = Infinity, shouldStop = () => false, onProgress = () => {} } = {}) {
  const list = candidates.slice(0, max);
  const items = [];
  let failures = 0;
  let stopped = "";
  for (const [i, c] of list.entries()) {
    if (!stopped && shouldStop()) stopped = "止めました";
    if (!stopped && Date.now() > deadline) stopped = "時間の上限に達したため、残りは確かめていません";
    let page = null;
    let reason = stopped;
    const m = THREADS_POST_URL.exec(c.permalink || "");
    if (!stopped) {
      if (!chromePath) reason = "Chrome（または Edge）が見つからないため、ページで確かめられませんでした";
      else if (!m) reason = "投稿のURLではありません";
      else {
        if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        try {
          page = extractThreadsPost(await fetchPage(c.permalink, chromePath), m[2]);
          if (!page) reason = "ページに投稿のデータが見つかりませんでした（削除・非公開・ページの形が変わった可能性）";
          else if (!page.text) reason = "本文が空の投稿です";
          else if (page.likes === null) reason = "いいね数が見えない投稿です";
          else if (page.username && page.username.toLowerCase() !== m[1].toLowerCase()) reason = `URL の投稿者（@${m[1]}）とページの投稿者（@${page.username}）が違います`;
        } catch (error) {
          reason = String(error.message || error).slice(0, 200);
        }
      }
    }
    if (page && !reason) {
      items.push({
        ...c, text: page.text.slice(0, 3000), username: page.username || c.username, timestamp: page.timestamp || c.timestamp,
        metrics: { likes: page.likes, replies: page.replies, reposts: page.reposts, quotes: page.quotes },
        unverified: false, unverifiedReason: "", verifiedAt: new Date().toISOString()
      });
    } else {
      failures += 1;
      items.push({ ...c, metrics: null, unverified: true, unverifiedReason: reason || "ページで確かめられませんでした" });
    }
    onProgress(i + 1, list.length);
  }
  return { items, failures, skipped: candidates.length - list.length, stopped };
}
