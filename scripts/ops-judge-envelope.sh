#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

CONTRACT=${CONTRACT:-cachet.testnet}
OWNER=${OWNER:-cachet-ops.testnet}
NEARRPC=${NEARRPC:-https://near-testnet.drpc.org}
LINKS=${LINKS:-web/judge-links.json}
ALLOWANCE='0.15 NEAR'
MIN_ALLOWANCE='150000000000000000000000'
WAIT_SECONDS=${WAIT_SECONDS:-300}

[[ $CONTRACT == cachet.testnet && $NEARRPC == *testnet* ]] || { echo "Refusing non-testnet envelope setup" >&2; exit 1; }
command -v jq >/dev/null && command -v near >/dev/null || { echo "Install jq and near CLI first" >&2; exit 2; }

rpc() {
  local payload=$1 body
  for try in 1 2 3 4 5 6; do
    body=$(curl -fsS -m 20 "$NEARRPC" -H 'content-type: application/json' --data "$payload") || body=
    if jq -e '.error == null and .result != null' <<<"$body" >/dev/null 2>&1; then jq -c '.result' <<<"$body"; return; fi
    sleep "$try"
  done
  echo "NEAR RPC did not return a result" >&2
  return 1
}

view() {
  local method=$1 args=$2 encoded result
  encoded=$(printf '%s' "$args" | base64 | tr -d '\n')
  result=$(rpc "$(jq -cn --arg c "$CONTRACT" --arg m "$method" --arg a "$encoded" '{jsonrpc:"2.0",id:"cachet-envelope",method:"query",params:{request_type:"call_function",finality:"final",account_id:$c,method_name:$m,args_base64:$a}}')")
  jq -er '[.result[]] | implode | fromjson' <<<"$result"
}

note() { view note "$(jq -cn --arg t "$1" '{token_id:$t}')"; }

owned_token_ids() {
  local offset=0 page args
  while :; do
    args=$(jq -cn --arg o "$OWNER" --argjson i "$offset" '{account_id:$o,from_index:($i|tostring),limit:100}')
    page=$(view nft_tokens_for_owner "$args")
    jq -r '.[].token_id' <<<"$page"
    (( $(jq 'length' <<<"$page") < 100 )) && break
    offset=$((offset + 100))
  done
}

cleanup_claim_keys() {
  local mode=${1:-delete} tokens live_keys='[]' token live hex public_keys stale csv output tx_hash started status access candidates stale_count
  tokens=$(owned_token_ids)
  while IFS= read -r token; do
    [[ -n $token ]] || continue
    live=$(note "$token")
    hex=$(jq -r '.claim.key // empty' <<<"$live")
    [[ $hex =~ ^[0-9a-fA-F]{64}$ ]] || continue
    public_keys=$(node -e 'const c=require("./web/linkdrop-claim.js");process.stdout.write(`ed25519:${c.b58encode(Uint8Array.from(process.argv[1].match(/../g),x=>parseInt(x,16)))}`)' "$hex")
    live_keys=$(jq -c --arg p "$public_keys" '. + [$p]' <<<"$live_keys")
  done <<<"$tokens"

  access=$(rpc "$(jq -cn --arg a "$OWNER" '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_access_key_list",finality:"final",account_id:$a}}')")
  candidates=$(jq '[.keys[] | select((.access_key.permission | type) == "object") | select(.access_key.permission.FunctionCall.receiver_id == $c and .access_key.permission.FunctionCall.method_names == ["claim"])] | length' --arg c "$CONTRACT" <<<"$access")
  stale=$(jq -r --arg c "$CONTRACT" --argjson live "$live_keys" '.keys[] | select((.access_key.permission | type) == "object") | select(.access_key.permission.FunctionCall.receiver_id == $c and .access_key.permission.FunctionCall.method_names == ["claim"]) | select(.public_key as $p | ($live | index($p) | not)) | .public_key' <<<"$access")
  stale_count=0; [[ -z $stale ]] || stale_count=$(wc -l <<<"$stale" | tr -d ' ')
  if [[ $mode == check ]]; then
    if [[ -n $stale ]]; then echo "FAIL: $stale_count stale, $((candidates - stale_count)) of $candidates claim-only keys match live note claims" >&2; return 1; fi
    echo "PASS: 0 stale, $candidates claim-only keys match live note claims"
    return 0
  fi
  [[ -n $stale ]] || { echo "no stale claim-only keys for $OWNER"; return 0; }

  csv=$(tr '\n' ',' <<<"$stale" | sed 's/,$//')
  output=$(near account delete-keys "$OWNER" public-keys "$csv" network-config testnet sign-with-legacy-keychain send 2>&1) || { echo "$output" >&2; return 1; }
  tx_hash=$(sed -nE 's#.*(txns|transactions)/([1-9A-HJ-NP-Za-km-z]{40,}).*#\2#p; s/.*Transaction ID: ([1-9A-HJ-NP-Za-km-z]{40,}).*/\1/p' <<<"$output" | head -1)
  [[ $tx_hash =~ ^[1-9A-HJ-NP-Za-km-z]{40,}$ ]] || { echo "DeleteKey completed without a readable explorer transaction hash" >&2; return 1; }
  started=$(date +%s)
  while :; do
    status=$(rpc "$(jq -cn --arg h "$tx_hash" --arg a "$OWNER" '{jsonrpc:"2.0",id:1,method:"EXPERIMENTAL_tx_status",params:[$h,$a]}')")
    jq -e '.status.Failure == null' <<<"$status" >/dev/null || { echo "DeleteKey transaction $tx_hash failed" >&2; return 1; }
    [[ $(jq -r '.final_execution_status // empty' <<<"$status") == FINAL ]] && break
    (( $(date +%s) - started < WAIT_SECONDS )) || { echo "Timed out waiting for DeleteKey transaction $tx_hash to reach FINAL" >&2; return 1; }
    sleep 3
  done
  access=$(rpc "$(jq -cn --arg a "$OWNER" '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_access_key_list",finality:"final",account_id:$a}}')")
  while IFS= read -r public_keys; do
    [[ -n $public_keys ]] || continue
    jq -e --arg p "$public_keys" '.keys[] | select(.public_key == $p)' <<<"$access" >/dev/null && { echo "stale claim key remains live after DeleteKey" >&2; return 1; }
  done <<<"$stale"
  echo "deleted stale claim-only keys for $OWNER; final tx $tx_hash"
}

