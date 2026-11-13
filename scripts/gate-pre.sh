#!/usr/bin/env bash
# Real Telegram gate: the WORK Telethon session posts /link and /envelope in a test group with the bot, requests the
# signed Mini App launch URL (messages.RequestAppWebViewRequest), then the page runs inside that launch: claim,
# "Steal this link" (refused on chain), "Open as the named heir" (sweep readable on Bitcoin testnet).
# Never prints the session, claim keys or the launch URL. Log goes to stdout and .progress/design/gate/tma-run.log.
set -euo pipefail
cd "$(dirname "$0")/.."
ORIGIN=${CACHET_ORIGIN:-https://near-cachet.earn-shield-alerts.workers.dev}
PY=${TELEGRAM_PY:-$HOME/Developer/telegram-mcp/.venv/bin/python}
OUT=.progress/design/gate; mkdir -p "$OUT/tma"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"
redact() { sed -E 's/tgWebApp[A-Za-z]*=[^& "]*/tgWebApp…=<redacted>/g; s/key=[0-9a-f]{64}/key=<redacted>/g; s/https:\/\/[^ ]*tgWebApp[^ ]*/<launch-url>/g'; }
{
  "$PY" -I scripts/gate-pre.py "$tmp/launch.url" 2>&1 | redact
  [ -s "$tmp/launch.url" ] || { echo "FAIL: no launch URL"; exit 1; }
  node scripts/e2e-ui.mjs --base "$ORIGIN" --miniapp "$tmp/launch.url" --heir --min-open "${MIN_OPEN:-1}" --shots "$OUT/tma" 2>&1 | redact
} | tee "$OUT/tma-run.log"
