#!/usr/bin/env pwsh
# The same installer, without a second shell or permission/settings implementation.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'tools/0code.mjs') install @args
exit $LASTEXITCODE
