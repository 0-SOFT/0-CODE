#!/usr/bin/env pwsh
# provision-toolset.ps1 — a thin Windows entry point that delegates to provision-toolset.sh via Git Bash.
# All the logic lives in provision-toolset.sh (a single place). Arguments are passed through as is.

$ErrorActionPreference = 'Stop'

$bashCandidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe'
)
$bash = $null
foreach ($c in $bashCandidates) { if (Test-Path -LiteralPath $c) { $bash = $c; break } }
if (-not $bash) { $cmd = Get-Command bash -ErrorAction SilentlyContinue; if ($cmd) { $bash = $cmd.Source } }
if (-not $bash) {
    Write-Error "Git Bash was not found. Install Git for Windows: https://gitforwindows.org/"
    exit 1
}

$sh = Join-Path $PSScriptRoot 'provision-toolset.sh'
if (-not (Test-Path -LiteralPath $sh)) {
    Write-Error "provision-toolset.sh was not found next to provision-toolset.ps1 (expected: $sh)"
    exit 1
}

& $bash $sh @args
exit $LASTEXITCODE
