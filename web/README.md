# Cachet web demo

Static page. No framework, no build step, no npm packages.

## Open it

python3 -m http.server 8080 --directory web

Then open http://localhost:8080

## Panels and endpoints

- NEAR mainnet block: https://rpc.mainnet.fastnear.com (JSON-RPC block)
- Contract account: https://rpc.mainnet.fastnear.com (JSON-RPC view_account)
- Derived Bitcoin address for a note path: https://rpc.mainnet.fastnear.com (JSON-RPC call_function derived_public_key on v1.signer)
- v1.signer account: https://rpc.mainnet.fastnear.com (JSON-RPC view_account)
- Address on mempool.space: https://mempool.space/api/address/<address>