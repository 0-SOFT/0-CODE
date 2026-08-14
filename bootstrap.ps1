#!/usr/bin/env pwsh
# bootstrap.ps1 — thin Windows entry-point that delegates to bootstrap.sh
# via Git Bash. All heavy lifting (deep-merge, atomic writes, conflict
# resolution) happens in bootstrap.sh — keeping logic in one place.

$ErrorActionPreference = 'Stop'

# 1. Locate bash (Git for Windows preferred)
$bashCandidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe'
)

$bash = $null
foreach ($c in $bashCandidates) {
    if (Test-Path -LiteralPath $c) {
        $bash = $c
        break
    }
}
if (-not $bash) {
    $cmd = Get-Command bash -ErrorAction SilentlyContinue
    if ($cmd) { $bash = $cmd.Source }
}

if (-not $bash) {
    Write-Error @"
Git Bash was not found. Install Git for Windows: https://gitforwindows.org/

If Git for Windows lives in a non-standard location, add bash.exe to PATH
or edit this script.
"@
    exit 1
}

# 2. Locate bootstrap.sh next to this script
$bootstrapSh = Join-Path $PSScriptRoot 'bootstrap.sh'
if (-not (Test-Path -LiteralPath $bootstrapSh)) {
    Write-Error "bootstrap.sh not found next to bootstrap.ps1 (expected: $bootstrapSh)"
    exit 1
}

# 3. Delegate (passes through positional args; current working dir is preserved)
& $bash $bootstrapSh @args
exit $LASTEXITCODE
