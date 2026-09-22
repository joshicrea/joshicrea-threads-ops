// 起動用（起動.cmd / 自動起動 / プラグインから呼ばれる）: サーバーを起動し、ブラウザで画面を開く。
// 実行環境: Windows / macOS / Linux（ブラウザ起動コマンドだけOSで分岐）
// 同じフォルダに threads-ops.env（KEY=VALUE・1行1件）があれば、未設定の環境変数だけそこから補う。
// プラグイン配布ではデータの置き場所（THREADS_DATA_DIR）をここで渡す。
import { exec } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "threads-ops.env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

const { startServer, appendErrorLog } = await import("./server.js");
const port = Number(process.env.PORT || 4173);
const url = `http://localhost:${port}`;

async function alreadyRunningHere() {
  try {
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000) });
    // 401 はアクセスキー付きで動いているこのツール。200 は鍵なしで動いているこのツール
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

function openBrowser() {
  if (process.env.THREADS_NO_BROWSER) return; // 自動起動（タスクスケジューラ）から呼ばれたときはブラウザを開かない
  const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(opener);
}

try {
  await startServer(port);
} catch (error) {
  if (error.code === "EADDRINUSE") {
    if (await alreadyRunningHere()) {
      console.log(`Threads運用アシスタントは既に起動しています（自動起動、または別の黒い画面）。`);
      console.log(`ブラウザで ${url} を開いてください。止めるときは 停止.cmd。`);
      openBrowser();
    } else {
      console.log(`ポート${port}を別のプログラムが使っています。そのプログラムを終了するか、環境変数 PORT で別の番号を指定してください。`);
      await appendErrorLog(error);
    }
  } else {
    console.error("起動に失敗しました:", error.message);
    await appendErrorLog(error);
    console.error("詳細は data/server-error.log に記録しました。");
  }
  process.exitCode = 1;
} finally {
  if (!process.exitCode) {
    console.log("Threads運用アシスタントを起動しました。");
    console.log(`画面: ${url}`);
    console.log("この黒い画面を閉じるとサーバーが止まります。閉じずに置いておいてください。");
    openBrowser();
  }
}
