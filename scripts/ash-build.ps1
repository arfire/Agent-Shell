[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cacheRoot = Join-Path $repoRoot '.build-cache'

function Assert-NativeSuccess ([string] $step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$step failed with exit code $LASTEXITCODE."
    }
}

Push-Location $repoRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
        throw 'Dependencies are missing. Run scripts\ash-install-dependencies.ps1 first.'
    }

    $env:COREPACK_HOME = Join-Path $cacheRoot 'corepack'
    $env:YARN_CACHE_FOLDER = Join-Path $cacheRoot 'yarn'
    $env:NPM_CONFIG_CACHE = Join-Path $cacheRoot 'npm'
    $env:Path = "$(Join-Path $repoRoot 'scripts\.bin');$env:Path"

    Write-Host 'Compiling Ash and every built-in module...'
    & npm run build
    Assert-NativeSuccess 'Ash compilation'
    Write-Host 'Ash compilation completed.' -ForegroundColor Green
}
finally {
    Pop-Location
}
