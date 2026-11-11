#!/bin/bash
# check-claim-ready.sh [max_seconds] [base_url]: open an unclaimed judge claim link in the deepsurge
# browser (own background tab) and fail unless the "Open this gift" button is present and enabled
# within max_seconds. Read-only: never clicks. Closes its tab.
set -u
MAX=${1:-6}; BASE=${2:-https://near-cachet.earn-shield-alerts.workers.dev}
cd "$(dirname "$0")/.."
port=$(jq -r .deepsurge.port ~/.local/share/bhn/ports.json)
# first judge link whose note is still claimable (claim set, owner not yet an implicit account)
for fr in $(jq -r '.[].fragment' web/judge-links.json); do
  tok=$(sed -E 's/.*token=([^&]+).*/\1/' <<<"$fr")
  args=$(printf '{"token_id":"%s"}' "$tok" | base64)
  claim=$(for rpc in https://near-testnet.drpc.org https://test.rpc.fastnear.com; do curl -s -m 15 $rpc -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"cachet.testnet\",\"method_name\":\"note\",\"args_base64\":\"$args\"}}" |
    jq -r '(.result.result // empty) | implode | fromjson | .claim // empty' && break; done | head -1)
  [ -n "$claim" ] && { FR=$fr; break; }
done
[ -n "${FR:-}" ] || { echo "FAIL: no unclaimed judge link left in web/judge-links.json"; exit 1; }
id=$(curl -s -m 10 -X PUT "http://127.0.0.1:$port/json/new?$BASE/claim?v=$RANDOM%23$FR" | jq -r .id)
[ -n "$id" ] && [ "$id" != null ] || { echo "FAIL: could not open a tab"; exit 1; }
trap 'curl -s -m 5 "http://127.0.0.1:$port/json/close/$id" >/dev/null' EXIT
start=$(date +%s)
while [ $(( $(date +%s) - start )) -le "$MAX" ]; do
  ok=$(bhn deepsurge use "$id" >/dev/null 2>&1 && bhn deepsurge eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/open this gift/i.test(x.textContent));return !!(b&&!b.disabled&&b.offsetParent!==null)})()" 2>/dev/null | jq -r .value)
  [ "$ok" = true ] && { echo "PASS: claim ready in $(( $(date +%s) - start ))s (token $tok)"; exit 0; }
  sleep 1
done
echo "FAIL: 'Open this gift' not ready within ${MAX}s (token $tok)"; exit 1
