#!/bin/bash
# check-claim-ready.sh [min_open]: fail unless web/judge-links.json lists at least min_open (default 3)
# notes that a Telegram judge can still take: the note is on-chain Sealed with an open claim key on the
# live heir contract, and the Bitcoin output behind it is unspent. Read-only.
set -u
MIN=${1:-3}; RPC=${NEARRPC:-https://archival-rpc.testnet.near.org}
cd "$(dirname "$0")/.."
open=0
for fr in $(jq -r '.[].fragment' web/judge-links.json); do
  tok=$(sed -E 's/.*token=([^&]+).*/\1/' <<<"$fr"); con=$(sed -E 's/.*contract=([^&]+).*/\1/' <<<"$fr")
  args=$(printf '{"token_id":"%s"}' "$tok" | base64)
  note=$(curl -s -m 20 "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$con\",\"method_name\":\"note\",\"args_base64\":\"$args\"}}" |
    jq -c '(.result.result // empty) | implode | fromjson')
  [ -n "$note" ] || { echo "FAIL: could not read note $tok on $con"; exit 1; }
  state=$(jq -r .state <<<"$note"); claim=$(jq -r '.claim.key // empty' <<<"$note")
  if [ "$state" = Sealed ] && [ -n "$claim" ]; then
    spent=$(curl -s -m 20 "https://blockstream.info/testnet/api/tx/$(jq -r .utxo.txid <<<"$note")/outspend/$(jq -r .utxo.vout <<<"$note")" | jq -r .spent)
    [ "$spent" = false ] && { open=$((open + 1)); echo "open: note $tok $(jq -r .utxo.sats <<<"$note") sats"; continue; }
  fi
  echo "taken: note $tok ($state)"
done
[ "$open" -ge "$MIN" ] && { echo "PASS: $open open notes (need $MIN)"; exit 0; }
echo "FAIL: $open open notes in web/judge-links.json, need $MIN"; exit 1
