[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cacheRoot = Join-Path $repoRoot '.build-cache'

Push-Location $repoRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'app\dist\main.js'))) {
        throw 'Compiled files are missing. Run scripts\ash-build.ps1 first.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'))) {
        throw 'Electron is missing. Run scripts\ash-install-dependencies.ps1 first.'
    }

    $env:COREPACK_HOME = Join-Path $cacheRoot 'corepack'
    $env:YARN_CACHE_FOLDER = Join-Path $cacheRoot 'yarn'
    $env:NPM_CONFIG_CACHE = Join-Path $cacheRoot 'npm'
    # Keep development test runs isolated from %APPDATA% just like the
    # packaged portable ZIP. All persistent Electron and Ash state stays here.
    $env:TABBY_DATA_DIRECTORY = Join-Path $repoRoot 'data'
    $env:Path = "$(Join-Path $repoRoot 'scripts\.bin');$env:Path"

    Write-Host 'Starting Ash from source. Close the Ash window to return to this terminal.'
    & npm run prod
    if ($LASTEXITCODE -ne 0) {
        throw "Ash exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
