#!/usr/bin/env bash
# Reads the sweep from the public Bitcoin testnet3 explorer and the note from NEAR testnet.
# Exits nonzero unless the sweep spends the gifted note's funding output and the note is burned.
# Usage: scripts/check-sweep.sh [SWEEP_TXID]
set -euo pipefail
SWEEP=${1:-dc4e322b039eecf10a5d4f02cde246b4406b7845fc9ed9345b97df2654fffdde}
FUND=eaf498e49379648fc48d10ec58840d89f47b89d8d844c3bdd67a1055e54d124b
ADDR=tb1qqesag4graaen9v6f9ug4xawf4e8lacdhhkffsj
DEST=tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er
NEARRPC=${NEARRPC:-https://rpc.testnet.near.org}
MEMPOOL=${MEMPOOL:-https://blockstream.info/testnet/api}

curl -fsS -m 30 "$MEMPOOL/tx/$SWEEP" | jq -e --arg fund "$FUND" --arg addr "$ADDR" --arg dest "$DEST" '
  .status.confirmed == true
  and (.vin | length) == 1
  and .vin[0].txid == $fund and .vin[0].vout == 1
  and .vin[0].prevout.scriptpubkey_address == $addr
  and .vin[0].prevout.value == 107894
  and ([.vout[].scriptpubkey_address] == [$dest])' >/dev/null || { echo "FAIL: $SWEEP does not spend $FUND:1 of $ADDR" >&2; exit 1; }

view() { # METHOD -> JSON result of a cachet.testnet view call with token_id 1
  curl -fsS -m 30 "$NEARRPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"cachet.testnet\",\"method_name\":\"$1\",\"args_base64\":\"$(printf '{"token_id":"1"}' | base64)\"}}" |
    jq -er '.result.result | implode'
}
[[ $(view note) == null && $(view nft_token) == null ]] || { echo "FAIL: note 1 still exists on cachet.testnet" >&2; exit 1; }
echo "OK sweep $SWEEP spends $FUND:1 ($ADDR); note 1 burned"
