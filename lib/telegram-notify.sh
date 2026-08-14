#!/usr/bin/env bash
# telegram-notify.sh — send a notification via Telegram Bot API.
#
# Env required:
#   TELEGRAM_BOT_TOKEN  — bot token from @BotFather
#   TELEGRAM_CHAT_ID    — target chat ID
#
# Usage: telegram-notify.sh "<subject>" "<body>"
#
# Exit: 0 on send success, non-zero on failure. Suitable for piping || true.

set -uo pipefail

SUBJECT="${1:-untitled}"
BODY="${2:-empty}"

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID not set}"

# Escape special MarkdownV2 chars in subject and body if needed; for simplicity
# use plain HTML mode instead (less escape requirements).
MESSAGE="<b>${SUBJECT}</b>
${BODY}"

# IMPORTANT: the bot token is part of the URL. We do NOT redirect curl's stderr into a variable
# (no 2>&1) and we do NOT print the raw response or URL — otherwise the token could leak into
# process manager logs and into git. The Telegram API response body carries no token, but we still
# never print it.
RESPONSE=$(curl -fsS -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "parse_mode=HTML" \
  --data-urlencode "text=${MESSAGE}") || {
    echo "telegram-notify: POST failed (network/HTTP error)" >&2
    exit 1
  }

# Check for ok:true. Error messages stay generic — no response body and no URL in the output.
if ! printf '%s' "$RESPONSE" | grep -q '"ok":true'; then
  echo "telegram-notify: Telegram API returned error (ok != true)" >&2
  exit 1
fi

exit 0
