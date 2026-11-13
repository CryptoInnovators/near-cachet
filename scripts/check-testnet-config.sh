#!/usr/bin/env bash
set -euo pipefail

BODY='{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"cachet.testnet","method_name":"config","args_base64":"e30="}}'
for rpc in ${NEARRPC:-https://near-testnet.drpc.org https://test.rpc.fastnear.com https://rpc.testnet.near.org}; do
  out=$(curl -sf -m 30 "$rpc" -H 'content-type: application/json' -d "$BODY") || continue
  echo "$out" | jq -e '.result.result | implode | fromjson | .signer_id == "v1.signer-prod.testnet" and .btc_light_client == "btc-client-v4.testnet"' && exit 0
done
exit 1
