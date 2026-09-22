#!/usr/bin/env python3
# Threads運用アシスタント: アンインストール（Mac / Linux）。自動起動の解除 → 本体停止 → プラグイン登録の削除 → フォルダ削除
# 使い方: アンインストール.command をダブルクリック、または python3 uninstall.py [--force]
import sys, os, json, pathlib, shutil, subprocess, signal, platform, time

sys.stdout.reconfigure(encoding="utf-8")
HOME = pathlib.Path.home()
CLAUDE_DIR = HOME / ".claude"
BASE_DIR = CLAUDE_DIR / "threads-ops"
DATA_DIR = BASE_DIR / "data"
CACHE_DIR = CLAUDE_DIR / "plugins" / "cache" / "joshicrea" / "joshicrea-threads-ops"
KEY = "joshicrea-threads-ops@joshicrea"

print()
print("Threads運用アシスタントをアンインストールします。")
print(f"データ（投稿・コメント・Threads のトークン・アクセスキー）も消えます: {DATA_DIR}")
print("残したいものがあれば、この画面を閉じて data フォルダをコピーしてから実行してください。")
if "--force" not in sys.argv:
    if input("続けますか？ (y/N) ").strip().lower() != "y":
        print("やめました。何も変えていません。")
        sys.exit(0)

# 1. 自動起動の解除
if platform.system() == "Darwin":
    plist = HOME / "Library" / "LaunchAgents" / "com.joshicrea.threads-ops.plist"
    subprocess.run(["launchctl", "unload", str(plist)], capture_output=True)
    if plist.exists():
        plist.unlink()
else:
    subprocess.run(["systemctl", "--user", "disable", "--now", "threads-ops"], capture_output=True)
    unit = HOME / ".config" / "systemd" / "user" / "threads-ops.service"
    if unit.exists():
        unit.unlink()
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
print("自動起動を解除しました")

# 2. 本体の停止
pid_file = DATA_DIR / "server.pid"
if pid_file.exists():
    try:
        os.kill(int(pid_file.read_text().strip()), signal.SIGTERM)
        time.sleep(1)
        print("本体を止めました")
    except Exception:
        pass
    pid_file.unlink(missing_ok=True)

# 3. プラグイン登録の削除
for f in (CLAUDE_DIR / "plugins" / "installed_plugins.json", CLAUDE_DIR / "settings.json"):
    if not f.exists():
        continue
    try:
        j = json.loads(f.read_text(encoding="utf-8"))
        changed = False
        for sec in ("plugins", "enabledPlugins"):
            if isinstance(j.get(sec), dict) and KEY in j[sec]:
                del j[sec][KEY]
                changed = True
        if changed:
            f.write_text(json.dumps(j, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"登録を外しました: {f}")
    except Exception as e:
        print(f"登録の削除に失敗しました（{f}）: {e}")
shutil.rmtree(CACHE_DIR, ignore_errors=True)

# 4. フォルダ削除
shutil.rmtree(BASE_DIR, ignore_errors=True)
print(f"フォルダを消しました: {BASE_DIR}")
print()
print("アンインストールが終わりました。Claude Code を閉じて開き直してください。")
print("Threads 側の連携を切るときは、Threads アプリの 設定 → アカウント → ウェブサイトのアクセス許可 から解除してください。")
