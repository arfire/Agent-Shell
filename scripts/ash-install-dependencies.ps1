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
    $nodeVersion = (& node --version)
    Assert-NativeSuccess 'Node.js version check'
    $nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])
    if ($nodeMajor -lt 22) {
        throw "Node.js 22 or newer is required; found $nodeVersion."
    }

    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
    $env:COREPACK_HOME = Join-Path $cacheRoot 'corepack'
    $env:YARN_CACHE_FOLDER = Join-Path $cacheRoot 'yarn'
    $env:NPM_CONFIG_CACHE = Join-Path $cacheRoot 'npm'
    $env:ELECTRON_CACHE = Join-Path $cacheRoot 'electron-npmmirror'
    $env:electron_config_cache = $env:ELECTRON_CACHE
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    $env:Path = "$(Join-Path $repoRoot 'scripts\.bin');$env:Path"

    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        Write-Host "Preparing Yarn 1.22.22 with Corepack and Node $nodeVersion..."
        & corepack prepare yarn@1.22.22
        Assert-NativeSuccess 'Yarn preparation'
    }
    else {
        Write-Host "Corepack is unavailable; bootstrapping Yarn 1.22.22 with npx and Node $nodeVersion..."
        & npx --yes yarn@1.22.22 --version
        Assert-NativeSuccess 'Yarn bootstrap'
    }

    # Install the root toolchain without running Tabby's native rebuild. Ash has
    # safe fallbacks for the optional native integrations, so Visual Studio is
    # not required for source builds.
    Write-Host 'Installing the root build toolchain...'
    & yarn install --frozen-lockfile --ignore-scripts --network-timeout 1000000
    Assert-NativeSuccess 'Root dependency installation'

    $electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electronExe)) {
        Write-Host 'Downloading the Electron runtime...'
        & node 'node_modules\electron\install.js'
        Assert-NativeSuccess 'Electron runtime installation'
    }

    Write-Host 'Installing application, web and built-in module dependencies...'
    & node 'scripts\install-deps.mjs'
    Assert-NativeSuccess 'Workspace dependency installation'

    Write-Host 'Ash dependencies are ready.' -ForegroundColor Green
}
finally {
    Pop-Location
}
