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

## Cachet testnet deployment and mint, 2026-11-03

The CI artifact `cachet-wasm` from run `41656688087` contains `cachet.wasm` with SHA-256 `e208d53e1adf752a80cadf95016c65e9cac0d3563f2c9418e021614f1036871b` and the matching ABI. Both files were downloaded and checked before deployment.

| Action | NEAR transaction | NEAR block | Result |
|---|---|---:|---|
| Create `cachet.testnet` through the testnet faucet sponsor | `26Pu8H8LqZRiyow1LFcVbn4PXbH7NzGDXcnpD9Rf3dac` | 276063245 | Final success |
| Create `cachet-ops.testnet` through the testnet faucet sponsor | `ExtvEQyTRkCU1qmjaPcTW1MkxCpB7cEBb5cHF2ugqAoG` | 276063295 | Final success |
| Deploy `cachet.wasm` and initialize `cachet.testnet` | `HU3AEL52cJ5mXuynT8qXkDT2Pbm3jjA9KF3S68D1uHBW` | 276063360 | Final success; code hash matches the downloaded artifact |
| Delete the deploy access key | `C48HPy9EKW2g48aYQnTuCK6aG179Z7HH51uTxR7W4S1s` | 276063440 | Final success; `list-keys` returns an empty list |
| Mint note 1 for `cachet-ops.testnet` | `69TY7XLbCAXPM1mAXf1o5LZbxLHQRmaFpWocwMNcYgrs` | 276063615 | Final success; 12.0 Tgas |

At final block 276063397, `config()` returned signer `v1.signer-prod.testnet`, light client `btc-client-v4.testnet`, HRP `tb`, and 2 confirmations. `note("1")` returns `Minted`, owner `cachet-ops.testnet`, path `cachet/1/0`, and address `tb1qqesag4graaen9v6f9ug4xawf4e8lacdhhkffsj`. A live `derived_public_key` read from `v1.signer-prod.testnet`, converted with `web/app.js`, matches both the stored compressed public key and address.

## Bitcoin testnet3 gift and sweep through Chain Signatures, 2026-11-04

Note 1 on `cachet.testnet` goes from funded to burned in one run of `scripts/e2e-testnet-gift.sh`. The funding is a real Bitcoin testnet3 output, the claim is a link signature, and the sweep signature comes from `v1.signer-prod.testnet`.

| Step | Transaction | Block | Result |
|---|---|---:|---|
| Create holder `cachet-holder-1104.testnet` | NEAR `FmuEBrV3YyzSo7Jp2FseRUBD99HDbS9fR9qT7f5Avc7c` | n/a | Final success |
| Fund note address `tb1qqesag4graaen9v6f9ug4xawf4e8lacdhhkffsj` with 107,894 sats from the coinfaucet.eu testnet3 faucet | Bitcoin `eaf498e49379648fc48d10ec58840d89f47b89d8d844c3bdd67a1055e54d124b`, output 1 | Bitcoin 5,261,568 | Confirmed |
| `attest` as `cachet-ops.testnet` | NEAR `F7yT17CT5GxU4nUhJQBvybEShzdeKKxik9cUAAHCVrkg` | 276163907 | Returns `true`; the light client `btc-client-v4.testnet` verified inclusion at 2 confirmations, note `Sealed` with the funding txid and block hash |
| `create_claim` as `cachet-ops.testnet` | NEAR `DM9H19dUxjMNHgCuc5GdYDW6WRkmxWEUy1y2GkV28ayP` | 276163935 | `note.claim.key` equals the public key derived from the link secret |
| `claim` as `cachet-holder-1104.testnet` | NEAR `6kyB3vQ24Ezrmj12WJm64Np3CuXLUJrrs1TrRWWVuSSJ` | 276163996 | `nft_token` owner is the holder; replaying the same signature fails with `no claim link` |
| `unseal` to `tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er` at 2 sat/vB | NEAR `8bMnmy5muiiTGUk88Sz9n7z44cfuAg8c2fd57bwjZJx2` | 276164037 | `v1.signer-prod.testnet` signs through domain 0 in about 13 s; `ecrecover` accepts the signature against the note key; `note` is `Unsealed` with a 220-sat fee |
| Broadcast the stored `signed_sweep_tx` | Bitcoin `dc4e322b039eecf10a5d4f02cde246b4406b7845fc9ed9345b97df2654fffdde` | Bitcoin 5,261,570 | `mempool.space/testnet/api/tx/<txid>`: one input `eaf498e4...:1` from the note address (107,894 sats), one output of 107,674 sats to the destination, confirmed |
| `finalize` with the sweep inclusion proof | NEAR `FwLo9qXY666vMQ8rwPYKGXPnfkzou11vrkFzqR2RDAJW` | 276164580 | Returns `true`; `note("1")` and `nft_token("1")` both return `null` |

