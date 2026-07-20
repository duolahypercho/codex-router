[CmdletBinding()]
param(
  [switch]$CheckoutInstall,
  [switch]$PrepareOnly,
  [ValidateSet("codex", "claude")]
  [string]$Target = "codex",
  [switch]$Guided,
  [switch]$Auto,
  [string]$Providers,
  [switch]$MigrateKnown,
  [switch]$SmokeTest,
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  )
)

$ErrorActionPreference = "Stop"
$env:MODEL_ROUTER_TARGET = $Target
if ($Target -eq "claude" -and $MigrateKnown) {
  throw "-MigrateKnown applies only to the Codex target."
}
$PreviousRevision = $null
$RepositoryUrl = if ($env:CODEX_ROUTER_REPOSITORY_URL) {
  $env:CODEX_ROUTER_REPOSITORY_URL
} else {
  "https://github.com/duolahypercho/codex-router.git"
}

function Assert-Command([string]$Name, [string]$Help) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Help"
  }
}

function Test-RouterCheckout([string]$Directory) {
  $Package = Join-Path $Directory "package.json"
  if (-not (Test-Path $Package)) { return $false }
  try {
    return (Get-Content $Package -Raw | ConvertFrom-Json).name -eq "codex-model-router"
  } catch {
    return $false
  }
}

$ScriptDirectory = $PSScriptRoot
if (-not $ScriptDirectory) { $ScriptDirectory = (Get-Location).Path }

if (-not $CheckoutInstall) {
  Assert-Command "git" "Install Git for Windows from https://git-scm.com/download/win."
  Assert-Command "node" "Install Node.js 24 LTS from https://nodejs.org/."

  if (Test-RouterCheckout $ScriptDirectory) {
    $Repository = $ScriptDirectory
  } else {
    if (Test-Path (Join-Path $InstallDir ".git")) {
      if (-not (Test-RouterCheckout $InstallDir)) {
        throw "$InstallDir is not a Codex Router checkout."
      }
      $Origin = (& git -C $InstallDir remote get-url origin).Trim()
      $AllowedOrigins = @(
        $RepositoryUrl,
        "https://github.com/duolahypercho/codex-router",
        "https://github.com/duolahypercho/codex-router.git",
        "git@github.com:duolahypercho/codex-router.git"
      ) | Where-Object { $_ }
      if ($Origin -notin $AllowedOrigins) {
        throw "$InstallDir has an unrecognized origin and will not be updated: $Origin"
      }
      $Dirty = (& git -C $InstallDir status --porcelain)
      if ($LASTEXITCODE -ne 0 -or $Dirty) {
        throw "$InstallDir has local changes; automatic update will not overwrite them."
      }
      $Branch = (& git -C $InstallDir branch --show-current).Trim()
      if ($Branch -ne "main") { throw "$InstallDir must be on its main branch to update." }
      $PreviousRevision = (& git -C $InstallDir rev-parse HEAD).Trim()
      & git -C $InstallDir update-ref refs/codex-router/rollback $PreviousRevision
      & git -C $InstallDir pull --ff-only origin main
      if ($LASTEXITCODE -ne 0) { throw "Unable to fast-forward the managed checkout." }
    } elseif (Test-Path $InstallDir) {
      throw "$InstallDir exists and is not a Codex Router checkout."
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
      & git clone --depth 1 $RepositoryUrl $InstallDir
      if ($LASTEXITCODE -ne 0) { throw "Unable to clone Codex Router." }
    }
    $Repository = $InstallDir
  }

  if ($PrepareOnly) {
    & (Join-Path $Repository "install.ps1") -CheckoutInstall -PrepareOnly -Target $Target
    exit $LASTEXITCODE
  }

  $SetupScript = if ($Target -eq "claude") { "src\claude-setup.mjs" } else { "src\setup.mjs" }
  $SetupArguments = @((Join-Path $Repository $SetupScript))
  $UseGuided = $Guided -or (-not $Auto -and [Environment]::UserInteractive)
  if ($UseGuided) { $SetupArguments += "--guided" }
  if ($Providers) { $SetupArguments += @("--providers", $Providers) }
  if ($MigrateKnown) { $SetupArguments += "--migrate-known" }
  if ($SmokeTest) { $SetupArguments += "--smoke-test" }
  & node @SetupArguments
  $SetupExitCode = $LASTEXITCODE
  if ($SetupExitCode -ne 0 -and $PreviousRevision) {
    & git -C $Repository switch --detach $PreviousRevision 2>$null | Out-Null
    Write-Warning "Setup failed; the managed source checkout was restored to $PreviousRevision."
  }
  exit $SetupExitCode
}

