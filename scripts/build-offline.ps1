[CmdletBinding()]
param(
    [ValidateSet('dev', 'build', 'release')]
    [string]$Mode = 'build'
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$webDirectory = Join-Path $repoRoot 'apps\web'
$previousOfflineSetting = $env:CARGO_NET_OFFLINE
$exitCode = 0

Push-Location $webDirectory
try {
    $env:CARGO_NET_OFFLINE = 'true'
    switch ($Mode) {
        'dev' { & pnpm tauri dev }
        'build' { & pnpm tauri build }
        'release' { & pnpm release }
    }
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    if ($null -eq $previousOfflineSetting) {
        Remove-Item Env:CARGO_NET_OFFLINE -ErrorAction SilentlyContinue
    }
    else {
        $env:CARGO_NET_OFFLINE = $previousOfflineSetting
    }
}

exit $exitCode