The note address then shows one funded and one spent 107,894-sat output. `scripts/check-sweep.sh` reads the sweep from the explorer API and the note from `https://test.rpc.fastnear.com`, and exits nonzero unless the sweep has one confirmed input spending output 1 of the funding transaction from the note address, pays only the destination, and note 1 is burned. Given the funding txid or an unknown txid in place of the sweep txid, it exits 1.

## Judge pool note, 2026-11-07

`web/judge-links.json` lists a sealed note that `claim.html` hands to a judge. `scripts/check-judge-pool.sh` reads the note from NEAR testnet and the funding output from the Bitcoin testnet3 explorer and exits nonzero unless they agree.

| Step | Transaction | Result |
|---|---|---|
| Mint note 2 for `cachet-ops.testnet` | NEAR `ET3QfRRbh9U6UZNSVVxzS32n3oPzjt5NhKbuNAZdPKnR` | Final success, token `"2"`, 12.0 Tgas |
| Fund `tb1qsq98ec3mxsy9f2jhmmwwm54lsdq0sz47mx0wgd` with 50,000 sats from the Satloot testnet3 faucet | Bitcoin `35784fb7705de7a4da2d6d98fb808c28cae0d334f89e08b5dcd0fe0f8e2f3885`, output 0 | Confirmed in Bitcoin testnet3 block 5,302,704 |
| `attest` as `cachet-ops.testnet` | NEAR `G3NR3NQjWYbTzdLsFd6trK6B333TZ93dZ61XACK7DgxW` | Returns `true` through `btc-client-v4.testnet`; `note("2")` is `Sealed` with block hash `0000000000f98b9ac91fb4e1b9b3e86b4b9409409d06e5e38edc43d629790b2` |
| `create_claim` as `cachet-ops.testnet` | NEAR `By9hXtiH4BzTTPRXDEoTBue6tAZGPpckL5nLHQTaXZiM` | `note.claim.key` equals the public key derived from the link secret |

## Judge pool note 3, 2026-11-08

`web/judge-links.json` lists two sealed notes. Note 3 is funded by a real Bitcoin testnet3 output and sealed through `btc-client-v4.testnet`; `scripts/check-judge-pool.sh` with `MIN=2` reads both notes from NEAR testnet and both funding outputs from the explorer and exits 0.

| Step | Transaction | Result |
|---|---|---|
| Fund `tb1qdwk5fzlt9e4w280tlfmthwmc2qzpdt698fvump` with 50,000 sats from the Satloot testnet3 faucet | Bitcoin `6462352d2eaec5924a8437e205f405ab0e1f0758fe0c2e32ad229a5260c1fc55`, output 0 | Confirmed in Bitcoin testnet3 block 5,303,453 |
| `attest` as `cachet-ops.testnet` | NEAR `Apa7MAK7PRohUiQwtUNd2RDmJ2WVzbZF5WPkKffYcDiL` | Returns `true` through `btc-client-v4.testnet`; `note("3")` is `Sealed` with block hash `00000000000000c8de6e4df31ef1266f78913b7df5673bf459f9a2ee9ccca5d0` |
| `create_claim` as `cachet-ops.testnet` | NEAR `DLgEdQCDAo9F7iHiEqdgUFb3sgtC8KCQY6mwfmuwy4oT` | `note.claim.key` equals the public key derived from the link secret |

<!-- attacks:start -->
## Rejected attacks on a Sealed note, 2026-11-10

Note 4 on `cachet.testnet` is Sealed and owned by `cachet-holder-1104.testnet` before and after every call below. Each call is a real testnet transaction that fails with the named guard, and none of them moves value or state.

