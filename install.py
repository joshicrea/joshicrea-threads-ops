#!/usr/bin/env python3
# Threads運用アシスタント プラグイン インストールスクリプト（Mac / Linux用）
# 使い方: Claude Code のチャットに以下をそのままコピペしてください
#
#   以下のURLからThreads運用アシスタントのインストールスクリプトを取得して、
#   内容を確認してから実行してください:
#   https://raw.githubusercontent.com/joshicrea/joshicrea-threads-ops/master/install.py
#
# やること: プラグインを ~/.claude/plugins/cache に置き、本体を ~/.claude/threads-ops/app に配置、
#           Node.js を確認し、ログイン時の自動起動（macOS は launchd、Linux は systemd --user）を登録し、本体を起動して疎通を確かめる。
# 検証用: 引数 --local-source <フォルダ> で GitHub からではなく手元のフォルダから入れる。
import sys, os, json, urllib.request, zipfile, shutil, tempfile, pathlib, datetime, subprocess, time, platform, signal

sys.stdout.reconfigure(encoding="utf-8")

print()
print("Threads運用アシスタントをインストールしています...")
print()

REPO = "joshicrea/joshicrea-threads-ops"
KEY = "joshicrea-threads-ops@joshicrea"
HOME_DIR = pathlib.Path.home()
CLAUDE_DIR = HOME_DIR / ".claude"
PLUGINS_DIR = CLAUDE_DIR / "plugins"
CACHE_DIR = PLUGINS_DIR / "cache" / "joshicrea" / "joshicrea-threads-ops"
BASE_DIR = CLAUDE_DIR / "threads-ops"
APP_DIR = BASE_DIR / "app"
DATA_DIR = BASE_DIR / "data"
for d in (CACHE_DIR, APP_DIR, DATA_DIR):
    d.mkdir(parents=True, exist_ok=True)
DATA_DIR.chmod(0o700)

local_source = None
if "--local-source" in sys.argv:
    local_source = pathlib.Path(sys.argv[sys.argv.index("--local-source") + 1]).expanduser().resolve()
    if not (local_source / "server.js").exists():
        print(f"--local-source に server.js がありません: {local_source}")
        sys.exit(1)

EXCLUDE = {"data", ".git", "node_modules", "test", "Meta審査申請"}

# --- 1. プラグイン本体を取得 ---
if local_source:
    short_sha = "local-" + datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    full_sha = short_sha
    install_path = CACHE_DIR / short_sha
    install_path.mkdir(parents=True, exist_ok=True)
    for item in local_source.iterdir():
        if item.name in EXCLUDE:
            continue
        dst = install_path / item.name
        if item.is_dir():
            shutil.copytree(item, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dst)
    print(f"手元のフォルダから配置しました ({short_sha})")
else:
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/commits/master", headers={"User-Agent": "joshicrea-install"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            full_sha = json.loads(resp.read().decode("utf-8"))["sha"]
        short_sha = full_sha[:12]
    except Exception as e:
        print(f"GitHubへの接続に失敗しました: {e}")
        print("インターネット接続を確認してください。")
        sys.exit(1)
    install_path = CACHE_DIR / short_sha
    if install_path.exists():
        print(f"すでに最新版がインストールされています ({short_sha})")
    else:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="joshicrea-threads-ops-"))
        zip_path = tmp / "repo.zip"
        try:
            urllib.request.urlretrieve(f"https://github.com/{REPO}/archive/refs/heads/master.zip", zip_path)
        except Exception as e:
            print(f"ダウンロードに失敗しました: {e}")
            sys.exit(1)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(tmp)
        extracted = next(p for p in tmp.iterdir() if p.is_dir())
        shutil.move(str(extracted), str(install_path))
        shutil.rmtree(tmp, ignore_errors=True)
        for junk in EXCLUDE:
            shutil.rmtree(install_path / junk, ignore_errors=True)
        print(f"ダウンロード完了 ({short_sha})")

