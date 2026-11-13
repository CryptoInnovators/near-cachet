#!/usr/bin/env bash
set -euo pipefail

CONTRACT=${CONTRACT:-cachet.testnet}
TOKEN=${TOKEN:-1}
OWNER=${OWNER:-cachet-ops.testnet}
HOLDER=${HOLDER:-cachet-holder-1104.testnet}
NEARRPC=${NEARRPC:-https://test.rpc.fastnear.com}
MEMPOOL=${MEMPOOL:-https://mempool.space/testnet/api}
NETCFG=${NETCFG:-testnet-fast}
SEED_FILE=${CACHET_SEED_FILE:-$HOME/.config/cachet/claim-seed}

usage() { echo "Usage: $0 {proof TXID|attest TXID|link|claim|unseal DEST FEE_RATE|broadcast|finalize SWEEP_TXID}" >&2; }
view() {
  local method=$1 args=$2 encoded
  encoded=$(printf '%s' "$args" | base64 | tr -d '\n')
  curl -fsS "$NEARRPC" -H 'content-type: application/json' \
    --data "$(jq -cn --arg method "$method" --arg args "$encoded" --arg account "$CONTRACT" '{jsonrpc:"2.0",id:"cachet",method:"query",params:{request_type:"call_function",finality:"final",account_id:$account,method_name:$method,args_base64:$args}}')" \
    | jq -er '[.result.result[]] | implode | fromjson'
}
note() { view note "$(jq -cn --arg token "$TOKEN" '{token_id:$token}')"; }
mempool_json() { sleep 1; curl -fsS --retry 6 --retry-all-errors --retry-delay 10 "$MEMPOOL$1"; } # esplora answers 429 under load
mempool_text() { sleep 1; curl -fsS --retry 6 --retry-all-errors --retry-delay 10 "$MEMPOOL$1"; }
# Wait until the contract's light client main chain holds HEIGHT; the light client lags the explorer.
wait_light_client() {
  local lc; lc=$(view config '{}' | jq -r '.btc_light_client')
  for _ in $(seq 1 160); do
    [[ $(curl -fsS "$NEARRPC" -H 'content-type: application/json' --data "$(jq -cn --arg lc "$lc" --arg a "$(printf '{"height":%s}' "$1" | base64)" '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:$lc,method_name:"get_block_hash_by_height",args_base64:$a}}')" | jq -r '(.result.result // []) | implode') =~ ^\"[0-9a-f]{64}\"$ ]] && return 0 # a missing height answers the JSON text null
    sleep 15
  done
  echo "Light client $lc does not hold block $1 after 40 minutes" >&2; return 1
}
proof_json() {
  local txid=$1 tx block proof coinbase cproof raw vout address
  tx=$(mempool_json "/tx/$txid")
  jq -e '.status.confirmed == true and (.status.block_hash | type == "string")' <<<"$tx" >/dev/null || { echo "Transaction $txid is not confirmed" >&2; return 1; }
  block=$(jq -r '.status.block_hash' <<<"$tx")
  proof=$(mempool_json "/tx/$txid/merkle-proof")
  coinbase=$(mempool_text "/block/$block/txid/0" | tr -d '\r\n')
  cproof=$(mempool_json "/tx/$coinbase/merkle-proof")
  raw=$(mempool_text "/tx/$txid/hex" | tr -d '\r\n')
  address=$(jq -r '.address' <<<"$(note)")
  vout=$(jq -c --arg address "$address" '[.vout[].scriptpubkey_address] | index($address)' <<<"$tx")
  jq -ecn --arg raw "$raw" --arg block "$block" --arg coinbase "$coinbase" --argjson vout "$vout" \
    --argjson index "$(jq -er '.pos' <<<"$proof")" --argjson merkle "$(jq -ec '.merkle' <<<"$proof")" \
    --argjson cmerkle "$(jq -ec '.merkle' <<<"$cproof")" \
    '{raw_tx:$raw,vout:$vout,proof:{block_hash:$block,tx_index:$index,merkle_proof:$merkle,coinbase_tx_id:$coinbase,coinbase_merkle_proof:$cmerkle}}'
}
tx_call() {
  local account=$1 method=$2 args=$3
  near contract call-function as-transaction "$CONTRACT" "$method" json-args "$args" \
    prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as "$account" \
    network-config "$NETCFG" sign-with-legacy-keychain send
}
wait_note() {
  local wanted=$1 timeout=$2 start now result
  start=$(date +%s)
  while :; do
    result=$(note)
    [[ $(jq -r '.state' <<<"$result") == "$wanted" ]] && { printf '%s\n' "$result"; return 0; }
    now=$(date +%s)
    if (( now - start >= timeout )); then printf '%s\n' "$result" >&2; echo "Timed out waiting for $wanted" >&2; return 1; fi
    sleep 5
  done
}

[[ $# -ge 1 ]] || { usage; exit 2; }
case $1 in
  proof)
    [[ $# == 2 ]] || { usage; exit 2; }
    proof_json "$2"
    ;;
  attest)
    [[ $# == 2 ]] || { usage; exit 2; }
    p=$(proof_json "$2")
    jq -e '.vout != null' <<<"$p" >/dev/null || { echo "No output of $2 pays the note address" >&2; exit 1; }
    # attest needs config.confirmations blocks on the light client, counting the funding block
    wait_light_client $(( $(mempool_json "/tx/$2" | jq -er '.status.block_height') + $(view config '{}' | jq -er '.confirmations') - 1 )) || exit 1
    args=$(jq -c --arg token "$TOKEN" --argjson p "$p" '{token_id:$token,raw_tx:$p.raw_tx,vout:$p.vout,proof:$p.proof}' <<< '{}')
    tx_call "$OWNER" attest "$args"
    n=$(wait_note Sealed 120)
    [[ $(jq -r '.utxo.txid' <<<"$n") == "$2" && $(jq -r '.utxo.block_hash' <<<"$n") == $(jq -r '.proof.block_hash' <<<"$p") ]] || { echo "Attest post-condition failed: $n" >&2; exit 1; }
    ;;
  link)
    mkdir -p "$(dirname "$SEED_FILE")"
    [[ ! -e $SEED_FILE ]] || { echo "Refusing to overwrite $SEED_FILE" >&2; exit 1; }
    umask 077
    seed=$(node -e 'const c=require("./web/claim-lib.js"); process.stdout.write(c.newSeedHex())')
    (umask 077; printf '%s' "$seed" > "$SEED_FILE")
    chmod 600 "$SEED_FILE"
    pub=$(node -e 'const c=require("./web/claim-lib.js"); c.publicKeyHexFromSeed(process.argv[1]).then(x=>process.stdout.write(x))' "$seed")
    fragment=$(node -e 'const c=require("./web/claim-lib.js"),p=new URLSearchParams(c.buildFragment({contract:process.argv[1],token:process.argv[2],key:process.argv[3]}));p.delete("key");process.stdout.write(p.toString())' "$CONTRACT" "$TOKEN" "$pub")
    height=$(curl -fsS "$NEARRPC" -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":"cachet","method":"block","params":{"finality":"final"}}' | jq -er '.result.header.height')
    expires=$((height + 3700))
    tx_call "$OWNER" create_claim "$(jq -cn --arg token "$TOKEN" --arg key "$pub" --argjson expiry "$expires" '{token_id:$token,claim_key:$key,expires_at_block:$expiry}')"
    for _ in $(seq 1 24); do [[ $(jq -r '.claim.key' <<<"$(note)") == "$pub" ]] && break; sleep 5; done
    [[ $(jq -r '.claim.key' <<<"$(note)") == "$pub" ]] || { echo "Claim key post-condition failed" >&2; exit 1; }
    printf 'fragment: %s\npublic key: %s\n' "$fragment" "$pub"
    ;;
  claim)
    [[ $# == 1 ]] || { usage; exit 2; }
    [[ -f $SEED_FILE ]] || { echo "Missing seed file: $SEED_FILE" >&2; exit 1; }
    seed=$(<"$SEED_FILE")
    sig=$(node -e 'const c=require("./web/claim-lib.js"); c.signClaim(process.argv[1],process.argv[2],process.argv[3],process.argv[4]).then(x=>process.stdout.write(x))' "$seed" "$CONTRACT" "$TOKEN" "$HOLDER")
    args=$(jq -cn --arg token "$TOKEN" --arg owner "$HOLDER" --arg sig "$sig" '{token_id:$token,new_owner:$owner,signature:$sig}')
    tx_call "$HOLDER" claim "$args"
    claimed() { [[ $(view nft_token "$(jq -cn --arg token "$TOKEN" '{token_id:$token}')" | jq -r '.owner_id') == "$HOLDER" && $(jq -r '.claim' <<<"$(note)") == null ]]; }
    for _ in $(seq 1 24); do claimed && break; sleep 5; done
    claimed || { echo "Claim post-condition failed" >&2; exit 1; }
    if replay=$(tx_call "$HOLDER" claim "$args" 2>&1); then echo "Replay unexpectedly succeeded" >&2; exit 1; fi
    grep -q 'no claim link' <<<"$replay" || { echo "Replay failed for an unexpected reason: $replay" >&2; exit 1; }
    ;;
  unseal)
    [[ $# == 3 ]] || { usage; exit 2; }
    tx_call "$HOLDER" unseal "$(jq -cn --arg token "$TOKEN" --arg dest "$2" --argjson fee "$3" '{token_id:$token,btc_dest:$dest,fee_rate:$fee}')"
    wait_note Unsealed 240 >/dev/null
    sweep=$(view signed_sweep_tx "$(jq -cn --arg token "$TOKEN" '{token_id:$token}')")
    [[ $sweep =~ ^([[:xdigit:]]{2})+$ ]] || { echo "No signed sweep stored" >&2; exit 1; }
    printf '%s\n' "$sweep"
    ;;
  broadcast)
    [[ $# == 1 ]] || { usage; exit 2; }
    sweep=$(view signed_sweep_tx "$(jq -cn --arg token "$TOKEN" '{token_id:$token}')")
    txid=$(curl -fsS -X POST "$MEMPOOL/tx" --data "$sweep" | tr -d '\r\n')
    echo "$txid"
    for _ in $(seq 1 12); do tx=$(mempool_json "/tx/$txid" 2>/dev/null) && break; sleep 5; done
    utxo=$(note | jq -c '.utxo')
    [[ $(jq -r '.vin[0].txid' <<<"$tx") == $(jq -r '.txid' <<<"$utxo") && $(jq -r '.vin[0].vout' <<<"$tx") == $(jq -r '.vout' <<<"$utxo") ]] || { echo "Sweep input post-condition failed" >&2; exit 1; }
    jq -c '{txid:.txid,vin:[.vin[0]|{txid,vout}]}' <<<"$tx"
    ;;
  finalize)
    [[ $# == 2 ]] || { usage; exit 2; }
    txid=$2
    sweep=$(view signed_sweep_tx "$(jq -cn --arg token "$TOKEN" '{token_id:$token}')")
    start=$(date +%s)
    while :; do
      tx=$(mempool_json "/tx/$txid")
      (( $(jq -r '.status.confirmed' <<<"$tx" | grep -c true) == 1 )) && break
      (( $(date +%s) - start < 2400 )) || { echo "Timed out waiting for sweep confirmation" >&2; exit 1; }
      sleep 30
    done
    while (( $(mempool_json /blocks/tip/height) - $(jq -r '.status.block_height' <<<"$tx") + 1 < 2 )); do
      (( $(date +%s) - start < 2400 )) || { echo "Timed out waiting for 2 confirmations" >&2; exit 1; }
      sleep 30
      tx=$(mempool_json "/tx/$txid")
    done
    wait_light_client $(( $(jq -r '.status.block_height' <<<"$tx") + 1 )) || exit 1
    p=$(proof_json "$txid")
    tx_call "$HOLDER" finalize "$(jq -cn --arg token "$TOKEN" --arg raw "$sweep" --argjson p "$p" '{token_id:$token,sweep_raw_tx:$raw,proof:$p.proof}')"
    for _ in $(seq 1 48); do
      [[ $(view nft_token "$(jq -cn --arg token "$TOKEN" '{token_id:$token}')" 2>/dev/null || echo null) == null && $(note 2>/dev/null || echo null) == null ]] && exit 0
      sleep 5
    done
    echo "Finalize post-condition failed" >&2; exit 1
    ;;
  *) usage; exit 2 ;;
esac
