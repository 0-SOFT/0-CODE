#!/usr/bin/env pwsh
# telegram-notify.ps1 — PowerShell parallel of telegram-notify.sh.
# Use from PS contexts where bash isn't convenient (e.g. bootstrap.ps1 path).
#
# Env required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# Usage: pwsh telegram-notify.ps1 "<subject>" "<body>"

param(
    [Parameter(Mandatory=$true, Position=0)][string]$Subject,
    [Parameter(Mandatory=$true, Position=1)][string]$Body
)

$ErrorActionPreference = 'Stop'

$token = $env:TELEGRAM_BOT_TOKEN
$chat = $env:TELEGRAM_CHAT_ID

if (-not $token -or -not $chat) {
    Write-Error "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set"
    exit 1
}

$message = "<b>$Subject</b>`n$Body"

try {
    $resp = Invoke-RestMethod -Method POST `
        -Uri "https://api.telegram.org/bot$token/sendMessage" `
        -Body @{
            chat_id = $chat
            parse_mode = "HTML"
            text = $message
        }
    if (-not $resp.ok) {
        Write-Error "Telegram returned: $($resp | ConvertTo-Json -Compress)"
        exit 1
    }
    exit 0
} catch {
    Write-Error "telegram-notify failed: $_"
    exit 1
}
