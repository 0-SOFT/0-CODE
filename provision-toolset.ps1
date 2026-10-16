#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'tools/0code.mjs') install-tools @args
exit $LASTEXITCODE
