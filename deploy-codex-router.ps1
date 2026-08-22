[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$InstallDir = $(
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "codex-router" }
    else { Join-Path $HOME ".local\share\codex-router" }
  )
)

$ErrorActionPreference = "Stop"
$sourceDir = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$installDir = [IO.Path]::GetFullPath($InstallDir)
$DeployManifestName = ".codex-router-deploy-manifest.json"
$DeployManifestPath = Join-Path $installDir $DeployManifestName
$ExcludedDirectoryNames = @(
  ".git", ".venv", "node_modules", "target", "dist", "release", "release-local"
)

function Get-NormalizedDirectory([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Test-NestedDirectory([string]$Candidate, [string]$Container) {
  $CandidatePath = "$(Get-NormalizedDirectory $Candidate)\"
  $ContainerPath = "$(Get-NormalizedDirectory $Container)\"
  return $CandidatePath.StartsWith($ContainerPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-DeploySourceFiles {
  $SourcePrefix = "$(Get-NormalizedDirectory $sourceDir)\"
  $Pending = New-Object 'System.Collections.Generic.Stack[string]'
  $Pending.Push($sourceDir)
  $Files = New-Object 'System.Collections.Generic.List[string]'
  while ($Pending.Count -gt 0) {
    $Directory = $Pending.Pop()
    foreach ($Entry in Get-ChildItem -LiteralPath $Directory -Force) {
      if ($Entry.PSIsContainer) {
        if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
            $ExcludedDirectoryNames -notcontains $Entry.Name) {
          $Pending.Push($Entry.FullName)
        }
        continue
      }
      if ($Entry.Name -eq $DeployManifestName) { continue }
      $Files.Add($Entry.FullName.Substring($SourcePrefix.Length))
    }
  }
  return @($Files | Sort-Object -Unique)
}

function Read-DeployManifest {
  if (-not (Test-Path -LiteralPath $DeployManifestPath -PathType Leaf)) { return @() }
  try {
    $Document = Get-Content -LiteralPath $DeployManifestPath -Raw | ConvertFrom-Json
    if ($Document.version -ne 1 -or $null -eq $Document.files) {
      throw "unsupported manifest shape"
    }
    return @($Document.files | ForEach-Object {
      if ($_ -isnot [string] -or -not $_) { throw "invalid managed path" }
      $_
    })
  } catch {
    throw "Refusing deployment because $DeployManifestPath is invalid: $($_.Exception.Message)"
  }
}

function Resolve-ManagedTargetFile([string]$RelativePath) {
  if ([IO.Path]::IsPathRooted($RelativePath)) {
    throw "The deployment manifest contains an absolute path."
  }
  $Segments = @($RelativePath -split '[\\/]')
  if ($Segments.Count -eq 0 -or $Segments -contains "" -or
      $Segments -contains "." -or $Segments -contains "..") {
    throw "The deployment manifest contains an unsafe relative path."
  }
  $InstallPrefix = "$(Get-NormalizedDirectory $installDir)\"
  $Target = [IO.Path]::GetFullPath((Join-Path $installDir $RelativePath))
  if (-not $Target.StartsWith($InstallPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The deployment manifest path escapes the installed checkout."
  }
  $Cursor = Get-NormalizedDirectory $installDir
  foreach ($Segment in $Segments[0..([Math]::Max(0, $Segments.Count - 2))]) {
    if ($Segments.Count -eq 1) { break }
    $Cursor = Join-Path $Cursor $Segment
    if (Test-Path -LiteralPath $Cursor) {
      $Attributes = (Get-Item -LiteralPath $Cursor -Force).Attributes
      if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to prune through reparse point $Cursor."
      }
    }
  }
  return $Target
}

function Update-DeployManifest([string[]]$CurrentFiles) {
  $Current = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($RelativePath in $CurrentFiles) { [void]$Current.Add($RelativePath) }
  foreach ($RelativePath in Read-DeployManifest) {
    if ($Current.Contains($RelativePath)) { continue }
    $Target = Resolve-ManagedTargetFile $RelativePath
    if (Test-Path -LiteralPath $Target -PathType Leaf) {
      Remove-Item -LiteralPath $Target -Force
    }
  }

  $Temporary = "$DeployManifestPath.tmp.$PID"
  try {
    @{ version = 1; files = @($CurrentFiles) } |
      ConvertTo-Json -Depth 3 |
      Set-Content -LiteralPath $Temporary -Encoding UTF8
    Move-Item -LiteralPath $Temporary -Destination $DeployManifestPath -Force
  } finally {
    if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force }
  }
}

if ((Test-NestedDirectory $sourceDir $installDir) -or
    (Test-NestedDirectory $installDir $sourceDir)) {
  throw "Source and install directories must be separate and neither may contain the other."
}
if (-not (Test-Path (Join-Path $sourceDir "src\start.mjs"))) {
  throw "Router source not found at $sourceDir."
}
if (-not (Test-Path (Join-Path $installDir "src\start.mjs"))) {
  throw "Installed router not found at $installDir."
}

function Get-TrayStatus {
  $Output = (& node (Join-Path $installDir "src\tray-service.mjs") status | Out-String)
  $StatusExitCode = $LASTEXITCODE
  if ($StatusExitCode -ne 0) {
    throw "Reading the installed tray status failed with exit code $StatusExitCode."
  }
  try {
    return $Output | ConvertFrom-Json
  } catch {
    throw "The installed tray returned an invalid status document."
  }
}

# Remember the operator's existing choice before any source moves. The
# canonical installer refreshes an existing companion, but never installs one
# on a machine that did not already have it.
$TrayWasInstalled = (Get-TrayStatus).installed -eq $true

Write-Host "Publishing $sourceDir"
Write-Host "        to $installDir"

if ($PSCmdlet.ShouldProcess($installDir, "copy router source")) {
  # Copy without a blanket purge, then retire only files recorded by the prior
  # deployment. That removes renamed config fragments (the registry loads them
  # recursively) while preserving operator notes and unrelated target files.
  $CurrentDeployFiles = @(Get-DeploySourceFiles)
  $RobocopyArguments = @(
    $sourceDir,
    $installDir,
    "/E",
    "/COPY:DAT",
    "/DCOPY:DAT",
    "/R:2",
    "/W:1",
    "/XJ",
    "/XD",
    ".git",
    ".venv",
    "node_modules",
    "target",
    "dist",
    "release",
    "release-local"
  )
  & robocopy @RobocopyArguments
  $CopyExitCode = $LASTEXITCODE
  if ($CopyExitCode -gt 7) { throw "robocopy failed with exit code $CopyExitCode." }
  Update-DeployManifest $CurrentDeployFiles

  $TrayStoppedForDeploy = $false
  Push-Location $installDir
  try {
    # Tauri and Electron both update files held open by a running companion.
    # Stop an opted-in tray before either the canonical installer's best-effort
    # refresh or the strict verification below gets a chance to rebuild it.
    if ($TrayWasInstalled) {
      & node (Join-Path $installDir "src\tray-service.mjs") stop
      $TrayStopExitCode = $LASTEXITCODE
      if ($TrayStopExitCode -ne 0) {
        throw "Stopping the installed tray failed with exit code $TrayStopExitCode."
      }
      $TrayStoppedForDeploy = $true
    }

    # This is the supported update transaction: dependency fingerprints,
    # generated catalogs, client configuration, manifest, service health,
    # managed skills, and the optional existing tray all stay in one path. It
    # reads the current provider selection rather than replacing it.
    & (Join-Path $installDir "install.ps1") -CheckoutInstall -Target codex
    if (-not $?) { throw "The installed Codex Router update failed." }

    & node (Join-Path $installDir "src\doctor.mjs")
    $DoctorExitCode = $LASTEXITCODE
    if ($DoctorExitCode -ne 0) {
      throw "Codex Router doctor failed with exit code $DoctorExitCode."
    }

    if ($TrayWasInstalled) {
      # install.ps1 deliberately treats the optional companion as best effort.
      # This explicit working-tree deployment is stricter: re-run the installed
      # wrapper, propagate a failed build/registration, then prove Task
      # Scheduler points at the artifact selected by that wrapper.
      $SavedRouterTarget = $env:MODEL_ROUTER_TARGET
      try {
        $env:MODEL_ROUTER_TARGET = "codex"
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installDir "codex-router.ps1") tray install
        $TrayInstallExitCode = $LASTEXITCODE
        if ($TrayInstallExitCode -ne 0) {
          throw "Refreshing the installed tray failed with exit code $TrayInstallExitCode."
        }
      } finally {
        $env:MODEL_ROUTER_TARGET = $SavedRouterTarget
      }

      $TrayStatus = Get-TrayStatus
      if (-not $TrayStatus.installed -or -not $TrayStatus.loaded -or -not $TrayStatus.appPresent) {
        throw "The refreshed tray is not installed, running, and present on disk."
      }
      $ExpectedTrayPath = if (Get-Command cargo -ErrorAction SilentlyContinue) {
        Join-Path $installDir "apps\desktop\src-tauri\target\release\codex-router-desktop.exe"
      } else {
        Join-Path $installDir "apps\electron\node_modules\electron\dist\electron.exe"
      }
      $RegisteredTrayPath = [IO.Path]::GetFullPath([string]$TrayStatus.path)
      if (-not [string]::Equals(
        $RegisteredTrayPath,
        [IO.Path]::GetFullPath($ExpectedTrayPath),
        [StringComparison]::OrdinalIgnoreCase
      )) {
        throw "The refreshed tray registered an unexpected executable: $RegisteredTrayPath"
      }
      $TrayStoppedForDeploy = $false
    }
  } finally {
    if ($TrayWasInstalled -and $TrayStoppedForDeploy) {
      try {
        & node (Join-Path $installDir "src\tray-service.mjs") start
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "Deployment failed and the previous tray could not be restarted (exit $LASTEXITCODE)."
        }
      } catch {
        Write-Warning "Deployment failed and the previous tray could not be restarted: $($_.Exception.Message)"
      }
    }
    Pop-Location
  }
  Write-Host "Codex Router published, installed, and verified."
}
