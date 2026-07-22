[CmdletBinding()]
param(
  [switch]$BinaryOnly
)

$ErrorActionPreference = "Stop"
$Repository = Split-Path -Parent $PSScriptRoot
$Desktop = Join-Path $Repository "apps\desktop"

foreach ($CommandName in @("node", "npm", "cargo")) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "$CommandName is required to build the desktop tray app."
  }
}

& npm ci --prefix $Desktop
if ($LASTEXITCODE -ne 0) { throw "Desktop npm dependency installation failed." }

& npm run check --prefix $Desktop
if ($LASTEXITCODE -ne 0) { throw "Desktop checks failed." }

if ($BinaryOnly) {
  & npm run build:binary --prefix $Desktop
} else {
  & npm run build --prefix $Desktop
}
if ($LASTEXITCODE -ne 0) { throw "Desktop build failed." }

Write-Output (Join-Path $Desktop "src-tauri\target\release\codex-router-desktop.exe")
