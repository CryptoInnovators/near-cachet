#!/usr/bin/env bash
# Measures domain 3 Bitcoin attestation on mainnet v1.signer. Moves no bitcoin: it asks the MPC
# network whether an existing, confirmed Bitcoin transaction is on chain. It spends NEAR gas from
# the account you pass (about 0.01 NEAR) and signs with that account's key in your near-cli
# keychain. This script never reads or prints a key.
#
#   ./mainnet-attest.sh <your-mainnet-account.near> [txid] [confirmations]
#
# Default txid is a real mainnet transaction from tests/vectors.
set -euo pipefail
ACCOUNT="${1:?usage: mainnet-attest.sh <mainnet account> [txid] [confirmations]}"
TXID="${2:-06ddfa098718ad2e970775d4dac24ed01a6b6accb8188e21c1bfb36d88714209}"
CONF="${3:-2}"
OUT="$(dirname "$0")/results"
mkdir -p "$OUT"

# Positive: a confirmed transaction. Negative: an all-zero txid, which must not return a signature.
run() { # <label> <txid> <confirmations>
  local label="$1" txid="$2" conf="$3" args t0 t1
  args=$(python3 -c "import json,sys;print(json.dumps({'request':{'request':{'Bitcoin':{'tx_id':sys.argv[1],'confirmations':int(sys.argv[2]),'extractors':['BlockHash']}},'domain_id':3,'payload_version':1}}))" "$txid" "$conf")
  t0=$(python3 -c 'import time;print(time.time())')
  near contract call-function as-transaction v1.signer verify_foreign_transaction json-args "$args" \
    prepaid-gas '300 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$ACCOUNT" \
    network-config mainnet sign-with-keychain send 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "$OUT/mainnet-$label.txt" || true
  t1=$(python3 -c 'import time;print(time.time())')
  python3 -c "print('$label wall %.1fs' % ($t1-$t0))"
  grep -E "Gas burned|Transaction ID|ExecutionError|payload_hash" "$OUT/mainnet-$label.txt" | head -5
}
run positive "$TXID" "$CONF"
run unknown-txid 0000000000000000000000000000000000000000000000000000000000000000 "$CONF"
run too-many-confirmations "$TXID" 99999
