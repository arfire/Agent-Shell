[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cacheRoot = Join-Path $repoRoot '.build-cache'
$builderCache = Join-Path $cacheRoot 'electron-builder-manual'
$winCodeSignVersion = '2.6.0'
$winCodeSignRoot = Join-Path $builderCache "winCodeSign\winCodeSign-$winCodeSignVersion"
$signTool = Join-Path $winCodeSignRoot 'windows-10\x64\signtool.exe'

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

    $env:ARCH = 'x64'
    $env:COREPACK_HOME = Join-Path $cacheRoot 'corepack'
    $env:YARN_CACHE_FOLDER = Join-Path $cacheRoot 'yarn'
    $env:NPM_CONFIG_CACHE = Join-Path $cacheRoot 'npm'
    $env:ELECTRON_CACHE = Join-Path $cacheRoot 'electron-npmmirror'
    $env:ELECTRON_BUILDER_CACHE = $builderCache
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    $env:Path = "$(Join-Path $repoRoot 'scripts\.bin');$env:Path"

    # Compile first so packaging cannot accidentally reuse stale generated JS.
    & (Join-Path $PSScriptRoot 'ash-build.ps1')

    Write-Host 'Preparing built-in plugins...'
    & node 'scripts\prepackage-plugins.mjs'
    Assert-NativeSuccess 'Built-in plugin preparation'

    # electron-builder's Windows signing toolkit contains two macOS symlinks.
    # Standard Windows accounts cannot create them, although Windows packaging
    # only needs windows-10/x64. Pre-extracting the archive and verifying the
    # actual signing tool avoids requiring Administrator or Developer Mode.
    if (-not (Test-Path -LiteralPath $signTool)) {
        $downloadRoot = Join-Path $cacheRoot 'downloads'
        $archive = Join-Path $downloadRoot "winCodeSign-$winCodeSignVersion.7z"
        New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
        New-Item -ItemType Directory -Force -Path $winCodeSignRoot | Out-Null
        if (-not (Test-Path -LiteralPath $archive)) {
            $url = "https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-$winCodeSignVersion/winCodeSign-$winCodeSignVersion.7z"
            Write-Host "Downloading $url"
            Invoke-WebRequest -Uri $url -OutFile $archive
        }

        $sevenZip = Join-Path $repoRoot 'node_modules\7zip-bin\win\x64\7za.exe'
        if (-not (Test-Path -LiteralPath $sevenZip)) {
            throw '7-Zip helper is missing. Run scripts\ash-install-dependencies.ps1 first.'
        }
        & $sevenZip x -y -bd $archive "-o$winCodeSignRoot"
        # Exit code 1 is expected when the two unused macOS symlinks are skipped.
        if (-not (Test-Path -LiteralPath $signTool)) {
            throw "Windows signing helper extraction failed with exit code $LASTEXITCODE."
        }
    }

    Write-Host 'Packaging the Windows x64 portable ZIP...'
    & node 'scripts\build-windows.mjs'
    Assert-NativeSuccess 'Windows x64 packaging'

    $artifact = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'dist') -Filter 'tabby-*-portable-x64.zip' -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $artifact) {
        throw 'Packaging completed without producing a Windows x64 ZIP.'
    }

    Write-Host "Windows x64 package: $($artifact.FullName)" -ForegroundColor Green
}
finally {
    Pop-Location
}
