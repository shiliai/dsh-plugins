# dsh-bootstrap launcher - Windows (PowerShell 5.1+ / pwsh).
#
# Usage:
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\setup.ps1
#
# Or fetch a fresh copy:
#   iex (New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/shiliai/dsh-plugins/main/scripts/dsh-bootstrap/setup.ps1')
#
# Requirements: git and Node.js (>=22).
$ErrorActionPreference = 'Stop'

$Repo = 'https://github.com/shiliai/dsh-plugins.git'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (Test-Path (Join-Path $Here 'bootstrap.mjs')) {
  $BootDir = $Here
} else {
  $Cache = Join-Path $env:LOCALAPPDATA 'dsh-bootstrap'
  if (-not (Test-Path (Join-Path $Cache '.git'))) {
    if (Test-Path $Cache) { Remove-Item -Recurse -Force $Cache }
    git clone --depth 1 --filter=blob:none --sparse $Repo $Cache *> $null
  } else {
    git -C $Cache fetch --depth 1 origin main *> $null
    git -C $Cache reset --hard FETCH_HEAD *> $null
  }
  git -C $Cache sparse-checkout set scripts/dsh-bootstrap *> $null
  $BootDir = Join-Path $Cache 'scripts\dsh-bootstrap'
}

npm install --prefix $BootDir --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false *> $null
& node (Join-Path $BootDir 'bootstrap.mjs') @args
exit $LASTEXITCODE
