// Threads運用アシスタントの見張り役（利用者PCの中で5分ごとに1回だけ動く。常駐しない）。
// 実行環境: クロスプラットフォーム（Node.js 20以上）。macOS では launchd の別ジョブから呼ぶ（install.py が登録）。
// やること: ①利用者が「停止」で止めていないか見る ②本体の状態を見る ③待ち受けが無い／固まっているときだけ起こし直す ④健全なら定期処理を1回呼ぶ ⑤結果を件数だけログに残す。
// 起こす条件（生きている本体を殺さないため保守的にしてある）:
//   ・待ち受けが無い（接続拒否）: 前回から8分以内に2回続いたら、起こす（動いていれば何もしない起こし方）
//   ・待ち受けはあるのに30秒応答しない（時間切れ）: 前回から8分以内に3回続いたときだけ、殺して起こす
//   ・起こしたあと30分は起こさない（起こし直しの繰り返しを作らない）
//   ・利用者が「停止」で止めた印（data/watchdog.stopped）があれば、何もしない。本体が起動したら start.js が印を消す
// やらないこと: 認証情報・本文・エラー文をログや標準出力に出さない。503（錠・起動途中）では起こさない（二重起動を作らない）。
// 環境変数（無ければ同じフォルダの threads-ops.env の値）: THREADS_DATA_DIR（データの置き場・既定は ~/.claude/threads-ops/data）／PORT（既定 4173）。
//   WATCHDOG_RESTART_BIN（起こし直す実行ファイル。無ければ起こさず記録だけ）／WATCHDOG_RESTART_ARGS（待ち受け無しのときの引数の JSON 配列）／
//   WATCHDOG_RESTART_ARGS_HUNG（固まっているときの引数の JSON 配列。無ければ ARGS と同じ）。引数の "{uid}" は実行時のユーザー番号に置き換える。シェルは通さない。
//   WATCHDOG_STATE_TIMEOUT_MS（既定 30000）／WATCHDOG_TICK_TIMEOUT_MS（既定 600000）／WATCHDOG_NOW_MS（試験用の時計）
import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
function fromEnvFile(name) {
  try {
    for (const line of readFileSync(join(here, "threads-ops.env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#") && m[1] === name) return m[2].replace(/^"(.*)"$/, "$1");
    }
  } catch { /* 設定ファイルが無ければ既定値 */ }
  return "";
}

const DATA_DIR = process.env.THREADS_DATA_DIR || fromEnvFile("THREADS_DATA_DIR") || join(homedir(), ".claude", "threads-ops", "data");
const PORT = Number(process.env.PORT || fromEnvFile("PORT")) || 4173;
const RESTART_BIN = process.env.WATCHDOG_RESTART_BIN || "";
const parseArgs = (v) => { try { return JSON.parse(v || "[]").map(String); } catch { return []; } };
const ARGS_REFUSED = parseArgs(process.env.WATCHDOG_RESTART_ARGS);
const ARGS_HUNG = process.env.WATCHDOG_RESTART_ARGS_HUNG ? parseArgs(process.env.WATCHDOG_RESTART_ARGS_HUNG) : ARGS_REFUSED;
const STATE_TIMEOUT = Number(process.env.WATCHDOG_STATE_TIMEOUT_MS) || 30_000;
const TICK_TIMEOUT = Number(process.env.WATCHDOG_TICK_TIMEOUT_MS) || 600_000;
const WINDOW_MS = 8 * 60_000; // 「続けて」と数える間隔の上限（5分間隔＋余裕）。これを超えたら数え直す
const COOLDOWN_MS = 30 * 60_000;
const LIMIT = { refused: 2, hung: 3 };
const LOG_FILE = join(DATA_DIR, "watchdog.log");
const STATE_FILE = join(DATA_DIR, "watchdog-state.json");
const STOP_FILE = join(DATA_DIR, "watchdog.stopped");
const nowMs = () => Number(process.env.WATCHDOG_NOW_MS) || Date.now();
const KNOWN_REASONS = new Set(["実行中", "lock-lost", "starting"]);

function readAccessKey() {
  try {
    const db = JSON.parse(readFileSync(join(DATA_DIR, "db.json"), "utf8"));
    return String(db?.settings?.accessKey || "");
  } catch {
    return "";
  }
}

