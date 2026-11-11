#!/usr/bin/env bash
set -euo pipefail

curl -sf -m 30 https://rpc.testnet.near.org \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"cachet.testnet","method_name":"config","args_base64":"e30="}}' |
  jq -e '.result.result | implode | fromjson | .signer_id == "v1.signer-prod.testnet" and .btc_light_client == "btc-client-v4.testnet"'
