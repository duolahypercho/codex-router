$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Target = if ($env:MODEL_ROUTER_TARGET) { $env:MODEL_ROUTER_TARGET } else { "codex" }
if ($Target -ne "codex") {
  throw "MODEL_ROUTER_TARGET must be codex."
}
$Command = if ($args.Count) { [string]$args[0] } else { "status" }
# The @() wraps the whole `if`, not its branches. PowerShell enumerates a
# statement's output into an assignment, so a one-element array collapses to
# the element itself: `tray status` bound $Arguments to the String "status",
# and $Arguments[0] then indexed the string and yielded "s". Every
# single-argument subcommand -- tray status/start/stop/restart/uninstall --
# failed with "Unknown tray action 's'".
$Arguments = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] })
$Commands = @(
  "setup", "install", "doctor", "status", "providers", "provider-key", "enable",
  "disable", "uninstall", "update", "rollback", "support-bundle",
  "smoke-test", "start", "stop", "test-model", "discover-models",
  "signed-routing", "refresh-catalog", "media", "tray", "panel", "companion"
)
if ($Command -notin $Commands) {
  throw "Unknown command '$Command'. Choose: $($Commands -join ', ')."
}
function Invoke-RouterNode([string]$Script, [string[]]$ScriptArguments = @()) {
  & node (Join-Path $Root $Script) @ScriptArguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Script exited with status $LASTEXITCODE."
  }
}

