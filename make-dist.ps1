# Threads Ops Assistant: build a distributable ZIP next to this folder.
# Excludes data/ (keys and tokens), test/, Meta審査申請/ (owner-only review kit), .git and logs.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content (Join-Path $dir "package.json") -Raw | ConvertFrom-Json).version
$stamp = Get-Date -Format "yyyyMMdd"
$out = Join-Path (Split-Path -Parent $dir) ("Threads運用アシスタント_v" + $version + "_" + $stamp + ".zip")
$staging = Join-Path $env:TEMP ("threads-ops-dist-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
$exclude = @("data", "test", "Meta審査申請", ".git", "node_modules", "make-dist.ps1", "配布用ZIPを作る.cmd")
Get-ChildItem -Path $dir -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination (Join-Path $staging $_.Name) -Recurse -Force
}
# 念のため、秘密が入りうるファイルが混ざっていないか検査する
$leak = Get-ChildItem -Path $staging -Recurse -File | Where-Object { $_.Name -match "^db\.json|\.pem$|\.pid$|\.log$|^\.credentials|^auth\.json$" }
if ($leak) {
  Write-Output "秘密が入りうるファイルが含まれています。ZIP を作りません:"
  $leak | ForEach-Object { Write-Output ("  " + $_.FullName.Substring($staging.Length + 1)) }
  Remove-Item -Path $staging -Recurse -Force
  exit 1
}
if (Test-Path $out) { Remove-Item $out -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $out, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)
Remove-Item -Path $staging -Recurse -Force
Write-Output ("作成しました: " + $out)