# zip 展開では実行ビットが落ちるので、フックに付け直す（付いていないと SessionStart が Permission denied で死ぬ）
for rel in ("hooks/run-hook.cmd", "hooks/session-start"):
    p = install_path / rel
    if p.exists():
        p.chmod(0o755)

# 古いキャッシュは最新2世代だけ残す
versions = sorted([p for p in CACHE_DIR.iterdir() if p.is_dir()], key=lambda p: p.stat().st_mtime, reverse=True)
for old in versions[2:]:
    shutil.rmtree(old, ignore_errors=True)

# --- 2. installed_plugins.json ---
INSTALLED_JSON = PLUGINS_DIR / "installed_plugins.json"
installed = {"version": 2, "plugins": {}}
if INSTALLED_JSON.exists():
    try:
        installed = json.loads(INSTALLED_JSON.read_text(encoding="utf-8"))
    except Exception:
        pass
now = datetime.datetime.now().astimezone().isoformat()
installed.setdefault("plugins", {})[KEY] = [{
    "scope": "user", "installPath": str(install_path), "version": short_sha,
    "installedAt": now, "lastUpdated": now, "gitCommitSha": full_sha
}]
INSTALLED_JSON.write_text(json.dumps(installed, indent=2, ensure_ascii=False), encoding="utf-8")

# --- 3. settings.json の enabledPlugins ---
SETTINGS_JSON = CLAUDE_DIR / "settings.json"
settings = {}
if SETTINGS_JSON.exists():
    try:
        settings = json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))
    except Exception:
        settings = {}
settings.setdefault("enabledPlugins", {})[KEY] = True
SETTINGS_JSON.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
print("プラグインを登録しました")

# --- 4. Node.js ---
def node_major():
    try:
        out = subprocess.run(["node", "-v"], capture_output=True, text=True, timeout=10).stdout.strip()
        return int(out.lstrip("v").split(".")[0])
    except Exception:
        return 0

if node_major() < 20:
    if platform.system() == "Darwin" and shutil.which("brew"):
        print("Node.js を入れています（Homebrew）。数分かかります...")
        subprocess.run(["brew", "install", "node"], check=False)
    if node_major() < 20:
        print("Node.js 20 以上が必要です。https://nodejs.org から LTS 版を入れてから、もう一度実行してください。")
        sys.exit(1)
