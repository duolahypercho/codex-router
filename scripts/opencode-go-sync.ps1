$ErrorActionPreference = 'Stop'
$routerRoot = Split-Path -Parent $PSScriptRoot
$statusPath = Join-Path $env:USERPROFILE '.codex\codex-router\opencode-go-sync.log'
$started = (Get-Date).ToUniversalTime().ToString('o')
try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $output = & $node (Join-Path $routerRoot 'src\opencode-go-sync.mjs') --apply 2>&1
    $code = $LASTEXITCODE
    @("$started exit=$code", ($output | Out-String).TrimEnd()) |
        Set-Content -LiteralPath $statusPath -Encoding UTF8
    exit $code
} catch {
    @("$started exit=1", $_.Exception.Message) |
        Set-Content -LiteralPath $statusPath -Encoding UTF8
    exit 1
}