function request(method, path, key, timeoutMs) {
  return new Promise((resolve) => {
    const headers = { "x-threads-ops": "1", origin: `http://localhost:${PORT}` };
    if (key) headers["x-threads-key"] = key;
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    // 待ち受けが無い(接続拒否)と、待ち受けはあるのに応答しない(固まり・遅い)は別物。後者だけは殺して起こす対象になりうる
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, kind: "hung", body: "" }); });
    // 接続拒否・時間切れ以外の失敗(接続直後に切られる等)は「error」。起こし直しの対象にはしない(記録と運営への上げだけ)
    req.on("error", (e) => resolve({ status: 0, kind: e && e.code === "ECONNREFUSED" ? "refused" : "error", body: "" }));
    req.end();
  });
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) || {}; } catch { return {}; }
}
function writeState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s), "utf8"); } catch { /* 状態が書けなくても見張り自体は続ける */ }
}

// 1行1回分。件数と種類だけ（本文・トークン・エラー文は入れない）。切り詰めは行の境界で行う
function log(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > 200_000) {
        const tail = readFileSync(LOG_FILE, "utf8").slice(-100_000);
        writeFileSync(LOG_FILE, tail.slice(tail.indexOf("\n") + 1), "utf8");
      }
    } catch { /* ログがまだ無い */ }
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date(nowMs()).toISOString(), ...entry }) + "\n", "utf8");
  } catch { /* ログが書けなくても見張りは止めない */ }
}

function summarizeTick(res) {
  let b = {};
  try { b = JSON.parse(res.body); } catch { /* 本文が JSON でない */ }
  const s = b?.scheduler || {};
  const d = b?.dailyDrafts || {};
  const r = typeof b?.reason === "string" ? b.reason : typeof s.reason === "string" ? s.reason : "";
  return {
    status: res.status,
    ran: Boolean(s.ran),
    published: Number(s.published) || 0,
    failed: Number(s.failed) || 0,
    blocked: Array.isArray(s.blocked) ? s.blocked.length : 0,
    draftsCreated: Number(d.created) || 0,
    ...(r ? { reason: KNOWN_REASONS.has(r) ? r : "other" } : {}),
  };
}

async function main() {
  // 利用者が「停止」で止めた本体は、起こさない・tick も呼ばない
  if (existsSync(STOP_FILE)) { log({ state: "stopped" }); return; }

  const key = readAccessKey();
  const state = await request("GET", "/api/state", key, STATE_TIMEOUT);
  const now = nowMs();
  const prev = readState();

  if (state.status === 0) {
    const kind = state.kind === "refused" ? "refused" : state.kind === "error" ? "error" : "hung";
    // 時計が戻った(差が負)ときは数え直す。続けて数えるのは 0〜8分以内だけ
    const gap = now - prev.lastAt;
    const count = prev.kind === kind && Number.isFinite(prev.lastAt) && gap >= 0 && gap <= WINDOW_MS ? (Number(prev.count) || 0) + 1 : 1;
    let restarted = false;
    let cooldown = false;
    let lastRestartAt = prev.lastRestartAt;
    if (LIMIT[kind] && count >= LIMIT[kind] && RESTART_BIN) {
      // 休みの判定は 0〜30分だけ。未来の時刻が残っていても(時計が戻った場合)休みを延ばさない
      if (Number.isFinite(lastRestartAt) && now - lastRestartAt >= 0 && now - lastRestartAt < COOLDOWN_MS) {
        cooldown = true;
      } else {
        const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
        const args = (kind === "hung" ? ARGS_HUNG : ARGS_REFUSED).map((a) => a.replaceAll("{uid}", uid));
        execFile(RESTART_BIN, args, { timeout: 60_000, windowsHide: true }, () => {});
        lastRestartAt = now;
        restarted = true;
      }
    }
    writeState({ kind, count, lastAt: now, lastRestartAt });
    log({ state: "down", kind, count, restarted, cooldown });
    process.exitCode = count >= 3 ? 1 : 0; // 3回続けて応答なし = 運営へ上げる条件（140 の6）
    if (restarted) await new Promise((r) => setTimeout(r, 1500)); // 起こし直しを始めたコマンドが終わる前に抜けない
    return;
  }

  writeState({ kind: null, count: 0, lastAt: now, lastRestartAt: prev.lastRestartAt });
  if (state.status === 401) {
    log({ state: "auth" }); // 動いているが合言葉が合わない。止まっているとは扱わず、tick は呼ばない
    return;
  }
  if (state.status !== 200) {
    log({ state: "other", status: state.status });
    return;
  }
  const tick = await request("POST", "/api/tick", key, TICK_TIMEOUT);
  log({ state: "up", tick: summarizeTick(tick) });
}

main().catch(() => { log({ state: "watchdog-error" }); process.exitCode = 1; });