print(f"Node.js: v{node_major()}")
node_path = shutil.which("node")
# プラグインの MCP は PATH に頼らず node のフルパスで起動する（GUI から起動した Claude Code は PATH が狭い）
mcp_json = install_path / ".mcp.json"
if node_path and mcp_json.exists():
    try:
        mcp = json.loads(mcp_json.read_text(encoding="utf-8"))
        mcp["mcpServers"]["threads-ops"]["command"] = node_path
        mcp_json.write_text(json.dumps(mcp, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except Exception as e:
        print(f"注意: .mcp.json の書き換えに失敗しました。PATH の node で起動します: {e}")

# --- 5. 本体を安定した場所へ配置。データは別フォルダ ---
for name in ["server.js", "start.js", "package.json", "public", "README.md", "relay", "uninstall.py", "アンインストール.md"]:
    src = install_path / name
    if not src.exists():
        continue
    dst = APP_DIR / name
    if dst.is_dir():
        shutil.rmtree(dst)
    elif dst.exists():
        dst.unlink()
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)
(APP_DIR / "threads-ops.env").write_text(f"# Threads運用アシスタントの起動設定。install.py が作成。ブラウザ抑止は launchd/systemd 側で渡す（起動.command では開きたい）\nTHREADS_DATA_DIR={DATA_DIR}\n", encoding="utf-8")
start_sh = APP_DIR / "起動.command"
start_sh.write_text(f'#!/bin/bash\ncd "{APP_DIR}"\nTHREADS_NO_BROWSER= "{node_path}" start.js\n', encoding="utf-8")
start_sh.chmod(0o755)
stop_sh = APP_DIR / "停止.command"
stop_sh.write_text(f'#!/bin/bash\nif [ -f "{DATA_DIR}/server.pid" ]; then kill "$(cat "{DATA_DIR}/server.pid")" && echo "止めました"; else echo "起動していません"; fi\n', encoding="utf-8")
stop_sh.chmod(0o755)
uninst_sh = APP_DIR / "アンインストール.command"
uninst_sh.write_text(f'#!/bin/bash\n"{sys.executable}" "{APP_DIR}/uninstall.py"\n', encoding="utf-8")
uninst_sh.chmod(0o755)
print(f"本体を配置しました: {APP_DIR}")

# 更新のとき: 旧版のプロセスが残っていると server.js を差し替えても新版にならない
pid_file = DATA_DIR / "server.pid"
if pid_file.exists():
    try:
        os.kill(int(pid_file.read_text().strip()), signal.SIGTERM)
        time.sleep(2)
        print("動いていた旧版を止めました")
    except Exception:
        pass
    pid_file.unlink(missing_ok=True)

# --- 6. ログイン時の自動起動 ---
log_path = DATA_DIR / "autostart.log"
if platform.system() == "Darwin":
    plist_dir = HOME_DIR / "Library" / "LaunchAgents"
    plist_dir.mkdir(parents=True, exist_ok=True)
    plist = plist_dir / "com.joshicrea.threads-ops.plist"
    plist.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.joshicrea.threads-ops</string>
  <key>ProgramArguments</key><array><string>{node_path}</string><string>{APP_DIR}/start.js</string></array>
  <key>WorkingDirectory</key><string>{APP_DIR}</string>
  <key>EnvironmentVariables</key><dict><key>THREADS_NO_BROWSER</key><string>1</string><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:{HOME_DIR}/.local/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>{log_path}</string>
  <key>StandardErrorPath</key><string>{log_path}</string>
</dict></plist>
""", encoding="utf-8")
    subprocess.run(["launchctl", "unload", str(plist)], capture_output=True)
    subprocess.run(["launchctl", "load", str(plist)], capture_output=True)
    print("自動起動を登録しました（launchd）")
else:
    unit_dir = HOME_DIR / ".config" / "systemd" / "user"
    unit_dir.mkdir(parents=True, exist_ok=True)
    (unit_dir / "threads-ops.service").write_text(f"""[Unit]
Description=Threads Ops Assistant
After=network-online.target

[Service]
WorkingDirectory={APP_DIR}
Environment=THREADS_NO_BROWSER=1
ExecStart={node_path} {APP_DIR}/start.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
""", encoding="utf-8")
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    subprocess.run(["systemctl", "--user", "enable", "threads-ops"], capture_output=True)
    subprocess.run(["systemctl", "--user", "restart", "threads-ops"], capture_output=True)
    print("自動起動を登録しました（systemd --user）")

# --- 7. 検証: 必須ファイルと本体の疎通 ---
ok = True
for f in [install_path / ".claude-plugin" / "plugin.json", install_path / ".mcp.json", install_path / "mcp" / "server.mjs", install_path / "hooks" / "session-start", APP_DIR / "server.js", APP_DIR / "threads-ops.env"]:
    if not f.exists():
        print(f"エラー: {f} が作成されませんでした")
        ok = False

def server_up():
    try:
        req = urllib.request.Request("http://127.0.0.1:4173/api/state", headers={"x-threads-ops": "1"})
        with urllib.request.urlopen(req, timeout=2):
            return True
    except urllib.error.HTTPError as e:
        return e.code == 401
    except Exception:
        return False

up = False
for _ in range(15):
    if server_up():
        up = True
        break
    time.sleep(1)
if not up:
    print(f"本体が起動しませんでした。{log_path} と {DATA_DIR}/server-error.log を確認してください。")
    ok = False
if not ok:
    print()
    print("インストールに問題が発生しました。もう一度試してください。")
    sys.exit(1)

print()
print("インストール完了！")
print()
print("次の手順:")
print("  1. Claude Code を完全に閉じる（Node.js を今回入れた場合は、Claude Code を動かしているターミナルやエディタごと閉じる）")
print("  2. Claude Code を再度開く")
print("  3. チャットに「はじめまして」と送るとセットアップが始まります")
print("  画面: http://localhost:4173")
print()
