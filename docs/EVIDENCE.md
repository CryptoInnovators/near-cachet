# Testnet evidence, 2026-11-01

## Bitcoin sweep probe

Probe account: `cachet-probe-1101.cachet-spike-1031.testnet`.

| Action | NEAR transaction | NEAR block | Result |
|---|---|---:|---|
| Create probe account | `8UmaXac3F13dF6LMWALBESjzXQNyYQVLcoCpLsCducDD` | 275778882 | Success |
| Fund probe for deployment | `FWk7vK9WGHaCmArPHFeXa5bABKWQ4zeg2DJ83KY8UcSj` | 275782198 | Success |
| Deploy probe with the `lc_verify` forwarder | `Eu7Eq1BKSmgUhsS4sMreumhzMEF4bQ5GoHJBcQ2Yfbr8` | 275782350 | Success |
| Derive funding key | `GBjkhj6bB5zKEAQgNn1TGguhcgzTYAAm1ZvDSCsujfsQ` | 275782414 | Success |
| Derive sweep destination | `6g4fWhFokh1WHRZXR5fzmgFXhP3Hz4qHqewABjCGci9x` | 275782660 | Success |
| Fund probe for calls | `DYLTQQsB9bgRhDDT3M73972pPYruQDpX6iwQW3hbtadL` | 275782870 | Success |
| Fund probe for calls | `7qJrTwFsjngu6tyvAs7fTHgtT4i6WC4ZWi1cKzW43QLH` | 275782938 | Success |
| Sign the real BIP143 sighash with `v1.signer-prod.testnet` | `EWHvvGsJXrmLkqEhGo1CZ697cNR352TJmEiQQaUYXAji` | 275782983 | Success, 10.256 Tgas |
| Verify the sweep through `btc-client-v4.testnet` | `AxZBzvTxeK1n8QaBVZQmZE3y8bbRiZ3VaenNHt1hRyFP` | 275783427 | Success, light-client receipt at 275783428 used 1.941 Tgas and returned `true` |

Funding transaction `d3705c4274e03d42b06d1bbb97bbe31d1eef90563a921885022a48f987903ad1` confirmed in Bitcoin testnet3 block 5,259,588 and paid 10,000 sats to the derived funding address. Sweep `2418c7f777747831e8a07d536f952988e7096e4c1766b944949adfba1f2159e1` confirmed in block 5,259,596. At tip 5,259,597 it had two confirmations. The funding address then showed one 10,000-sat output funded, one 10,000-sat output spent, and a zero balance.

The live inclusion probe returned `true` for the sweep, `false` for a txid with one hex digit changed, and `Not enough blocks confirmed` for one extra confirmation. The consensus runner accepted the signed sweep and rejected the same signature after increasing the fee by one satoshi.