if [[ ${1:-} == cleanup || ${1:-} == check ]]; then
  (( $# == 1 )) || { echo "Usage: $0 {cleanup|check}" >&2; exit 2; }
  cleanup_claim_keys "${1}"
  exit
fi

if (( $# )); then
  (( $# == 3 )) || { echo "Usage: $0 [SEALED_TOKEN_1 SEALED_TOKEN_2 SEALED_TOKEN_3]" >&2; exit 2; }
  tokens=("$@")
else
  tokens=()
  while IFS= read -r token; do tokens+=("$token"); done < <(owned_token_ids)
fi

mkdir -p "$(dirname "$LINKS")"
[[ -e $LINKS ]] || echo '[]' > "$LINKS"
jq -e 'type == "array"' "$LINKS" >/dev/null || { echo "$LINKS must contain a JSON array" >&2; exit 1; }
cleanup_claim_keys
prepared=0
new_links='[]'

for token in "${tokens[@]}"; do
  [[ $token =~ ^[0-9]+$ ]] || continue
  live=$(note "$token")
  [[ $(jq -r '.state' <<<"$live") == Sealed && $(jq -r '.owner_id' <<<"$live") == "$OWNER" && $(jq -r '.utxo.sats // 0' <<<"$live") -gt 0 ]] || continue

  seed=
  if [[ $(jq -r '.claim.key // empty' <<<"$live") ]]; then
    seed=$(NOTE_JSON="$live" node -e 'const fs=require("fs"),c=require("./web/claim-lib.js"),t=process.argv[1],note=JSON.parse(process.env.NOTE_JSON);(async()=>{for(const x of JSON.parse(fs.readFileSync(process.argv[2],"utf8"))){const f=c.parseFragment(x.fragment);if(f?.token===t&&await c.publicKeyHexFromSeed(f.key)===note.claim.key){process.stdout.write(f.key);return}}})()' "$token" "$LINKS")
  else
    seed=$(node -e 'process.stdout.write(require("./web/claim-lib.js").newSeedHex())')
  fi
  [[ $seed =~ ^[0-9a-f]{64}$ ]] || { echo "No matching claim secret for funded note $token" >&2; exit 1; }
  pub=$(node -e 'require("./web/claim-lib.js").publicKeyHexFromSeed(process.argv[1]).then(x=>process.stdout.write(x))' "$seed")

  if [[ -z $(jq -r '.claim.key // empty' <<<"$live") ]]; then
    height=$(rpc '{"jsonrpc":"2.0","id":1,"method":"block","params":{"finality":"final"}}' | jq -er '.header.height')
    args=$(jq -cn --arg t "$token" --arg k "$pub" --argjson e "$((height + 86400))" '{token_id:$t,claim_key:$k,expires_at_block:$e}')
    near contract call-function as-transaction "$CONTRACT" create_claim json-args "$args" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config testnet sign-with-legacy-keychain send >/dev/null
    started=$(date +%s)
    while :; do
      live=$(note "$token")
      [[ $(jq -r '.claim.key // empty' <<<"$live") == "$pub" ]] && break
      (( $(date +%s) - started < WAIT_SECONDS )) || { echo "Timed out waiting for note $token claim link" >&2; exit 1; }
      sleep 5
    done
  else
    [[ $(jq -r '.claim.key' <<<"$live") == "$pub" ]] || { echo "Claim secret mismatch for note $token" >&2; exit 1; }
  fi

  pub_near=$(node -e 'const c=require("./web/linkdrop-claim.js");process.stdout.write(`ed25519:${c.b58encode(Uint8Array.from(process.argv[1].match(/../g),x=>parseInt(x,16)))}`)' "$pub")
  access_reply=$(curl -fsS -m 20 "$NEARRPC" -H 'content-type: application/json' --data "$(jq -cn --arg a "$OWNER" --arg p "$pub_near" '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_access_key",finality:"final",account_id:$a,public_key:$p}}')")
  access=$(jq -c '.result // empty' <<<"$access_reply")
  [[ $(jq -r '.error // empty' <<<"$access") ]] && access=
  if [[ -n $access ]]; then
    jq -e --arg c "$CONTRACT" '.permission.FunctionCall.receiver_id == $c and .permission.FunctionCall.method_names == ["claim"]' <<<"$access" >/dev/null || { echo "The existing key for note $token has a different permission" >&2; exit 1; }
    if ! node -e 'process.exit(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)' "$(jq -r '.permission.FunctionCall.allowance' <<<"$access")" "$MIN_ALLOWANCE"; then
      near account delete-keys "$OWNER" public-keys "$pub_near" network-config testnet sign-with-legacy-keychain send >/dev/null
      access=
    fi
  fi
  if [[ -z $access ]]; then
    near account add-key "$OWNER" grant-function-call-access --allowance "$ALLOWANCE" --contract-account-id "$CONTRACT" --function-names claim use-manually-provided-public-key "$pub_near" network-config testnet sign-with-legacy-keychain send >/dev/null
  fi
  started=$(date +%s)
  until jq -e --arg c "$CONTRACT" '.permission.FunctionCall.receiver_id == $c and .permission.FunctionCall.method_names == ["claim"] and ((.permission.FunctionCall.allowance | tonumber) > 0)' <<<"$access" >/dev/null 2>&1; do
    access_reply=$(curl -fsS -m 20 "$NEARRPC" -H 'content-type: application/json' --data "$(jq -cn --arg a "$OWNER" --arg p "$pub_near" '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_access_key",finality:"final",account_id:$a,public_key:$p}}')")
    access=$(jq -c '.result // empty' <<<"$access_reply")
    [[ $(jq -r '.error // empty' <<<"$access") ]] && access=
    (( $(date +%s) - started < WAIT_SECONDS )) || { echo "Timed out verifying claim-only key for note $token" >&2; exit 1; }
    sleep 5
  done
  jq -e --arg c "$CONTRACT" '.permission.FunctionCall.receiver_id == $c and .permission.FunctionCall.method_names == ["claim"]' <<<"$access" >/dev/null && node -e 'process.exit(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)' "$(jq -r '.permission.FunctionCall.allowance' <<<"$access")" "$MIN_ALLOWANCE" || { echo "The access key for note $token is not claim-only on $CONTRACT with the required allowance" >&2; exit 1; }

  fragment=$(node -e 'const c=require("./web/claim-lib.js");process.stdout.write(c.buildFragment({contract:process.argv[1],token:process.argv[2],key:process.argv[3],sender:process.argv[4]}))' "$CONTRACT" "$token" "$seed" "$OWNER")
  sats=$(jq -r '.utxo.sats' <<<"$live")
  new_links=$(jq -c --arg f "$fragment" --arg t "$token" --argjson s "$sats" '. + [{fragment:$f,token_id:$t,sats:$s}]' <<<"$new_links")
  prepared=$((prepared + 1))
  echo "ready share $prepared: note $token, $sats sats"
  (( prepared == 3 )) && break
done

(( prepared == 3 )) || { echo "Found only $prepared funded, sealed notes owned by $OWNER; three are required" >&2; exit 1; }
token_ids=$(jq -c '[.[].token_id]' <<<"$new_links")
jq --argjson ids "$token_ids" --argjson links "$new_links" '[.[] | select((.token_id // ((.fragment | capture("token=(?<id>[0-9]+)").id) // "")) as $id | ($ids | index($id) | not))] + $links' "$LINKS" > "$LINKS.tmp"
mv "$LINKS.tmp" "$LINKS"
echo "judge envelope ready: 3 funded shares in $LINKS"
