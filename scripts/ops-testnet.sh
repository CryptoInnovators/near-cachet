#!/usr/bin/env bash
# Operator tooling for the testnet judge pool: notes on cachet.testnet owned by cachet-ops.testnet,
# each sealed by the Bitcoin light client and carrying a claim link listed in web/judge-links.json.
# Usage: ops-testnet.sh {mint|status|seal TOKEN|link TOKEN}
set -euo pipefail
cd "$(dirname "$0")/.."

CONTRACT=${CONTRACT:-cachet.testnet}
OWNER=${OWNER:-cachet-ops.testnet}
NEARRPC=${NEARRPC:-https://test.rpc.fastnear.com}
NETCFG=${NETCFG:-testnet}
ESPLORA=${ESPLORA:-https://blockstream.info/testnet/api}
LINKS=${LINKS:-web/judge-links.json}
CLAIM_BLOCKS=${CLAIM_BLOCKS:-2500000}

view() {
  local method=$1 args=$2 encoded body try
  encoded=$(printf '%s' "$args" | base64 | tr -d '\n')
  for try in 1 2 3 4 5 6; do # the shared public RPC answers 429 under load
    body=$(curl -sS -m 30 "$NEARRPC" -H 'content-type: application/json' \
      --data "$(jq -cn --arg c "$CONTRACT" --arg m "$method" --arg a "$encoded" '{jsonrpc:"2.0",id:"cachet",method:"query",params:{request_type:"call_function",finality:"final",account_id:$c,method_name:$m,args_base64:$a}}')") || body=
    jq -e '.result.result' <<<"$body" >/dev/null 2>&1 && { jq -er '[.result.result[]] | implode | fromjson' <<<"$body"; return; }
    sleep $((try * 5))
  done
  echo "view $method failed: $body" >&2; return 1
}
note() { view note "$(jq -cn --arg t "$1" '{token_id:$t}')"; }
call() { # METHOD ARGS DEPOSIT
  near contract call-function as-transaction "$CONTRACT" "$1" json-args "$2" prepaid-gas '300 Tgas' attached-deposit "$3" \
    sign-as "$OWNER" network-config "$NETCFG" sign-with-legacy-keychain send
}

case ${1:-} in
  mint)
    out=$(call mint_note '{}' '0.03 NEAR' 2>&1)
    id=$(grep -A1 'return value' <<<"$out" | tail -1 | tr -d '"[:space:]')
    [[ $id =~ ^[0-9]+$ ]] || { echo "mint_note returned no token id" >&2; echo "$out" >&2; exit 1; }
    for _ in $(seq 1 24); do [[ $(note "$id" | jq -r '.state') == Minted ]] && break; sleep 5; done
    [[ $(note "$id" | jq -r '.state') == Minted ]] || { echo "note $id is not Minted" >&2; exit 1; }
    printf '%s %s\n' "$id" "$(note "$id" | jq -r '.address')"
    ;;
  status)
    for t in $(view nft_tokens_for_owner "$(jq -cn --arg o "$OWNER" '{account_id:$o}')" | jq -r '.[].token_id'); do
      n=$(note "$t")
      printf '%s %s %s %s\n' "$t" "$(jq -r '.state' <<<"$n")" "$(jq -r '.address' <<<"$n")" "$(jq -r '.claim.key // "-"' <<<"$n" | cut -c1-12)"
    done
    ;;
  seal)
    t=${2:?token}
    addr=$(note "$t" | jq -r '.address')
    txid=$(curl -fsS -m 30 --retry 6 --retry-all-errors --retry-delay 10 "$ESPLORA/address/$addr/txs" | jq -er '[.[] | select(.status.confirmed)] | first | .txid')
    MEMPOOL=$ESPLORA NETCFG=$NETCFG TOKEN=$t OWNER=$OWNER CONTRACT=$CONTRACT scripts/e2e-testnet-gift.sh attest "$txid"
    echo "sealed $t with $txid"
    ;;
  link)
    t=${2:?token}
    n=$(note "$t")
    [[ $(jq -r '.state' <<<"$n") == Sealed ]] || { echo "note $t is not Sealed" >&2; exit 1; }
    seed=$(node -e 'process.stdout.write(require("./web/claim-lib.js").newSeedHex())')
    pub=$(node -e 'require("./web/claim-lib.js").publicKeyHexFromSeed(process.argv[1]).then(x=>process.stdout.write(x))' "$seed")
    height=$(curl -fsS -m 30 "$NEARRPC" -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"block","params":{"finality":"final"}}' | jq -er '.result.header.height')
    call create_claim "$(jq -cn --arg t "$t" --arg k "$pub" --argjson e $((height + CLAIM_BLOCKS)) '{token_id:$t,claim_key:$k,expires_at_block:$e}')" '0 NEAR' >/dev/null
    for _ in $(seq 1 24); do [[ $(note "$t" | jq -r '.claim.key') == "$pub" ]] && break; sleep 5; done
    [[ $(note "$t" | jq -r '.claim.key') == "$pub" ]] || { echo "claim key post-condition failed for $t" >&2; exit 1; }
    fragment=$(node -e 'process.stdout.write(require("./web/claim-lib.js").buildFragment({contract:process.argv[1],token:process.argv[2],key:process.argv[3]}))' "$CONTRACT" "$t" "$seed")
    [[ -f $LINKS ]] || echo '[]' > "$LINKS"
    jq --arg f "$fragment" '. + [{fragment:$f}]' "$LINKS" > "$LINKS.tmp" && mv "$LINKS.tmp" "$LINKS"
    echo "linked $t"
    ;;
  *) echo "Usage: $0 {mint|status|seal TOKEN|link TOKEN}" >&2; exit 2 ;;
esac
