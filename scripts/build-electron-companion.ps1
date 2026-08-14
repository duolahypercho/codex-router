[CmdletBinding()]
param()

# The companion without a Rust toolchain. build-desktop-tray.ps1 compiles the
# Tauri app and needs cargo; this one installs a runtime npm already knows how
# to fetch, so the only prerequisites are the ones the router install itself
# required.

$ErrorActionPreference = "Stop"
$Repository = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Repository "apps\electron"

foreach ($CommandName in @("node", "npm")) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "$CommandName is required to build the desktop companion."
  }
}

& npm ci --prefix $App
if ($LASTEXITCODE -ne 0) { throw "Companion npm dependency installation failed." }

$Binary = Join-Path $App "node_modules\electron\dist\electron.exe"

# npm 11 refuses install scripts unless they are approved, and electron
# downloads its runtime from one. The install then exits 0 having fetched the
# package but not the binary it exists to deliver, and the failure only appears
# much later as an app that will not start. Run the download directly rather
# than asking every user to approve scripts.
if (-not (Test-Path $Binary)) {
  Write-Output "npm did not run electron's install script; fetching the runtime directly."
  Push-Location (Join-Path $App "node_modules\electron")
  try {
    & node install.js
    if ($LASTEXITCODE -ne 0) { throw "Electron runtime download failed." }
  } finally {
    Pop-Location
  }
}

# Never report success on a missing binary: that is the whole failure this
# script exists to make impossible.
if (-not (Test-Path $Binary)) {
  throw "The Electron runtime is still missing at $Binary; the companion cannot start."
}

& npm run check --prefix $App
if ($LASTEXITCODE -ne 0) { throw "Companion checks failed." }

Write-Output $Binary
