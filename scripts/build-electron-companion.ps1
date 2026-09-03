[CmdletBinding()]
param(
  # The tray wrapper supplies a private transaction path and keeps the previous package
  # there until Task Scheduler proves the replacement is ready. Direct builds
  # keep their historical one-shot behavior and remove their private backup.
  [string]$BackupDirectory,
  [switch]$KeepPrevious
)

# Compatibility entrypoint retained for existing automation. The Electron
# companion is now the full Control Center: one packaged process owns both the
# native tray and the normal application window.

$ErrorActionPreference = "Stop"
$Repository = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Repository "apps\control-center"
$StagingRoot = Join-Path $App (".control-center-build-" + [Guid]::NewGuid().ToString("N"))
$TargetDirectory = Join-Path $App "release\win-unpacked"
$ReleaseDirectory = Join-Path $App "release"

function Assert-ControlCenterBuildPath([string]$Target, [string]$Label, [string]$Kind = "Any") {
  if (-not (Test-Path -LiteralPath $Target)) { return }
  $Item = Get-Item -LiteralPath $Target -Force -ErrorAction Stop
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to use the Control Center $Label reparse point at $Target."
  }
  if ($Kind -eq "Directory" -and -not $Item.PSIsContainer) {
    throw "Refusing to use the Control Center $Label because it is not a directory: $Target."
  }
}

if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
  if ($KeepPrevious) {
    throw "-KeepPrevious requires an explicit -BackupDirectory owned by the tray update transaction."
  }
  $BackupDirectory = Join-Path $ReleaseDirectory (".win-unpacked.previous-" + [Guid]::NewGuid().ToString("N"))
} else {
  $BackupDirectory = [IO.Path]::GetFullPath($BackupDirectory)
  $ExpectedParent = [IO.Path]::GetFullPath($ReleaseDirectory)
  $ActualParent = [IO.Path]::GetFullPath((Split-Path -Parent $BackupDirectory))
  if (-not [string]::Equals($ExpectedParent, $ActualParent, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Split-Path -Leaf $BackupDirectory).StartsWith(".win-unpacked.previous-", [StringComparison]::OrdinalIgnoreCase)) {
    throw "The Control Center backup must be a .win-unpacked.previous-* directory inside $ReleaseDirectory."
  }
}
$PreviousMoved = $false

Assert-ControlCenterBuildPath $ReleaseDirectory "release directory" "Directory"
Assert-ControlCenterBuildPath $TargetDirectory "live package" "Directory"
Assert-ControlCenterBuildPath $BackupDirectory "rollback package" "Directory"

foreach ($CommandName in @("node", "npm")) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "$CommandName is required to build the Control Center."
  }
}

Push-Location $App
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw "Control Center npm dependency installation failed." }
  & npm run check
  if ($LASTEXITCODE -ne 0) { throw "Control Center checks failed." }
  & npm test
  if ($LASTEXITCODE -ne 0) { throw "Control Center tests failed." }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Control Center renderer build failed." }
} finally {
  Pop-Location
}

try {
  New-Item -ItemType Directory -Path $StagingRoot | Out-Null
  Assert-ControlCenterBuildPath $StagingRoot "staging directory" "Directory"
  $PreviousIdentityDiscovery = $env:CSC_IDENTITY_AUTO_DISCOVERY
  $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
  try {
    # electron-builder resolves the project configuration from the current
    # directory. The wrapper runs from the repository root, so enter the
    # Control Center directory explicitly before packaging.
    Push-Location -LiteralPath $App
    try {
      & (Join-Path $App "node_modules\.bin\electron-builder.cmd") --win dir --publish never "--config.directories.output=$StagingRoot"
      if ($LASTEXITCODE -ne 0) { throw "Control Center packaging failed." }
    } finally {
      Pop-Location
    }
  } finally {
    $env:CSC_IDENTITY_AUTO_DISCOVERY = $PreviousIdentityDiscovery
  }

  $StagedDirectory = Join-Path $StagingRoot "win-unpacked"
  $StagedBinary = Join-Path $StagedDirectory "Codex Router.exe"
  if (-not (Test-Path -LiteralPath $StagedBinary -PathType Leaf)) {
    throw "The packaged Control Center is missing at $StagedBinary."
  }

  # Local unpacked packages resolve the owning router checkout through this
  # marker. Public signed packages are produced elsewhere and are never
  # mutated after packaging.
  $Marker = Join-Path $StagedDirectory "resources\router-root"
  [IO.File]::WriteAllText($Marker, "$Repository`n", [Text.UTF8Encoding]::new($false))

  # Preserve the last working package until the staged build is complete.
  # This also makes a direct build fail safely when a live process still holds
  # the target directory open.
  Assert-ControlCenterBuildPath $ReleaseDirectory "release directory" "Directory"
  New-Item -ItemType Directory -Force -Path $ReleaseDirectory | Out-Null
  if (Test-Path -LiteralPath $BackupDirectory) {
    Assert-ControlCenterBuildPath $BackupDirectory "rollback package" "Directory"
    throw "Refusing to overwrite an existing Control Center backup at $BackupDirectory."
  }
  if (Test-Path -LiteralPath $TargetDirectory) {
    Assert-ControlCenterBuildPath $TargetDirectory "live package" "Directory"
    Move-Item -LiteralPath $TargetDirectory -Destination $BackupDirectory
    $PreviousMoved = $true
  }
  try {
    Assert-ControlCenterBuildPath $ReleaseDirectory "release directory" "Directory"
    Assert-ControlCenterBuildPath $StagedDirectory "staged package" "Directory"
    if (Test-Path -LiteralPath $TargetDirectory) {
      Assert-ControlCenterBuildPath $TargetDirectory "unexpected live package" "Directory"
      throw "Refusing to replace an unexpected Control Center package at $TargetDirectory."
    }
    Move-Item -LiteralPath $StagedDirectory -Destination $TargetDirectory
  } catch {
    # The backup directory is the durable transaction marker. An interrupt can
    # arrive after Move-Item succeeds but before $PreviousMoved is assigned.
    if ((Test-Path -LiteralPath $BackupDirectory) -and
        -not (Test-Path -LiteralPath $TargetDirectory)) {
      Assert-ControlCenterBuildPath $ReleaseDirectory "release directory" "Directory"
      Assert-ControlCenterBuildPath $BackupDirectory "rollback package" "Directory"
      Move-Item -LiteralPath $BackupDirectory -Destination $TargetDirectory
      $PreviousMoved = $false
    }
    throw
  }
  if ($PreviousMoved -and -not $KeepPrevious) {
    Assert-ControlCenterBuildPath $BackupDirectory "rollback package" "Directory"
    Remove-Item -LiteralPath $BackupDirectory -Recurse -Force
    $PreviousMoved = $false
  }
} finally {
  if ((Test-Path -LiteralPath $BackupDirectory) -and
      -not (Test-Path -LiteralPath $TargetDirectory)) {
    Assert-ControlCenterBuildPath $ReleaseDirectory "release directory" "Directory"
    Assert-ControlCenterBuildPath $BackupDirectory "rollback package" "Directory"
    Move-Item -LiteralPath $BackupDirectory -Destination $TargetDirectory -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $StagingRoot) {
    Assert-ControlCenterBuildPath $StagingRoot "staging directory" "Directory"
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
  }
}

$Binary = Join-Path $TargetDirectory "Codex Router.exe"
Write-Output $Binary
