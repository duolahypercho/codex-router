[CmdletBinding()]
param(
  [switch]$CheckoutInstall,
  [switch]$PrepareOnly,
  [switch]$ForceDeps,
  [ValidateSet("codex")]
  [string]$Target = "codex",
  [switch]$Guided,
  [switch]$Auto,
  [string]$Providers,
  [switch]$MigrateKnown,
  [switch]$SmokeTest,
  # Discards tracked edits in the managed checkout so the update can proceed.
  # Deliberately never touches untracked files -- see Reset-ManagedCheckout.
  [switch]$Force,
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  )
)

$ErrorActionPreference = "Stop"
$env:MODEL_ROUTER_TARGET = $Target
if ($Target -ne "codex" -and $MigrateKnown) {
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

# Mirrors DIRTY_PREVIEW_LIMIT in src/update.mjs. test/installer-scripts.test.mjs
# imports that constant and compares it with this one, so the two cannot drift.
$DirtyPreviewLimit = 10

# Mirrors localModifications() in src/update.mjs. Only tracked edits are at
# stake: a fast-forward pull never replaces an untracked file, and git refuses
# the rare collision on its own with a precise message. Counting untracked files
# as "local changes" only ever stranded people -- one stray file in the checkout
# and every later self-update was refused.
function Get-LocalModification([string]$Directory) {
  $Output = @(& git -C $Directory status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0) { throw "Unable to read the Git status of $Directory." }
  return @($Output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}

# Mirrors localModificationsMessage() in src/update.mjs. Naming the files and
# both ways forward is the whole point: the old message named neither, so anyone
# blocked by a single stray edit had nothing to act on.
function Get-LocalModificationMessage([string[]]$Changes, [string]$Directory) {
  $Plural = if ($Changes.Count -eq 1) { "" } else { "s" }
  $Lines = @(
    "The checkout has local changes to $($Changes.Count) tracked file${Plural}; refusing to replace them during update:"
  )
  $Lines += @($Changes | Select-Object -First $DirtyPreviewLimit | ForEach-Object { "  $_" })
  $Remainder = $Changes.Count - $DirtyPreviewLimit
  if ($Remainder -gt 0) { $Lines += "  ...and $Remainder more" }
  $Lines += ""
  $Lines += "Keep them:    git -C $Directory stash"
  $Lines += "Discard them: re-run the same command with -Force"
  return ($Lines -join "`n")
}

# Mirrors requireReplaceableCheckout() in src/update.mjs, including its refusal
# to reach for `git clean`: -Force restores files git already tracks and leaves
# untracked files exactly where they are, because an update has no business
# deleting work git was never asked to track.
function Reset-ManagedCheckout([string]$Directory) {
  & git -C $Directory reset --hard HEAD
  if ($LASTEXITCODE -ne 0) { throw "Unable to discard the local changes in $Directory." }
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
      # PowerShell unrolls a one-element array on return, so re-wrap before
      # reading .Count.
      $Dirty = @(Get-LocalModification $InstallDir)
      if ($Dirty.Count) {
        if (-not $Force) { throw (Get-LocalModificationMessage $Dirty $InstallDir) }
        Reset-ManagedCheckout $InstallDir
      }
      # A failed setup rolls the checkout back to a detached HEAD (see the
      # rollback below), where `branch --show-current` prints nothing. A native
      # command with no output yields $null, and in Windows PowerShell 5.1
      # [string]$null stays $null, so guard explicitly before calling Trim().
      $Branch = & git -C $InstallDir branch --show-current
      if ($null -eq $Branch) { $Branch = "" }
      $Branch = [string]$Branch.Trim()
      if ($Branch -ne "main") {
        if (-not $Branch) {
          & git -C $InstallDir switch main 2>$null
          if ($LASTEXITCODE -ne 0) {
            throw "$InstallDir is in a detached HEAD state and could not be restored to main; run 'git switch main' there and retry."
          }
          $Branch = & git -C $InstallDir branch --show-current
          if ($null -eq $Branch) { $Branch = "" }
          $Branch = [string]$Branch.Trim()
        }
        if ($Branch -ne "main") { throw "$InstallDir must be on its main branch to update." }
      }
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

  $SetupScript = "src\setup.mjs"
  $SetupArguments = @((Join-Path $Repository $SetupScript))
  $UseGuided = $Guided -or (-not $Auto -and [Environment]::UserInteractive)
  if ($UseGuided) { $SetupArguments += "--guided" }
  if ($Providers) { $SetupArguments += @("--providers", $Providers) }
  if ($MigrateKnown) { $SetupArguments += "--migrate-known" }
  if ($SmokeTest) { $SetupArguments += "--smoke-test" }
  & node @SetupArguments
  $SetupExitCode = $LASTEXITCODE
  # Exit 2 means setup left configuration unfinished (a declined prompt, a
  # missing credential) and says nothing about the code that was just pulled.
  # Rolling back there discards the update the user ran this for, and if the
  # unfinished step is itself the bug being fixed, every retry repeats it.
  # Any other non-zero code still restores the checkout, so the running
  # service is never left on half-applied code by an unrecognized failure.
  if ($SetupExitCode -eq 2) {
    Write-Warning "Setup did not finish configuring; the update was kept. Re-run setup to continue, or ./codex-router.ps1 rollback to return to the previous revision."
  } elseif ($SetupExitCode -ne 0 -and $PreviousRevision) {
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

  # Every update re-runs this installer, so the dependency steps are skipped
  # when their inputs are unchanged; -ForceDeps (used by doctor --fix) rebuilds
  # them.
  function Get-InstallStep([string]$Step) {
    if ($ForceDeps) { return "run" }
    try {
      $Status = (& node src/install-plan.mjs status $Step 2>$null | Select-Object -Last 1)
      if ($LASTEXITCODE -ne 0) { return "run" }
      return "$Status".Trim()
    } catch {
      return "run"
    }
  }

  if ((Get-InstallStep "node-deps") -eq "skip") {
    Write-Host "Node dependencies already match package-lock.json; skipping npm ci."
  } else {
    & npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed." }
    & node src/install-plan.mjs record node-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Node dependency state failed." }
  }

  $Python = Join-Path $ScriptDirectory ".venv\Scripts\python.exe"
  if ((Get-InstallStep "python-deps") -eq "skip") {
    Write-Host "LiteLLM already matches the pinned versions; skipping the Python install."
  } elseif (Get-Command "uv" -ErrorAction SilentlyContinue) {
    if (-not (Test-Path $Python)) {
      & uv venv --python 3.12 .venv
      if ($LASTEXITCODE -ne 0) { throw "uv could not create the Python environment." }
    }
    # requirements/python.txt is the hash-verified transitive closure of the
    # pins in src/install-plan.mjs. Hash checking makes every wheel and sdist
    # in that tree verify against the lock before it is executed; without it
    # only the two top-level packages were pinned and the rest was whatever
    # PyPI resolved that day. Regenerate with bin/lock-python, never by hand.
    & uv pip install --python $Python --require-hashes -r requirements/python.txt
    if ($LASTEXITCODE -ne 0) { throw "LiteLLM installation failed." }
    & node src/install-plan.mjs record python-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Python dependency state failed." }
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
    # Same hash-verified lock as the uv branch above; both stay hash-checked.
    & $Python -m pip install --require-hashes -r requirements/python.txt
    if ($LASTEXITCODE -ne 0) { throw "LiteLLM installation failed." }
    & node src/install-plan.mjs record python-deps
    if ($LASTEXITCODE -ne 0) { throw "Recording the Python dependency state failed." }
  }

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

  $ConfigManager = "src\config-manager.mjs"
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
  Write-Host "Installed the selected external model routes. Fully quit and reopen Codex."
} finally {
  Pop-Location
}
