#!/usr/bin/env bash
# Attack rejections on a Sealed judge note of cachet.testnet, NEAR testnet only.
# Usage: e2e-testnet-attacks.sh [CONTRACT]          run the attacks and rewrite the attacks section of docs/EVIDENCE.md
#        e2e-testnet-attacks.sh --check-evidence    read-only: re-fetch every cited receipt and the note
# Env: TOKEN (a Sealed note owned by OPS or by HOLDER), OPS, HOLDER, NEARRPC, NETCFG, CLAIM_BLOCKS.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=run
if [[ ${1:-} == --check-evidence ]]; then MODE=check; shift; fi
CONTRACT=${1:-${CONTRACT:-cachet.testnet}}
OPS=${OPS:-cachet-ops.testnet}
HOLDER=${HOLDER:-cachet-holder-1104.testnet}
NEARRPC=${NEARRPC:-https://test.rpc.fastnear.com}
NETCFG=${NETCFG:-testnet}
CLAIM_BLOCKS=${CLAIM_BLOCKS:-2500000}
EVIDENCE=docs/EVIDENCE.md
START='<!-- attacks:start -->'
END='<!-- attacks:end -->'
DEST=tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er
SEEDS=${CACHET_SEED_DIR:-$HOME/.config/cachet}

rpc() { # METHOD PARAMS-JSON, retried because the shared RPC answers 429 under load
  local body try
  for try in 1 2 3 4 5 6; do
    body=$(curl -sS -m 30 "$NEARRPC" -H 'content-type: application/json' \
      --data "$(jq -cn --arg m "$1" --argjson p "$2" '{jsonrpc:"2.0",id:"cachet",method:$m,params:$p}')") || body=
    jq -e '.result' <<<"$body" >/dev/null 2>&1 && { jq -c '.result' <<<"$body"; return; }
    sleep $((try * 5))
  done
  echo "rpc $1 failed: $body" >&2; return 1
}

view() { # METHOD ARGS
  local r
  r=$(rpc query "$(jq -cn --arg c "$CONTRACT" --arg m "$1" --arg a "$(printf '%s' "$2" | base64 | tr -d '\n')" \
    '{request_type:"call_function",finality:"final",account_id:$c,method_name:$m,args_base64:$a}')")
  jq -er '[.result[]] | implode | fromjson' <<<"$r"
}
note() { view note "$(jq -cn --arg t "$1" '{token_id:$t}')"; }
owner() { view nft_token "$(jq -cn --arg t "$1" '{token_id:$t}')" | jq -r '.owner_id'; }

# Final failure message of a transaction, read from the chain by hash and signer.
tx_failure() { # HASH SIGNER
  local r
  r=$(rpc EXPERIMENTAL_tx_status "$(jq -cn --arg h "$1" --arg s "$2" '[$h,$s]')")
  jq -er '.status.Failure.ActionError.kind.FunctionCallError.ExecutionError // empty' <<<"$r"
}

if [[ $MODE == check ]]; then
  section=$(awk -v s="$START" -v e="$END" '$0==s{f=1;next} $0==e{f=0} f' "$EVIDENCE")
  rows=$(grep -c '^| attack' <<<"$section" || true)
  [[ $rows -ge 4 ]] || { echo "FAIL: attacks section has $rows rows, want at least 4" >&2; exit 1; }
  scenarios=$(grep '^| attack' <<<"$section" | awk -F'|' '{gsub(/ /,"",$3); print $3}' | sort -u | wc -l | tr -d ' ')
  [[ $scenarios -ge 3 ]] || { echo "FAIL: $scenarios scenarios, want 3" >&2; exit 1; }
  token=
  while IFS='|' read -r _ _ scenario signer hash reason _ tok _; do
    hash=$(tr -d ' `' <<<"$hash"); signer=$(tr -d ' `' <<<"$signer"); tok=$(tr -d ' `"' <<<"$tok")
    reason=$(sed 's/^ *`//; s/` *$//' <<<"$reason")
    got=$(tx_failure "$hash" "$signer") || { echo "FAIL: $hash did not fail on chain" >&2; exit 1; }
    [[ $got == "Smart contract panicked: $reason" ]] || { echo "FAIL: $hash failed with '$got', evidence says '$reason'" >&2; exit 1; }
    grep -q "explorer.testnet.near.org/transactions/$hash" <<<"$section" || { echo "FAIL: no explorer link for $hash" >&2; exit 1; }
    [[ -z $token || $token == "$tok" ]] || { echo "FAIL: rows cite different notes" >&2; exit 1; }
    token=$tok
    echo "ok $scenario $hash: $got"
  done < <(grep '^| attack' <<<"$section")
  n=$(note "$token")
  [[ $(jq -r '.state' <<<"$n") == Sealed ]] || { echo "FAIL: note $token is not Sealed" >&2; exit 1; }
  [[ $(owner "$token") == "$HOLDER" ]] || { echo "FAIL: note $token is not owned by $HOLDER" >&2; exit 1; }
  echo "PASS: note $token Sealed, owner $HOLDER, $rows rejected receipts"
  exit 0
fi

TOKEN=${TOKEN:?TOKEN of a Sealed note owned by $OPS or $HOLDER}
mkdir -p "$SEEDS"

tx_call() { # ACCOUNT METHOD ARGS DEPOSIT ; prints the CLI output, returns its exit code
  near contract call-function as-transaction "$CONTRACT" "$2" json-args "$3" \
    prepaid-gas '300 Tgas' attached-deposit "$4" sign-as "$1" \
    network-config "$NETCFG" sign-with-legacy-keychain send 2>&1
}
wait_for() { # DESCRIPTION CONDITION-FUNCTION, bounded at 24 polls of 5 s
  local _
  for _ in $(seq 1 24); do "$2" && return 0; sleep 5; done
  echo "timed out waiting for $1" >&2; return 1
}
height() { rpc block '{"finality":"final"}' | jq -er '.header.height'; }

ROWS=$(mktemp)
: > "$ROWS.jsonl"
# attack SCENARIO ACCOUNT METHOD ARGS DEPOSIT EXPECTED-REASON: the call must fail with that guard
attack() {
  local out hash reason
  if out=$(tx_call "$2" "$3" "$4" "$5"); then echo "FAIL: $1 $3 unexpectedly succeeded" >&2; exit 1; fi
  hash=$(grep -m1 'Transaction ID:' <<<"$out" | awk '{print $NF}')
  [[ -n $hash ]] || { echo "FAIL: no transaction id for $1 $3" >&2; echo "$out" | tail -8 >&2; exit 1; }
  reason=$(sed -n 's/.*Smart contract panicked: \(.*\)")\x1b.*/\1/p; s/.*Smart contract panicked: \(.*\)")$/\1/p' <<<"$out" | head -1)
  [[ $reason == "$6" ]] || { echo "FAIL: $1 $3 failed with '$reason', want '$6'" >&2; exit 1; }
  # the chain, not the CLI, is the witness
  for _ in 1 2 3 4 5 6; do [[ $(tx_failure "$hash" "$2" 2>/dev/null || true) == "Smart contract panicked: $6" ]] && break; sleep 5; done
  [[ $(tx_failure "$hash" "$2") == "Smart contract panicked: $6" ]] || { echo "FAIL: chain does not show $hash failing with '$6'" >&2; exit 1; }
  printf '| attack | %s | %s | `%s` | `%s` | %s | "%s" | [explorer](https://explorer.testnet.near.org/transactions/%s) |\n' \
    "$1" "$2" "$hash" "$6" "$3" "$TOKEN" "$hash" >> "$ROWS"
  jq -cn --arg s "$1" --arg a "$2" --arg m "$3" --arg h "$hash" --arg r "$6" '{scenario:$s,signer:$a,method:$m,tx:$h,reason:$r}' >> "$ROWS.jsonl"
  echo "rejected $1 $3 by $2: $6 ($hash)"
}

# setup: the note ends up with HOLDER through a link claim, as a gift does
[[ $(note "$TOKEN" | jq -r '.state') == Sealed ]] || { echo "note $TOKEN is not Sealed" >&2; exit 1; }
SEED_FILE="$SEEDS/attack-claim-seed-$TOKEN"
if [[ $(owner "$TOKEN") == "$OPS" ]]; then
  [[ $(note "$TOKEN" | jq -r '.claim') == null ]] || { echo "note $TOKEN already carries a claim link" >&2; exit 1; }
  seed=$(node -e 'process.stdout.write(require("./web/claim-lib.js").newSeedHex())')
  (umask 077; printf '%s' "$seed" > "$SEED_FILE")
  pub=$(node -e 'require("./web/claim-lib.js").publicKeyHexFromSeed(process.argv[1]).then(x=>process.stdout.write(x))' "$seed")
  exp=$(( $(height) + CLAIM_BLOCKS ))
  tx_call "$OPS" create_claim "$(jq -cn --arg t "$TOKEN" --arg k "$pub" --argjson e "$exp" '{token_id:$t,claim_key:$k,expires_at_block:$e}')" '0 NEAR' >/dev/null
  has_key() { [[ $(note "$TOKEN" | jq -r '.claim.key') == "$pub" ]]; }
  wait_for "claim key on note $TOKEN" has_key
  sig=$(node -e 'require("./web/claim-lib.js").signClaim(process.argv[1],process.argv[2],process.argv[3],process.argv[4]).then(x=>process.stdout.write(x))' "$seed" "$CONTRACT" "$TOKEN" "$HOLDER")
  printf '%s' "$sig" > "$SEED_FILE.sig"
  tx_call "$HOLDER" claim "$(jq -cn --arg t "$TOKEN" --arg o "$HOLDER" --arg s "$sig" '{token_id:$t,new_owner:$o,signature:$s}')" '0 NEAR' >/dev/null
  is_holder() { [[ $(owner "$TOKEN") == "$HOLDER" ]]; }
  wait_for "holder to own note $TOKEN" is_holder
fi
[[ $(owner "$TOKEN") == "$HOLDER" ]] || { echo "note $TOKEN owner is neither $OPS nor $HOLDER" >&2; exit 1; }
[[ -f $SEED_FILE.sig ]] || { echo "no recorded accepted claim signature for note $TOKEN" >&2; exit 1; }
sig=$(cat "$SEED_FILE.sig")

# 1. the accepted claim signature, replayed
attack replay "$HOLDER" claim "$(jq -cn --arg t "$TOKEN" --arg o "$HOLDER" --arg s "$sig" '{token_id:$t,new_owner:$o,signature:$s}')" '0 NEAR' 'no claim link'
# 2. the former owner tries to unseal
attack former-owner-unseal "$OPS" unseal "$(jq -cn --arg t "$TOKEN" --arg d "$DEST" '{token_id:$t,btc_dest:$d,fee_rate:2}')" '0 NEAR' 'only the note owner can request a signature'
# 3. an active claim lock blocks both a transfer and an unseal
if [[ $(note "$TOKEN" | jq -r '.claim.locked') != true ]]; then
  seed2=$(node -e 'process.stdout.write(require("./web/claim-lib.js").newSeedHex())')
  pub2=$(node -e 'require("./web/claim-lib.js").publicKeyHexFromSeed(process.argv[1]).then(x=>process.stdout.write(x))' "$seed2")
  tx_call "$HOLDER" create_claim "$(jq -cn --arg t "$TOKEN" --arg k "$pub2" --argjson e $(( $(height) + CLAIM_BLOCKS )) '{token_id:$t,claim_key:$k,expires_at_block:$e}')" '0 NEAR' >/dev/null
  locked() { [[ $(note "$TOKEN" | jq -r '.claim.locked') == true ]]; }
  wait_for "claim lock on note $TOKEN" locked
fi
attack active-lock "$HOLDER" nft_transfer "$(jq -cn --arg t "$TOKEN" --arg r "$OPS" '{receiver_id:$r,token_id:$t}')" '1 yoctoNEAR' 'claim link is active'
attack active-lock "$HOLDER" unseal "$(jq -cn --arg t "$TOKEN" --arg d "$DEST" '{token_id:$t,btc_dest:$d,fee_rate:2}')" '0 NEAR' 'claim link is active'

# post-state: still Sealed, still the holder's
[[ $(note "$TOKEN" | jq -r '.state') == Sealed ]] || { echo "FAIL: note $TOKEN left Sealed" >&2; exit 1; }
[[ $(owner "$TOKEN") == "$HOLDER" ]] || { echo "FAIL: note $TOKEN changed owner" >&2; exit 1; }

# the judge page verifies these receipts live before it shows them
jq -s --arg c "$CONTRACT" --arg t "$TOKEN" --arg h "$HOLDER" --arg a "${ATTEST_TX:-}" --argjson p "$(jq -c '.payout // null' web/judge-attacks.json 2>/dev/null || echo null)" \
  '{contract:$c,token_id:$t,owner:$h,attest_tx:$a,payout:$p,attacks:.}' "$ROWS.jsonl" > web/judge-attacks.json

# rewrite the attacks section of the evidence file
{
  echo "$START"
  echo "## Rejected attacks on a Sealed note, $(date -u +%F)"
  echo
  echo "Note $TOKEN on \`$CONTRACT\` is Sealed and owned by \`$HOLDER\` before and after every call below. Each call is a real testnet transaction that fails with the named guard, and none of them moves value or state."
  echo
  echo '| Row | Scenario | Signer | NEAR transaction | Guard | Method | Note | Link |'
  echo '|---|---|---|---|---|---|---|---|'
  cat "$ROWS"
  echo "$END"
} > "$ROWS.md"
if grep -q "^$START\$" "$EVIDENCE"; then
  awk -v s="$START" -v e="$END" -v f="$ROWS.md" '$0==s{while((getline l < f)>0) print l; skip=1; next} $0==e{skip=0; next} !skip' "$EVIDENCE" > "$EVIDENCE.tmp"
else
  { cat "$EVIDENCE"; echo; cat "$ROWS.md"; } > "$EVIDENCE.tmp"
fi
mv "$EVIDENCE.tmp" "$EVIDENCE"
echo "attacks recorded in $EVIDENCE"
