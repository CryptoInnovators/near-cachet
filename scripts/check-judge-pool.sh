#!/usr/bin/env bash
# Fails unless web/judge-links.json lists at least MIN notes that a judge can claim right now.
set -euo pipefail
cd "$(dirname "$0")/.."

FILE=${FILE:-web/judge-links.json}
MIN=${MIN:-2}
OWNER=${OWNER:-cachet-ops.testnet}
NEARRPC=${NEARRPC:-https://test.rpc.fastnear.com}
ESPLORA=${ESPLORA:-https://blockstream.info/testnet/api}

view() {
  local contract=$1 method=$2 args=$3 encoded
  encoded=$(printf '%s' "$args" | base64 | tr -d '\n')
  curl -fsS -m 30 "$NEARRPC" -H 'content-type: application/json' \
    --data "$(jq -cn --arg c "$contract" --arg m "$method" --arg a "$encoded" '{jsonrpc:"2.0",id:"cachet",method:"query",params:{request_type:"call_function",finality:"final",account_id:$c,method_name:$m,args_base64:$a}}')" \
    | jq -er '[.result.result[]] | implode | fromjson'
}

[[ -f $FILE ]] || { echo "FAIL: $FILE is missing" >&2; exit 1; }
count=$(jq 'length' "$FILE")
(( count >= MIN )) || { echo "FAIL: $FILE lists $count notes, need $MIN" >&2; exit 1; }

head_block=$(curl -fsS -m 30 "$NEARRPC" -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"block","params":{"finality":"final"}}' | jq -er '.result.header.height')
ok=0
for i in $(seq 0 $((count - 1))); do
  fragment=$(jq -er ".[$i].fragment" "$FILE")
  read -r contract token seed < <(node -e 'const f=require("./web/claim-lib.js").parseFragment(process.argv[1]); if(!f) process.exit(1); console.log(f.contract,f.token,f.key)' "$fragment") \
    || { echo "FAIL: entry $i has an unparsable fragment" >&2; exit 1; }
  pub=$(node -e 'require("./web/claim-lib.js").publicKeyHexFromSeed(process.argv[1]).then(x=>process.stdout.write(x))' "$seed")
  n=$(view "$contract" note "$(jq -cn --arg t "$token" '{token_id:$t}')")
  [[ $(jq -r '.state' <<<"$n") == Sealed ]] || { echo "FAIL: $contract note $token is $(jq -r '.state' <<<"$n")" >&2; exit 1; }
  [[ $(jq -r '.owner_id' <<<"$n") == "$OWNER" ]] || { echo "FAIL: note $token owner is $(jq -r '.owner_id' <<<"$n")" >&2; exit 1; }
  [[ $(jq -r '.claim.key' <<<"$n") == "$pub" ]] || { echo "FAIL: note $token claim key does not match the link secret" >&2; exit 1; }
  (( $(jq -r '.claim.expires_at_block // .claim.expiry // 0' <<<"$n") > head_block )) || { echo "FAIL: note $token claim lock already expired" >&2; exit 1; }
  txid=$(jq -r '.utxo.txid' <<<"$n"); vout=$(jq -r '.utxo.vout' <<<"$n")
  tx=$(curl -fsS -m 30 "$ESPLORA/tx/$txid")
  [[ $(jq -r '.status.block_hash' <<<"$tx") == $(jq -r '.utxo.block_hash' <<<"$n") ]] || { echo "FAIL: note $token block hash differs from the explorer" >&2; exit 1; }
  [[ $(jq -r ".vout[$vout].scriptpubkey_address" <<<"$tx") == $(jq -r '.address' <<<"$n") && $(jq -r ".vout[$vout].value" <<<"$tx") == $(jq -r '.utxo.sats' <<<"$n") ]] || { echo "FAIL: note $token funding output does not match the explorer" >&2; exit 1; }
  echo "ok: note $token $(jq -r '.utxo.sats' <<<"$n") sats at $(jq -r '.address' <<<"$n") block $(jq -r '.utxo.block_hash' <<<"$n" | cut -c1-16)"
  ok=$((ok + 1))
done
echo "judge pool: $ok sealed, claimable notes"
