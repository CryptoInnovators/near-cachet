#!/usr/bin/env bash
# Pull the mainnet contract code the sandbox tests run against, byte for byte, with a view_code call.
# Nothing here signs or spends: view_code is a read.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${NEAR_RPC:-https://rpc.mainnet.fastnear.com}"
OUT=fixtures/wasm
mkdir -p "$OUT"
fetch() { # <account> <file>
  local acct="$1" file="$OUT/$2" res
  [ -s "$file" ] && { echo "have $file"; return; }
  res=$(curl -sf -m 120 "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_code\",\"finality\":\"final\",\"account_id\":\"$acct\"}}")
  echo "$res" | jq -e '.result.code_base64' >/dev/null || { echo "view_code failed for $acct: $res" | head -c 300; exit 1; }
  echo "$res" | jq -r '.result.code_base64' | base64 -d > "$file"
  echo "$acct -> $file ($(wc -c < "$file") bytes) code_hash $(echo "$res" | jq -r '.result.hash') block $(echo "$res" | jq -r '.result.block_height')"
}
fetch intents.near intents.wasm
fetch wrap.near wrap_near.wasm
