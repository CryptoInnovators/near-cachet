# Split Cachet envelope

`split.sh N TOTAL_SATS equal|lucky [seed]` uses `scripts/ops-testnet.sh mint` to mint N notes, reads each minted note from `cachet.testnet`, and assembles one unsigned Bitcoin testnet3 PSBT paying each derived address. Lucky allocations are deterministic for a given seed and keep every output at or above 1,000 sats.

Before running, configure the existing `near` CLI for the `cachet-ops.testnet` account and set these environment variables from the source wallet's selected UTXO:

- `SPLIT_SOURCE_TXID`
- `SPLIT_SOURCE_VOUT`

The script checks that transaction and output against `https://blockstream.info/testnet/api`, including that the output remains unspent. The amount above `TOTAL_SATS` is the transaction fee, so review it before signing. The PSBT contains exactly N outputs and no change output. It is not signed or broadcast.

Optional `CONTRACT`, `NEARRPC`, and `ESPLORA` variables select testnet endpoints. `SPLIT_SEED` supplies the lucky allocation seed when the positional seed is omitted.

The live integration test also requires `SPLIT_SOURCE_TXID` and `SPLIT_SOURCE_VOUT`, at least three Minted notes readable from the live contract, and working NEAR RPC and Esplora access. Run it with Node 22: `node --test scripts/split/test/`.
