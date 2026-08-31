[CmdletBinding()]
param(
  [switch]$CheckoutInstall,
  [switch]$PrepareOnly,
  [switch]$ForceDeps,
  [ValidateSet("codex", "dsh", "gemini", "cursor", "claude")]
  [string]$Target = "codex",
  [string]$CursorPublicUrl,
  [string]$CursorHostname,
  [switch]$Guided,
  [switch]$Auto,
  [string]$Providers,
  [switch]$MigrateKnown,
  [switch]$AdoptNativeCatalog,
  [switch]$SmokeTest,
  # Matches install.sh's --with-tray/--no-tray. Windows previously had no way
  # to ask for the companion at all, so it was never built and never started.
  [switch]$WithTray,
  [switch]$NoTray,
  # Matches install.sh's --no-provider/--no-discovery: install idle with an
  # explicit empty selection, optionally with credential discovery disabled.
  [switch]$NoProvider,
  [switch]$NoDiscovery,
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
if ($CursorPublicUrl) {
  if ($Target -ne "cursor") { throw "-CursorPublicUrl applies to -Target cursor only." }
  $env:MODEL_ROUTER_CURSOR_PUBLIC_BASE_URL = $CursorPublicUrl
}
if ($CursorHostname) {
  if ($Target -ne "cursor") { throw "-CursorHostname applies to -Target cursor only." }
  if ($CursorPublicUrl) { throw "Use either -CursorHostname or -CursorPublicUrl, not both." }
  $env:MODEL_ROUTER_CURSOR_TUNNEL_HOSTNAME = $CursorHostname
}
# Legacy migration replaces an older router's managed Codex config block, and
# the native catalog is the ChatGPT-plan model list Codex adopts. Neither has a
# counterpart in DeepSeek Harness, whose integration is one settings section.
if ($Target -ne "codex" -and $MigrateKnown) {
  throw "-MigrateKnown applies only to the Codex target."
}
if ($Target -ne "codex" -and $AdoptNativeCatalog) {
  throw "-AdoptNativeCatalog applies only to the Codex target."
}
if ($PrepareOnly -and $AdoptNativeCatalog) {
  throw "-AdoptNativeCatalog cannot be used with -PrepareOnly."
}
if ($MigrateKnown -and $AdoptNativeCatalog) {
  throw "-AdoptNativeCatalog cannot be combined with -MigrateKnown."
}
if ($WithTray -and $NoTray) {
  throw "-WithTray cannot be combined with -NoTray."
}
# An idle install is exactly "no providers", so naming providers alongside it
# is a contradiction; and -NoDiscovery alone would select providers that can
# never authenticate.
if ($NoProvider -and ($Guided -or $Providers)) {
  throw "-NoProvider cannot be combined with -Guided or -Providers."
}
if ($NoDiscovery -and -not $NoProvider) {
  throw "-NoDiscovery requires -NoProvider."
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
  $UseGuided = $Guided -or (-not $Auto -and -not $NoProvider -and [Environment]::UserInteractive)
  if ($UseGuided) { $SetupArguments += "--guided" }
  if ($Providers) { $SetupArguments += @("--providers", $Providers) }
  if ($MigrateKnown) { $SetupArguments += "--migrate-known" }
  if ($AdoptNativeCatalog) { $SetupArguments += "--adopt-native-catalog" }
  if ($SmokeTest) { $SetupArguments += "--smoke-test" }
  if ($WithTray) { $SetupArguments += "--with-tray" }
  if ($NoTray) { $SetupArguments += "--no-tray" }
  if ($NoProvider) { $SetupArguments += "--no-provider" }
  if ($NoDiscovery) { $SetupArguments += "--no-discovery" }
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

# Each target enables its own client configuration; everything around that one
# step is the shared router plane.
$ConfigManager = switch ($Target) {
  "dsh" { "src\dsh-config-manager.mjs" }
  "gemini" { "src\gemini-config-manager.mjs" }
  "cursor" { "src\cursor-config-manager.mjs" }
  "claude" { "src\claude-code-config-manager.mjs" }
  default { "src\config-manager.mjs" }
}
$ConfigEnableCommand = if ($Target -eq "codex") { "enable" } else { "install" }
$ConfigDisableCommand = if ($Target -eq "codex") { "disable" } else { "uninstall" }
$ConfigEnabled = $false
$ServiceInstalled = $false
$AdoptionPending = $false
# The foreign-state override below is set only for a full install, but the
# finally runs for prepare-only and for failures that happen before that point
# too. Snapshot the caller's environment before any installer step can throw.
$HadForeignStateOverride = $null -ne (Get-Item Env:\MODEL_ROUTER_ALLOW_FOREIGN_STATE -ErrorAction SilentlyContinue)
$SavedForeignStateOverride = $env:MODEL_ROUTER_ALLOW_FOREIGN_STATE
$ConfigWasEnabled = $false
$ServiceWasInstalled = $false
$TrayWasInstalled = $false
Push-Location $ScriptDirectory

# What this run found before it changed anything, so the catch block can undo
# only what this run created. Read after Push-Location: these commands are
# resolved relative to the checkout.
function Get-InstallerStateField {
  param([string[]]$CommandArguments, [string]$Field)
  try {
    $raw = (& node @CommandArguments 2>$null | Out-String)
    if (-not $raw.Trim()) { return $null }
    return (ConvertFrom-Json $raw).$Field
  } catch {
    return $null
  }
}

try {
  # Each manager reports enablement under its own name: the Codex manager
  # publishes a routing mode, DSH reports whether its route reached the
  # settings document, Gemini whether its catalog is published.
  $ConfigWasEnabled = switch ($Target) {
    "dsh" { (Get-InstallerStateField @($ConfigManager, "status") "routeInstalled") -eq $true }
    "gemini" { (Get-InstallerStateField @($ConfigManager, "status") "installed") -eq $true }
    "cursor" { (Get-InstallerStateField @($ConfigManager, "status") "appConfigured") -eq $true }
    "claude" { (Get-InstallerStateField @($ConfigManager, "status") "installed") -eq $true }
    default { (Get-InstallerStateField @($ConfigManager, "status") "mode") -eq "router" }
  }
  $ServiceWasInstalled = (Get-InstallerStateField @("src\service.mjs", "status") "installed") -eq $true
  $TrayWasInstalled = (Get-InstallerStateField @("src\tray-service.mjs", "status") "installed") -eq $true
  if ($Target -eq "codex") {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
    $LegacyArguments = @("src\legacy-migration.mjs", "assert-clear")
    if ($AdoptNativeCatalog) { $LegacyArguments += "--adopt-native-catalog" }
    & node @LegacyArguments | Out-Null
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
    $VenvHomeOk = (& node src/install-plan.mjs venv-home-ok 2>$null | Select-Object -Last 1) -eq "ok"
    $VenvRuntimeOk = $false
    if (Test-Path $Python) {
      try {
        & $Python -I -c "import encodings, sys" 2>$null | Out-Null
        $VenvRuntimeOk = $LASTEXITCODE -eq 0
      } catch {
        $VenvRuntimeOk = $false
      }
    }
    if (-not (Test-Path $Python)) {
      if (Test-Path ".venv") {
        Write-Host "The virtual environment's Python launcher is missing; recreating the venv."
        & uv venv --clear --python 3.12 .venv
      } else {
        & uv venv --python 3.12 .venv
      }
      if ($LASTEXITCODE -ne 0) { throw "uv could not create the Python environment." }
    } elseif (-not $VenvHomeOk -or -not $VenvRuntimeOk) {
      # A venv whose interpreter home was cleared (macOS wipes /private/tmp,
      # and installers that recorded a temporary Python as the venv home end
      # up with a dangling interpreter) must be recreated, not pip-installed
      # into: the launcher may still exist while pyvenv.cfg points at a
      # vanished home.
      Write-Host "The virtual environment's interpreter home is missing; recreating the venv."
      & uv venv --clear --python 3.12 .venv
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
    $VenvHomeOk = (& node src/install-plan.mjs venv-home-ok 2>$null | Select-Object -Last 1) -eq "ok"
    $VenvRuntimeOk = $false
    if (Test-Path $Python) {
      try {
        & $Python -I -c "import encodings, sys" 2>$null | Out-Null
        $VenvRuntimeOk = $LASTEXITCODE -eq 0
      } catch {
        $VenvRuntimeOk = $false
      }
    }
    $RecreateVenv = -not $VenvHomeOk -or -not $VenvRuntimeOk
    if (Get-Command "py" -ErrorAction SilentlyContinue) {
      & py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
      if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
      if (-not (Test-Path $Python)) {
        & py -3 -m venv .venv
      } elseif ($RecreateVenv) {
        Write-Host "The virtual environment's interpreter home is missing; recreating the venv."
        & py -3 -m venv --clear .venv
      }
    } elseif (Get-Command "python" -ErrorAction SilentlyContinue) {
      & python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
      if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
      if (-not (Test-Path $Python)) {
        & python -m venv .venv
      } elseif ($RecreateVenv) {
        Write-Host "The virtual environment's interpreter home is missing; recreating the venv."
        & python -m venv --clear .venv
      }
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

  # Installing is the sanctioned way for a checkout to take over a state
  # directory: the generated files below are rebuilt here and the new owner is
  # recorded before the service step, so the ownership guard must not block a
  # full install. The override is scoped to exactly that run and only after
  # -PrepareOnly is known: a -PrepareOnly run rewrites the same generated state
  # but exits before the manifest record, so letting it past the guard would
  # let a second checkout rebuild foreign-owned state with no ownership
  # transfer ever recorded. The caller's own value is restored in the finally.
  if (-not $PrepareOnly) {
    $env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = "1"
  }
  & node src/secret.mjs ensure
  if ($LASTEXITCODE -ne 0) { throw "Local router-key setup failed." }
  # The state root is read by both arms below, so it is computed once rather
  # than inside the Codex branch: the harness arm needs it to find an existing
  # native catalog, and the republish step needs it to find the harness's own.
  $StateRoot = if ($env:MODEL_ROUTER_STATE_DIR) { $env:MODEL_ROUTER_STATE_DIR }
    elseif ($env:CODEX_ROUTER_STATE_DIR) { $env:CODEX_ROUTER_STATE_DIR }
    elseif ($env:KIMI_CODEX_STATE_DIR) { $env:KIMI_CODEX_STATE_DIR }
    elseif ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME "codex-router" }
    else { Join-Path $HOME ".codex\codex-router" }
  # Only refresh-catalog can safely resume the provider-state/journal pair left
  # by an interrupted login-free catalog refresh. Refuse install and doctor
  # repair before either can publish another catalog and report false recovery.
  & node src/login-free-refresh-journal.mjs assert-clear
  if ($LASTEXITCODE -ne 0) { throw "Finish the pending login-free catalog refresh before installing or repairing." }
  if ($AdoptNativeCatalog) {
    & node src/native-catalog-source.mjs prepare-from-config | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Existing native model-catalog adoption failed." }
    $AdoptionPending = $true
  }
  # `-s` in the POSIX scripts: present *and* non-empty. A zero-byte state file
  # is a half-written one, and treating it as real publishes an empty catalog.
  function Test-NonEmptyFile([string] $Path) {
    return (Test-Path $Path -PathType Leaf) -and ((Get-Item $Path).Length -gt 0)
  }
  $NativeCatalogPath = Join-Path $StateRoot "native-models.json"
  if ($Target -eq "codex") {
    if (Test-NonEmptyFile $NativeCatalogPath) {
      & node src/catalog.mjs
    } else {
      & node src/catalog.mjs --refresh-native
    }
    if ($LASTEXITCODE -ne 0) { throw "Codex model-catalog generation failed." }
  } elseif (Test-NonEmptyFile $NativeCatalogPath) {
    # A harness-only machine has no Codex to ask for a native catalog, so one is
    # regenerated only when an earlier Codex install already left one behind.
    & node src/catalog.mjs
    if ($LASTEXITCODE -ne 0) { throw "Codex model-catalog generation failed." }
  }
  & node src/litellm-config.mjs
  if ($LASTEXITCODE -ne 0) { throw "Gateway configuration generation failed." }
  # The router plane is shared, so an install for one client changes the routable
  # set for the other. Republish whichever integration is already installed here
  # rather than leaving it advertising a stale model list.
  if ($Target -ne "gemini" -and (Test-NonEmptyFile (Join-Path $StateRoot "gemini-models.json"))) {
    & node src/gemini-config-manager.mjs install | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Gemini CLI republish failed." }
  }
  if ($Target -ne "dsh" -and (Test-NonEmptyFile (Join-Path $StateRoot "dsh-models.json"))) {
    & node src/dsh-config-manager.mjs install | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "DeepSeek Harness republish failed." }
  }
  if ($Target -ne "cursor" -and (Test-NonEmptyFile (Join-Path $StateRoot "cursor-models.json"))) {
    $CursorRunning = (Get-InstallerStateField @("src\cursor-config-manager.mjs", "status") "running") -eq $true
    if (-not $CursorRunning) {
      & node src/cursor-config-manager.mjs install | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Cursor republish failed." }
    }
  }
  if ($Target -ne "claude" -and (Test-NonEmptyFile (Join-Path $StateRoot "claude-models.json"))) {
    & node src/claude-code-config-manager.mjs install | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Claude Code republish failed." }
  }

  if ($PrepareOnly) {
    Write-Host "Dependencies and generated files are prepared; application configuration was not changed."
    # Return from the script instead of terminating the caller's PowerShell
    # host. The outer finally still has to restore the caller environment, and
    # an invoked prepare-only install must hand control back so its caller can
    # observe that restoration.
    return
  }

  $ConfigEnabled = $true
  $ConfigArguments = @($ConfigManager, $ConfigEnableCommand)
  if ($AdoptNativeCatalog) { $ConfigArguments += "--adopt-native-catalog" }
  & node @ConfigArguments
  if ($LASTEXITCODE -ne 0) { throw "$Target configuration update failed." }
  $AdoptionPending = $false
  # Record before the service starts, not after. The manifest is provenance for
  # the install that just happened -- which checkout owns the state, and the
  # proxy environment a later repair must restore -- and the service itself
  # needs the record in place first: start.mjs rewrites the gateway config on
  # every boot and refuses while the manifest still names another checkout, so
  # recording after `service.mjs install` -- a step that contains the health
  # wait -- let an install over a foreign-owned state directory crash-loop for
  # the whole readiness budget while the ownership transfer never ran.
  & node src/install-manifest.mjs record | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Install-manifest recording failed." }
  $ServiceInstalled = $true
  & node src/service.mjs install
  if ($LASTEXITCODE -ne 0) { throw "Background-service installation failed." }
  & node src/wait-health.mjs
  if ($LASTEXITCODE -ne 0) { throw "The router did not become healthy." }

  # Keep an existing companion in step with the checkout, but never turn a
  # fresh router install into a tray install the operator did not request.
  # Run the wrapper in a child PowerShell process because its deliberate
  # `exit` would otherwise terminate this installer before the status could be
  # checked. This remains best effort, matching bin/install: an optional Rust
  # or Electron build failure must not roll back a healthy router update.
  if ($TrayWasInstalled -and $env:CODEX_ROUTER_DEFER_TRAY_REBUILD -ne "1") {
    $SavedRouterTarget = $env:MODEL_ROUTER_TARGET
    try {
      # The tray belongs to the shared router plane. codex-router.ps1 is the
      # Windows companion entry point and deliberately accepts only its Codex
      # spelling, even when this update was initiated for DSH or Gemini CLI.
      $env:MODEL_ROUTER_TARGET = "codex"
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDirectory "codex-router.ps1") tray install --preserve-window
      $TrayExitCode = $LASTEXITCODE
      if ($TrayExitCode -ne 0) {
        Write-Warning "Desktop companion refresh failed with exit code $TrayExitCode; the router is installed. Run '.\codex-router.ps1 tray repair' if an earlier elevated install owns the task."
      }
    } catch {
      Write-Warning "Desktop companion refresh failed; the router is installed: $($_.Exception.Message) Run '.\codex-router.ps1 tray repair' if an earlier elevated install owns the task."
    } finally {
      $env:MODEL_ROUTER_TARGET = $SavedRouterTarget
    }
  } elseif ($TrayWasInstalled) {
    # A Control Center cannot synchronously rebuild the executable that is
    # running this installer: stop/drain waits for the caller's mutation, while
    # the caller waits for install.ps1. The UI launches a detached `control tray
    # refresh` after its mutation settles; that command rechecks tray-plan and
    # does nothing when this install did not make the package stale.
    Write-Output "Desktop companion refresh deferred until the Control Center mutation completes."
  }

  # Managed Codex skills are an integration convenience, not part of router
  # health. Refresh them after the service transaction and keep a failure from
  # entering the rollback path, exactly like the POSIX installer.
  if ($Target -eq "codex") {
    try {
      & node src/skills-install.mjs install
      $SkillsExitCode = $LASTEXITCODE
      if ($SkillsExitCode -ne 0) {
        Write-Warning "Managed Codex skills could not be refreshed (exit $SkillsExitCode); the router is installed."
      }
    } catch {
      Write-Warning "Managed Codex skills could not be refreshed; the router is installed: $($_.Exception.Message)"
    }
  }

  if ($Target -eq "dsh") {
    Write-Host "Published the selected external model routes to DeepSeek Harness. It reloads them on the next request."
  } elseif ($Target -eq "gemini") {
    Write-Host "Published the selected external model routes to Gemini CLI. The next 'gemini' run picks them up."
    Write-Host "Choose 'Use Gemini API key' once if it asks how to authenticate; the key is this router's local caller capability."
  } elseif ($Target -eq "cursor") {
    Write-Host "Published all routed models to Cursor Agent and Cursor App."
    Write-Host "Run cursor-router-agent for the CLI; fully quit and reopen Cursor for the app."
  } elseif ($Target -eq "claude") {
    Write-Host "Published all routed models to Claude Code. Run claude-router and choose a codex_router/anthropic/... model."
  } else {
    Write-Host "Installed the selected external model routes. Fully quit and reopen Codex."
  }
} catch {
  # Undo only what this run created. The router health wait can time out on a
  # cold-starting gateway with a large model set -- retryable, not broken -- and
  # tearing out a service and disabling a client config that were both working
  # before the run turns that into an unrouted machine.
  if ($ServiceInstalled -and -not $ServiceWasInstalled) {
    & node src/service.mjs uninstall 2>$null | Out-Null
  }
  if ($ConfigEnabled) {
    if (-not $ConfigWasEnabled) {
      & node $ConfigManager $ConfigDisableCommand 2>$null | Out-Null
    }
  } elseif ($AdoptionPending) {
    & node src/native-catalog-source.mjs clear-pending 2>$null | Out-Null
  }
  throw
} finally {
  # Restore the caller's environment exactly as it was found: a value this run
  # did not set is removed, and a pre-existing one is put back verbatim. The
  # scoped override must never outlive the install process that justified it.
  if ($HadForeignStateOverride) {
    $env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = $SavedForeignStateOverride
  } else {
    Remove-Item Env:\MODEL_ROUTER_ALLOW_FOREIGN_STATE -ErrorAction SilentlyContinue
  }
  Pop-Location
}
