[CmdletBinding()]
param(
    [string[]] $Plugins = @('tabby-terminal', 'tabby-ai'),
    [switch] $App,
    [switch] $Production,
    [switch] $SkipTypings,
    [switch] $Package
)

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

function Assert-ChildPath ([string] $Parent, [string] $Child) {
    $resolvedParent = (Resolve-Path -LiteralPath $Parent).Path.TrimEnd('\')
    $resolvedChild = [System.IO.Path]::GetFullPath($Child)
    if (-not $resolvedChild.StartsWith($resolvedParent + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside $resolvedParent`: $resolvedChild"
    }
}

function Assert-PluginName ([string] $Plugin) {
    if ($Plugin -notmatch '^tabby-[a-z0-9-]+$') {
        throw "Invalid plugin name for fast build: $Plugin"
    }
}

function Sync-BuiltinPlugin ([string] $Plugin) {
    Assert-PluginName $Plugin
    $source = Join-Path $repoRoot $Plugin
    if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) {
        throw "Plugin not found: $Plugin"
    }

    $targetRoot = Join-Path $repoRoot 'builtin-plugins'
    $target = Join-Path $targetRoot $Plugin
    if (-not (Test-Path -LiteralPath $targetRoot)) {
        throw 'builtin-plugins is missing. Run scripts\ash-package-windows-x64.ps1 once before using fast packaging.'
    }
    Assert-ChildPath $targetRoot $target
    New-Item -ItemType Directory -Force -Path $target | Out-Null

    Write-Host "Syncing $Plugin into builtin-plugins..."
    & robocopy $source $target /MIR /XD node_modules .git .webpack-cache /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) {
        throw "Syncing $Plugin failed with robocopy exit code $LASTEXITCODE."
    }
    $global:LASTEXITCODE = 0

    Push-Location $target
    try {
        Write-Host "Refreshing production dependencies for $Plugin..."
        & yarn install --force --production
        Assert-NativeSuccess "$Plugin production dependency install"
    }
    finally {
        Pop-Location
    }
}

Push-Location $repoRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
        throw 'Dependencies are missing. Run scripts\ash-install-dependencies.ps1 first.'
    }

    $env:ARCH = 'x64'
    if ($Production -or $Package) {
        Remove-Item Env:\TABBY_DEV -ErrorAction SilentlyContinue
    } else {
        $env:TABBY_DEV = if ($env:TABBY_DEV) { $env:TABBY_DEV } else { '1' }
    }
    $env:COREPACK_HOME = Join-Path $cacheRoot 'corepack'
    $env:YARN_CACHE_FOLDER = Join-Path $cacheRoot 'yarn'
    $env:NPM_CONFIG_CACHE = Join-Path $cacheRoot 'npm'
    $env:ELECTRON_CACHE = Join-Path $cacheRoot 'electron-npmmirror'
    $env:ELECTRON_BUILDER_CACHE = $builderCache
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    $env:Path = "$(Join-Path $repoRoot 'scripts\.bin');$env:Path"

    foreach ($plugin in $Plugins) {
        Assert-PluginName $plugin
    }

    $buildArgs = @('scripts\build-fast.mjs', '--plugins', ($Plugins -join ','))
    if ($App) {
        $buildArgs += '--app'
    }
    if ($Production -or $Package) {
        $buildArgs += '--production'
    }
    if ($SkipTypings) {
        $buildArgs += '--no-typings'
    }

    Write-Host "Fast compiling: $($Plugins -join ', ')"
    & node @buildArgs
    Assert-NativeSuccess 'Fast Ash compilation'
    Write-Host 'Fast compilation completed.' -ForegroundColor Green

    if ($Package) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'app\dist\main.js'))) {
            throw 'app\dist\main.js is missing. Re-run with -App or run scripts\ash-build.ps1 once first.'
        }
        foreach ($plugin in $Plugins) {
            Sync-BuiltinPlugin $plugin
        }
        # Fast packaging rebuilds only selected plugins, but every bundled
        # manifest must still advertise the common Tabby base version.
        foreach ($bundledPlugin in Get-ChildItem -LiteralPath (Join-Path $repoRoot 'builtin-plugins') -Directory) {
            $sourceManifest = Join-Path (Join-Path $repoRoot $bundledPlugin.Name) 'package.json'
            $targetManifest = Join-Path $bundledPlugin.FullName 'package.json'
            if (Test-Path -LiteralPath $sourceManifest) {
                Copy-Item -LiteralPath $sourceManifest -Destination $targetManifest -Force
            }
        }

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
            if (-not (Test-Path -LiteralPath $signTool)) {
                throw "Windows signing helper extraction failed with exit code $LASTEXITCODE."
            }
        }

        Write-Host 'Fast packaging Windows x64 portable ZIP from current build outputs...'
        & node 'scripts\build-windows.mjs'
        Assert-NativeSuccess 'Fast Windows x64 packaging'

        $artifact = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'dist') -Filter 'tabby-*-portable-x64.zip' -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if (-not $artifact) {
            throw 'Packaging completed without producing a Windows x64 ZIP.'
        }

        Write-Host "Windows x64 package: $($artifact.FullName)" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