| Row | Scenario | Signer | NEAR transaction | Guard | Method | Note | Link |
|---|---|---|---|---|---|---|---|
| attack | replay | cachet-holder-1104.testnet | `F9iRcq6tbimaRmKuKu7oaEsHj1hQoEzK2Fq1s4mU9kep` | `no claim link` | claim | "4" | [explorer](https://explorer.testnet.near.org/transactions/F9iRcq6tbimaRmKuKu7oaEsHj1hQoEzK2Fq1s4mU9kep) |
| attack | former-owner-unseal | cachet-ops.testnet | `2ByHt1Zi5mnjpBXSEwqb2ybi2swe3Gm3hqENoRtPMNge` | `only the note owner can request a signature` | unseal | "4" | [explorer](https://explorer.testnet.near.org/transactions/2ByHt1Zi5mnjpBXSEwqb2ybi2swe3Gm3hqENoRtPMNge) |
| attack | active-lock | cachet-holder-1104.testnet | `389c5F9piYHKPQrsRhRsSCH9eAJu8pDpX5pZiD3rWK9E` | `claim link is active` | nft_transfer | "4" | [explorer](https://explorer.testnet.near.org/transactions/389c5F9piYHKPQrsRhRsSCH9eAJu8pDpX5pZiD3rWK9E) |
| attack | active-lock | cachet-holder-1104.testnet | `G8MYQ6ozMh1Tup75s8T8TdxPLeJie1dZBj2PoQwvBdE7` | `claim link is active` | unseal | "4" | [explorer](https://explorer.testnet.near.org/transactions/G8MYQ6ozMh1Tup75s8T8TdxPLeJie1dZBj2PoQwvBdE7) |
<!-- attacks:end -->

## Judge view, 2026-11-10

`web/judge.html` reads note 4 on `cachet.testnet` live and renders its proof fields only after the NEAR and Bitcoin testnet3 reads agree. The note was funded with 50,000 sats in Bitcoin `ca578925f9440280955e7a5b8a3ea3f0b826d31047d93bb356a37cf5f504f23f` (block 5323292) and sealed by `attest` as `cachet-ops.testnet`.

| Step | Transaction | Result |
|---|---|---|
| `attest` for note 4 | NEAR `G9w9TgqYpRYojEgcyGbn3xz6r1g9ugFk1BENoSBxApdH` | Final success, returns `true`, note `Sealed` |
| `cargo test --test intents nep199_sealed_transfer_payout_maps_entire_balance_only_to_new_owner -- --exact` | Blacksmith VM | `1 passed; 0 failed`: after a transfer, `nft_payout` returns the whole balance to the new owner only |

The four rejected receipts are listed in the attacks section above. `scripts/check-judge-page.mjs` repeats every read and fails on a missing, stale or mismatched field.

### Payout instance

`cachet.testnet` keeps the code it launched with (no keys after deploy), which predates NEP-199 `nft_payout`. The current build (`cachet.wasm`, SHA-256 `e8fbbf45d95f5647accc6b4c8ce08b9aaed3ef6f280d3698dead73c67c610453`, the same hash CI produces) runs on `cachet-payout.testnet` with the same config: signer `v1.signer-prod.testnet`, light client `btc-client-v4.testnet`, HRP `tb`, 2 confirmations. The judge view reads the payout panel from that instance.

| Step | Transaction | Result |
|---|---|---|
| Deploy and `new` | NEAR `Ae267gBpvTijuiqonz4s9eyoDDSnf6Z2TrspPxiM6pXf` | Final success |
| `mint_note` as `cachet-holder-1104.testnet` | NEAR `kouy1qtJDmEU4eyKygCLnv8me1C6ZeZNzTikN8GLnh7` | Token `"1"` owned by the holder |
| Delete the deploy key | NEAR `EaikCHsyjeruzqGCdoqkQJdunQrVt7U42tfvhRKKFAEM` | `list-keys` returns an empty list |

`nft_payout("1", 1000000000000000000000000, 1)` returns `{"cachet-holder-1104.testnet": "1000000000000000000000000"}`.

## Walletless linkdrop claim, 2026-11-11

The sender's `cachet-ops.testnet` account added an Ed25519 function-call key with receiver `cachet.testnet`, method `claim`, and a 0.15 NEAR allowance. A signed-in wallet was not used by the recipient. The browser generated the implicit account `17c33dd760d581e9126c9fcd122bcef6a66b35cbcbef34eab846fd74892af30f`, and the link key submitted the claim for sealed note 2, worth 50,000 sats.

| Check | Live testnet result |
|---|---|
| `linkdrop claim GSW4DggXdSpFUWbXiV3TQLz6STGo25C9CGZS1BsMuzPJ` | Final success, one `claim` function call to `cachet.testnet` |
| `nft_token("2").owner_id` | `17c33dd760d581e9126c9fcd122bcef6a66b35cbcbef34eab846fd74892af30f` |
| `note("2")` | `Sealed`, 50,000 sats, `claim` is null after transfer |

## Stale claim-key cleanup, 2026-11-11

`scripts/ops-judge-envelope.sh check` compares each sender claim-only access key with the live claims on sender-owned notes. With the claim key for note 2 restored after its claim was cleared, the check reports one stale key. `cleanup` deletes it, waits for finality, and confirms the key is absent. The same cleanup runs before the sender prepares new judge links and before Hongbao creates new claim keys.

| Action | NEAR transaction | Result |
|---|---|---|
| Add a disposable stale claim-only key | `zBy4pVkEL2B1T6VppbQH4iHXDKu3ViCri34hJoimC5i` | Final success |
| Delete the disposable stale key | `A2Fu171yNfL3aLUuQVTb3FCPsjtpxTVJuK6thJvXUeKo` | Final success; check reports zero stale keys |
| Delete the claim key for claimed note 2 | `FjALFsgntXjT15EfFh2dc1HZ1c9QmLhJ5cAcrMSVc2C2` | Final success; `view_access_key_list` confirms the key is absent |

## Pass it on: a sealed note changes hands in chat, the Bitcoin output never moves (2026-11-13, live)

Run: `node scripts/e2e-ui.mjs --base https://near-cachet.earn-shield-alerts.workers.dev --pass` (cold claim, then pass, take, replay). Note 11, Bitcoin output a90714ae…1d1242:0, 5,500 sats.

| Step | Result | Transaction |
|---|---|---|
| Claim account passes the note to a link account (`nft_transfer`, 1 yocto) | success, note still Sealed, same Bitcoin output | https://testnet.nearblocks.io/txns/AhAQTkQL4bKnYSdvMyw4hR8A3zRnzXJ2cdZU9SGhahf2 |
| Link opener in a clean browser state sees seal and unspent checks, presses Take it, sponsor pays the fee | `nft_token` owner is the opener's new account, 22.1 s from opening the link | https://testnet.nearblocks.io/txns/2ySpUrZWD6UsndC9A4NJLCoY7UTbCoNeGXk4gm8uYPom |
| Replay of the spent link: the link account signs `nft_transfer` again | refused by the contract, `Sender not approved`, owner unchanged | https://testnet.nearblocks.io/txns/DvCJkQQmn2prnTDkYKR2Vg9syrbhHrmXvXoLpEZzu13N |

Sponsor guard (worker/src/sponsor.mjs) has a must-fail unit test: with the guard removed one test is red, restored it is green.

## Claim inside the Telegram Mini App (2026-11-13, live)

Run: `node scripts/e2e-ui.mjs --base https://near-cachet.earn-shield-alerts.workers.dev --claim --miniapp <launch url>`. The launch URL comes from Telegram's own `messages.RequestAppWebView` for the `t.me/cachet_envelope_bot/envelope?startapp=…` button that @cachet_envelope_bot posted in a real group after `/envelope 3400 2`, so the page opens with Telegram.WebApp.initData present and the envelope read from the start parameter. The key backup goes to Telegram CloudStorage (the page refuses to claim until it is saved); the harness answers that one host call the way the native client does.

| Step | Result | Transaction |
|---|---|---|
| One press of Claim my share in the Mini App, sender pays the fee | note 12 owner on chain is the new claim account ae7d3bce…d329f6, 14.3 s from page load, key shown as saved to the Telegram cloud backup | https://testnet.nearblocks.io/txns/3c7PWFASqwi9cCzNmXR5fGs847Wro5KuhWJ6Qyipu1x9 |

Fix that run found: a Telegram host that never answers CloudStorage held the envelope on its loading screen forever; the calls now give up after 6 s.

## Telegram Mini App run on the Heir contract (2026-11-13, live)

Run: `bash scripts/gate-pre.sh`. The Telethon WORK session creates the `cachet-gate` group with @cachet_envelope_bot, posts `/link` and `/envelope`, requests the signed launch URL with `messages.RequestAppWebViewRequest`, and the page runs inside that launch.

| Step | Result | Evidence |
|---|---|---|
| Bot posts the envelope with the Open the red envelope button | 6.0 s after `/envelope` | gate log `.progress/design/gate/tma-run.log` |
| Claim inside the Mini App, written through `/api/tma/send` | note 3 owner is the new claim account, 9.5 s from page load | https://testnet.nearblocks.io/txns/3t8QiEBeTqKH1NzsAbepGjtrtj8gdtThjUcNxDX8Ekz9 |
| Worker refuses a write without Telegram initData | HTTP 401 `telegram_initdata_refused` on `/api/tma/send` and `/api/sponsor` | `worker/test/initdata.test.mjs` (red with the signature compare removed, green restored) |
| Heir contract binds the only sweep address | `bind_heir` for notes 2, 3, 4 | https://testnet.nearblocks.io/txns/5im958SLHNsdEAkvfX1HtadiYWBw9N448whWAizgTUwY |
| Pool refill funding | notes 2, 3, 4 funded 1,700 sats each | https://blockstream.info/testnet/tx/02b7ea2c69bd33c2658b194ebf7ff8c5a7af57a986f96fdd24f3dbd0e5524d43 |

Fix that run found: a sponsored claim account held 0.05 NEAR and an unseal prepays 300 Tgas (0.30 NEAR); the sponsor now grants 0.4 NEAR.

## Heir note in the Telegram Mini App: claim, refused theft, heir open (2026-11-13, live)

Driven by `scripts/gate-pre.sh` through a real Telegram account on the live Mini App, contract `heir.cachet-ops.testnet`.

| Step | Result | Evidence |
|---|---|---|
| Claim with the native MainButton | note 11 owned by the new claim account, 10.6 s from page load | https://testnet.nearblocks.io/txns/6vnN9jPLvr5pLqNZN4zWPqVFEZyGTeHWdW7xHz4S2ZiB |
| Steal this link | NEAR refuses: the note sweeps only to its heir, 11.5 s | https://testnet.nearblocks.io/txns/BcbyfrbytfV3Lx2Q37hKucSqpipRsbKv47hVZS2W7Cyp |
| Open as the named heir | Chain Signatures signs the sweep, note reads Unsealed 9.5 s after the press | latest tx on note 11 (page footer, `heir.cachet-ops.testnet`) |
| Earlier claims | 8.8 s and 8.4 s | https://testnet.nearblocks.io/txns/ACAHUGfbgGUCt7uffhkFkZSUoAQDgWAE1yRU8JqC9wjX, https://testnet.nearblocks.io/txns/Hic3T6kJNiJ15GiacQvoHGpDT6VkCWZB5VEUgNKtQcm9 |
| Pool refill funding | notes 11, 12, 13 funded 1,700 sats each | https://blockstream.info/testnet/tx/5c29413410b7b4481b83a3878a456ac84f150b9599f1aed891851730fa41521f |

| Mini App full run, GREEN 27 of 27 | Claim 8.5 s page load to owner, theft refused 9.6 s, heir sweep signed 8.7 s, Bitcoin sweep pays only the bound heir | claim https://testnet.nearblocks.io/txns/HN832HM8vENgvKdoXHRbiRcQM24fmkN9rpWFncqsaaf1, refusal https://testnet.nearblocks.io/txns/D8tH5MCFjL5orud3ueq8ffjjqWaSN5UVAgXP9gGgDbAk, sweep https://blockstream.info/testnet/tx/800b01461791c7b1961da88d16344cafe2c7afb343472ad5dfb56396762cd402 |
