[CmdletBinding()]
param(
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  )
)

$ErrorActionPreference = "Stop"
$routerRoot = [IO.Path]::GetFullPath($InstallDir)
if (-not (Test-Path (Join-Path $routerRoot "src\service.mjs"))) {
  throw "Installed Codex Router not found at $routerRoot."
}
Push-Location $routerRoot
try {
  Write-Host "Gracefully restarting Codex Router..."
  & node (Join-Path $routerRoot "src\service.mjs") restart
  $RestartExitCode = $LASTEXITCODE
  if ($RestartExitCode -ne 0) {
    throw "Codex Router restart failed with exit code $RestartExitCode."
  }
} finally {
  Pop-Location
}

Write-Host "Codex Router is running."