switch ($Command) {
  "setup" {
    Invoke-RouterNode "src\setup.mjs" $Arguments
  }
  "doctor" {
    Invoke-RouterNode "src\doctor.mjs" $Arguments
  }
  "status" {
    Invoke-RouterNode "src\doctor.mjs" $Arguments
  }
  "providers" { Invoke-RouterNode "src\providers.mjs" $Arguments }
  "provider-key" { Invoke-RouterNode "src\provider-key.mjs" $Arguments }
  # `bin/install` accepts --prepare-only/--migrate-known/--force-deps, so the
  # Windows wrapper has to pass the equivalent switches through instead of
  # dropping them; `./model-router.ps1 codex install -ForceDeps` was silently
  # running a plain install.
  "install" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target @Arguments }
  "enable" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target @Arguments }
  "disable" {
    Invoke-RouterNode "src\config-manager.mjs" @("disable")
    Invoke-RouterNode "src\service.mjs" @("uninstall")
  }
  "uninstall" {
    Invoke-RouterNode "src\config-manager.mjs" @("disable")
    Invoke-RouterNode "src\service.mjs" @("uninstall")
  }
  "update" {
    # `update check` stays a read-only comparison; a bare `update` installs.
    $UpdateArguments = if ($Arguments.Count) { $Arguments } else { @("update") }
    Invoke-RouterNode "src\update.mjs" $UpdateArguments
  }
  "rollback" {
    # The subcommand is fixed, so the caller's flags are appended to it rather
    # than replacing it -- the shape `bin/rollback` uses (`update.mjs rollback
    # "$@"`). Hardcoding the list here made `rollback --force` unreachable on
    # Windows, which is the only way past tracked edits that block a rollback.
    Invoke-RouterNode "src\update.mjs" (@("rollback") + $Arguments)
  }
  "signed-routing" {
    Invoke-RouterNode "src\control.mjs" (@("signed-routing") + $Arguments)
  }
  "refresh-catalog" { Invoke-RouterNode "src\refresh-catalog.mjs" $Arguments }
  "support-bundle" { Invoke-RouterNode "src\support-bundle.mjs" $Arguments }
  "smoke-test" {
    Invoke-RouterNode "src\smoke-test.mjs" $Arguments
  }
  "start" { Invoke-RouterNode "src\start.mjs" $Arguments }
  "stop" { Invoke-RouterNode "src\service.mjs" @("stop") }
  "test-model" { Invoke-RouterNode "src\compatibility-test.mjs" $Arguments }
  "discover-models" { Invoke-RouterNode "src\model-discovery.mjs" $Arguments }
  "media" { Invoke-RouterNode "src\minimax-media.mjs" $Arguments }
  # The companion with nothing to build and nothing to download. The router is
  # already serving it; this is the one thing that knows the address.
  "panel" { Invoke-RouterNode "src\panel.mjs" $Arguments }
  # The Windows counterpart of ./bin/model-router-tray. Before this, macOS and
  # Linux had one command that built and supervised the companion and Windows
  # had none -- bin/model-router-tray only told you to go read a build script.
  # Build when the sources moved, then hand it to Task Scheduler, which starts
  # it now and again at every logon.
  "tray" {
    $Action = if ($Arguments.Count) { [string]$Arguments[0] } else { "install" }
    if ($Action -notin @("install", "status", "start", "stop", "restart", "uninstall", "rebuild")) {
      throw "Unknown tray action '$Action'. Choose: install, status, start, stop, restart, uninstall, rebuild."
    }
    # `rebuild` is `control tray rebuild`'s Windows half: build unconditionally
    # -- bypassing the source-fingerprint skip that `install` uses -- then
    # restart whichever companion Task Scheduler already supervises.
    if ($Action -eq "rebuild") {
      if (Get-Command cargo -ErrorAction SilentlyContinue) {
        & (Join-Path $Root "scripts\build-desktop-tray.ps1") -BinaryOnly
        if ($LASTEXITCODE -ne 0) { throw "Desktop companion build failed." }
        & node (Join-Path $Root "src\install-plan.mjs") record-tray | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "Could not stamp the companion build; the next update will rebuild it."
        }
      } else {
        Write-Output "Cargo is not on PATH; rebuilding the Electron companion instead."
        & (Join-Path $Root "scripts\build-electron-companion.ps1") | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Electron companion build failed." }
      }
      Invoke-RouterNode "src\tray-service.mjs" @("restart")
      exit 0
    }
    # Rust is the only prerequisite the Tauri shell adds over what the router
    # install already required. Without it this step used to fail and print an
    # apology, which left the machine with no companion at all; the Electron
    # shell renders the same UI and needs only Node.
    if ($Action -eq "install" -and -not (Get-Command cargo -ErrorAction SilentlyContinue)) {
      Write-Output "Cargo is not on PATH, so the Tauri companion cannot be built."
      Write-Output "Building the Electron companion instead; it needs only Node."
      & (Join-Path $Root "scripts\build-electron-companion.ps1") | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Electron companion build failed." }
      Invoke-RouterNode "src\tray-service-windows.mjs" @("install-electron")
      Write-Output "Companion installed and started by Task Scheduler; it returns at every logon."
      Write-Output "Windows 11 hides new tray icons: click the ^ chevron by the clock, then drag the icon onto the taskbar to pin it."
      exit 0
    }
    if ($Action -eq "install") {
      $Plan = & node (Join-Path $Root "src\install-plan.mjs") tray-plan
      if ($LASTEXITCODE -ne 0) { throw "Could not read the tray build plan." }
      if ($Plan.Trim() -eq "skip") {
        Write-Output "Companion already built from these sources; skipping the rebuild."
      } else {
        & (Join-Path $Root "scripts\build-desktop-tray.ps1") -BinaryOnly
        if ($LASTEXITCODE -ne 0) { throw "Desktop companion build failed." }
        # Not silenced: without the stamp every later update rebuilds the
        # companion from scratch, which is the cost this step exists to avoid.
        & node (Join-Path $Root "src\install-plan.mjs") record-tray | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "Could not stamp the companion build; the next update will rebuild it."
        }
      }
    }
    Invoke-RouterNode "src\tray-service.mjs" @($Action)
    if ($Action -eq "install") {
      Write-Output "Tray installed and started by Task Scheduler; it returns at every logon."
      Write-Output "Windows 11 hides new tray icons: click the ^ chevron by the clock, then drag the icon onto the taskbar to pin it."
    }
  }
  # The same companion, built with Node instead of Rust. `tray` needs cargo and
  # several minutes of compiling; this needs what the router install already
  # required, so a machine with no Rust toolchain is not left without one.
  "companion" {
    $Action = if ($Arguments.Count) { [string]$Arguments[0] } else { "install" }
    if ($Action -notin @("install", "status", "start", "stop", "restart", "uninstall")) {
      throw "Unknown companion action '$Action'. Choose: install, status, start, stop, restart, uninstall."
    }
    if ($Action -eq "install") {
      & (Join-Path $Root "scripts\build-electron-companion.ps1") | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Electron companion build failed." }
      Invoke-RouterNode "src\tray-service-windows.mjs" @("install-electron")
      Write-Output "Companion installed and started by Task Scheduler; it returns at every logon."
      Write-Output "Windows 11 hides new tray icons: click the ^ chevron by the clock, then drag the icon onto the taskbar to pin it."
    } else {
      Invoke-RouterNode "src\tray-service.mjs" @($Action)
    }
  }
}

exit 0