if (-not (Test-RouterCheckout $ScriptDirectory)) {
  throw "-CheckoutInstall must be run from a Codex Router checkout."
}

Assert-Command "node" "Install Node.js 24 LTS from https://nodejs.org/."
Assert-Command "npm" "npm is included with Node.js."
$VersionParts = (node -p "process.versions.node").Split(".")
if ([int]$VersionParts[0] -lt 22 -or
    ([int]$VersionParts[0] -eq 22 -and [int]$VersionParts[1] -lt 19)) {
  throw "Node.js 22.19 or newer is required; Node.js 24 LTS is recommended."
}

Push-Location $ScriptDirectory
try {
  if ($Target -eq "codex") {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
    & node src/legacy-migration.mjs assert-clear | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Resolve the detected older router before installing." }
  }
  if (-not $PrepareOnly) {
    & node src/provider-selection.mjs ensure-configured | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Configure at least one provider before installing." }
  }

  & npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed." }

  $Python = Join-Path $ScriptDirectory ".venv\Scripts\python.exe"
  if (Get-Command "uv" -ErrorAction SilentlyContinue) {
    if (-not (Test-Path $Python)) {
      & uv venv --python 3.12 .venv
      if ($LASTEXITCODE -ne 0) { throw "uv could not create the Python environment." }
    }
    & uv pip install --python $Python "litellm[proxy]==1.93.0"
  } else {
    if (Get-Command "py" -ErrorAction SilentlyContinue) {
      & py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
      if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
      if (-not (Test-Path $Python)) { & py -3 -m venv .venv }
    } elseif (Get-Command "python" -ErrorAction SilentlyContinue) {
      & python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
      if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
      if (-not (Test-Path $Python)) { & python -m venv .venv }
    } else {
      throw "Python 3.10+ or uv is required. Install uv from https://docs.astral.sh/uv/."
    }
    if (-not (Test-Path $Python)) { throw "The Python virtual environment was not created." }
    & $Python -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }
    & $Python -m pip install "litellm[proxy]==1.93.0"
  }
  if ($LASTEXITCODE -ne 0) { throw "LiteLLM installation failed." }

  & node src/secret.mjs ensure
  if ($LASTEXITCODE -ne 0) { throw "Local router-key setup failed." }
  if ($Target -eq "codex") {
    $StateRoot = if ($env:MODEL_ROUTER_STATE_DIR) { $env:MODEL_ROUTER_STATE_DIR }
      elseif ($env:CODEX_ROUTER_STATE_DIR) { $env:CODEX_ROUTER_STATE_DIR }
      elseif ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME "codex-router" }
      else { Join-Path $HOME ".codex\codex-router" }
    if (Test-Path (Join-Path $StateRoot "native-models.json")) {
      & node src/catalog.mjs
    } else {
      & node src/catalog.mjs --refresh-native
    }
    if ($LASTEXITCODE -ne 0) { throw "Codex model-catalog generation failed." }
  }
  & node src/litellm-config.mjs
  if ($LASTEXITCODE -ne 0) { throw "Gateway configuration generation failed." }

  if ($PrepareOnly) {
    Write-Host "Dependencies and generated files are prepared; application configuration was not changed."
    exit 0
  }

  $ConfigManager = if ($Target -eq "claude") { "src\claude-config-manager.mjs" } else { "src\config-manager.mjs" }
  $ConfigEnabled = $false
  $ServiceInstalled = $false
  try {
    $ConfigEnabled = $true
    & node $ConfigManager enable
    if ($LASTEXITCODE -ne 0) { throw "$Target configuration update failed." }
    $ServiceInstalled = $true
    & node src/service.mjs install
    if ($LASTEXITCODE -ne 0) { throw "Background-service installation failed." }
    & node src/wait-health.mjs
    if ($LASTEXITCODE -ne 0) { throw "The router did not become healthy." }
    & node src/install-manifest.mjs record | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Install-manifest recording failed." }
  } catch {
    if ($ServiceInstalled) { & node src/service.mjs uninstall 2>$null | Out-Null }
    if ($ConfigEnabled) { & node $ConfigManager disable 2>$null | Out-Null }
    throw
  }
  if ($Target -eq "claude") {
    Write-Host "Installed the selected external model routes. Fully quit and reopen Claude Desktop."
  } else {
    Write-Host "Installed the selected external model routes. Fully quit and reopen Codex."
  }
} finally {
  Pop-Location
}
