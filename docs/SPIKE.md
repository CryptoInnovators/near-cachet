# Chain signatures spike

Measured on 2026-10-31 against the live NEAR signer contracts. Probe account `cachet-spike-1031.testnet` runs `spikes/chainsig/probe`, a contract that forwards raw calls to `v1.signer-prod.testnet`, so the signer sees a contract predecessor exactly as it does for Cachet. Raw CLI output for every row is in `spikes/chainsig/results/`.

| Claim | Command | Measured |
|---|---|---|
| A contract derives a secp256k1 key for path `cachet/1/0` | `near contract call-function as-transaction cachet-spike-1031.testnet derive` | tx `5fyjttQggYV5hMavVLgaHnam3Gsi4UMd9Ak7tBfvyXE4`, 7.4 Tgas, 12.6 s wall including CLI. The same key comes back from a `derived_public_key` view at block 275572091 for predecessor `cachet-spike-1031.testnet`. Address `tb1q0mesphequ9lp65djh5d7fvev4xkxgejrpn3cs6` |
| Domain 0 signs a BIP143 sighash for that key from a contract predecessor | `... sign` with the sighash from `spikes/chainsig/consensus sighash` | 4 runs, 14.9 to 15.6 s wall (mean 15.2 s), 10.0 to 10.1 Tgas each. Txs `HGWikoowsfMPTeQto4rzExLd3ijDQcguZ4sqyhN3eT52`, `6YYfHRphSAzDVMqLPR5PAFTcU6Bjjgim3jGKUTUUsnLd`, `DaxH3JyBoZh7LmgT8UgnTjgRZEsmaTdYW19dHpjdyP1y`, `DJXbXErGh7GXCBxgWRKMzLYrHJ58GYbtovkDGABvM2Xz` |
| The returned signature spends the output under Bitcoin Core's script engine | `spikes/chainsig/consensus verify` (libbitcoinconsensus) | `CONSENSUS OK` on all 4 signatures, 110 vB sweeps. The same signature on a sweep with 1 sat more fee, and on a sweep with a different input amount, is rejected (`ERR_SCRIPT`) |
| The response shape matches `src/signer.rs` | decoded from the 4 sign responses | `{"big_r":{"affine_point"},"s":{"scalar"},"recovery_id","scheme":"Secp256k1"}` |
| Domain 3 `verify_foreign_transaction` returns `payload_hash` and a signature | `... verify` for Base Sepolia tx `16b0155a...3729`, finality `Finalized` | tx `31ATkCCf7jepkrxc8Ri5yWnpst5LgTA4ooePCqd6q8D5`, 17.0 s wall, 10.2 Tgas, response `{"payload_hash":"76ec3927...4e45","signature":{...Secp256k1}}` |
| The request envelope is `{request:{<Chain>:{tx_id,extractors,...}},domain_id:3,payload_version:1}` with `tx_id` as bare hex | error text from three malformed requests | `0x` prefix rejected at column 107, a 31-byte sign payload rejected with `Lower bound violation: got 31 (expected >= 32)` |
| An unknown transaction id yields no signature | `... verify` with an all-zero tx id | the signer yields until its own timeout, then the call fails with `Request has timed out`, 134.6 s wall, 13.0 Tgas. Cachet's `on_attest` returns the note to `Minted` on this path (sandbox test `attest_rejects_a_raw_tx_that_does_not_hash_to_a_confirmed_txid`) |

## Chains each signer verifies

Read with `get_available_foreign_chains`, `get_foreign_chains_configs` and `allowed_foreign_chain_providers`.

| Signer | Version | Block | Domains | Bitcoin in foreign chains |
|---|---|---|---|---|
| `v1.signer-prod.testnet` | 3.18.0 | 275572265 | 0 CaitSith Sign, 1 Frost Sign, 2 CKD, 3 CaitSith ForeignTx, threshold 11 | Foreign chains: Solana, Base, Bnb, Arbitrum, Abstract, Starknet, Polygon, HyperEvm, Aptos, Sui, Avalanche, Fogo. Domain 3 is exercised here with Base Sepolia |
| `v1.signer` mainnet | 3.17.0 | 222394250 | same four domains, threshold 11, 16 participants | Bitcoin is a foreign chain: 12 of the 17 node configs list it, one provider (`https://bitcoin-rpc.publicnode.com`), quorum 1 |

Bitcoin attestation targets mainnet `v1.signer`. `spikes/chainsig/mainnet-attest.sh <account>` measures it with three requests (a confirmed transaction, an all-zero tx id, and `confirmations: 99999`) and moves no bitcoin; it costs about 0.01 NEAR of gas from the account passed in.

## What the sandbox suites cover instead

`fixtures/signer` speaks this ABI with known keys, including the `payload_hash` plus `signature` response measured above, and `tests/` drives every note method against it. Wire shapes in `src/signer.rs` are the ones measured here: the sign request, the signature response, the verify envelope and the response.

## Reproduce

```
cd spikes/chainsig/consensus && cargo build --release
C=target/release/cachet-spike-consensus
K=secp256k1:5FJrb7umzFk9pUGkoYDDa29oGAPHZD6DVH5qRRhmzR1ZdnedcZBGWXidjNYSK7ovK8R1gc7zaHh3rsNmcoTvLSQx
H=$($C sighash $K 100000 tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx 10)
near contract call-function as-transaction cachet-spike-1031.testnet sign \
  json-args "{\"signer\":\"v1.signer-prod.testnet\",\"path\":\"cachet/1/0\",\"payload_hex\":\"$H\"}" \
  prepaid-gas '300 Tgas' attached-deposit '1 yoctoNEAR' sign-as cachet-spike-1031.testnet \
  network-config testnet sign-with-keychain send
$C verify $K 100000 tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx 10 '<the JSON the call printed>'
```

`K` is the public key the derive call returned for predecessor `cachet-spike-1031.testnet`; the probe account's key lives in the near-cli keychain of the machine that ran it.
