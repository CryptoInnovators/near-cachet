# Cachet

[![ci](https://github.com/kamalbuilds/near-cachet/actions/workflows/ci.yml/badge.svg)](https://github.com/kamalbuilds/near-cachet/actions/workflows/ci.yml)

Cachet is a NEP-171 NFT contract on NEAR where each token owns one native Bitcoin output. `mint_note` asks the NEAR MPC signer for a P2WPKH address derived at `cachet/<token_id>/0`. Anyone can fund it. `attest` binds the funding output to the token after the configured Bitcoin light client verifies its inclusion proof. The contract holds no signing key or upgrade key. Only the token owner can ask the signer to sign an unseal or fee-resign for an attested, unspent note.

## Try it

Live: https://near-cachet.earn-shield-alerts.workers.dev/ (Bitcoin testnet, no wallet, nothing to install).

1. Open the URL. The first screen is a Bitcoin red envelope: a sealed note with its sats read from the chain and a row of shares left.
2. Press **Claim my share**. Within about ten seconds the panel reads "Your share is yours." with the NEAR claim transaction on nearblocks (for example https://testnet.nearblocks.io/txns/649SzLd5xjM72pyerXRb6G19mTKBUoEdXCxw3r9HESSg), the card holder reads "You", and shares left drops by one. The key file is saved to your downloads and your clipboard.
3. Open **Show how it is checked**. The funding block, the confirmations above it, the signer key match and the contract's empty key list are re-read live from NEAR and Bitcoin.
4. Press **Move it to a Bitcoin address** to break the seal: the signer signs the sweep, you broadcast it, and Bitcoin spends the output the note owned.

`node scripts/e2e-ui.mjs --base https://near-cachet.earn-shield-alerts.workers.dev --claim` runs steps 1 and 2 through a real browser, cold, and asserts the new owner on chain.

## The problem

Bitcoin held through an NFT today is held by a token-bound account, and the seller can empty the account while the NFT is being sold. Valastin et al. name this in their ERC-6551 comparison (https://arxiv.org/abs/2404.14074): the buyer receives an empty account. A Cachet note has no signing path until its holder calls `unseal`, and `unseal` freezes transfers, so a buyer who sees `state: Sealed` and `utxo.sats` is looking at the whole claim.

Physical bearer notes (Coinkite SATSCARD, Opendime) have the same property and need a courier. A Cachet note moves as an NFT transfer or as a claim link.

## Run it from a clean clone

Requires Rust stable with the `wasm32-unknown-unknown` target, `cargo-near` 0.16, `curl`, `jq`, Node 20 or later (for the page tests) and network access: the sandbox downloads `near-sandbox` once and `fetch-fixtures.sh` reads two contracts from mainnet RPC.

1. Run everything in one command: `./scripts/test.sh`. It fetches the fixtures, runs `cargo test --workspace`, and runs the browser-module tests. GitHub Actions runs the same check on pushes to main.
2. Run unit and property tests with `cargo test --lib`. Fetch sandbox fixtures with `./scripts/fetch-fixtures.sh`. Run the full workspace with `cargo test --workspace`; sandbox tests exercise the contract against a signer harness that speaks the `v1.signer` ABI with known keys.
3. Page-module tests: `node --test web/web.test.mjs`.
4. Mutation check: `./scripts/mutate.sh M26`. It removes the 64-byte guard, runs the failing test, restores the source, then confirms the test passes. `./scripts/mutate.sh` with no ids runs every mutation row.
5. Build the deployable wasm: `cargo near build non-reproducible-wasm --env 'RUSTFLAGS=--cfg near -C link-arg=-s'`. Expect `target/near/cachet.wasm` and `target/near/cachet_abi.json`. The `--env` flag selects near-sdk's on-chain `panic_utf8`, `sha256` and `ripemd160` host functions; the sandbox harness asserts the wasm imports `panic_utf8`.
6. Read the numbers: `docs/TESTS.md` (every value-moving method, its sandbox test and its mutation row with output) and `docs/SPIKE.md` (measured against `v1.signer-prod.testnet` and mainnet `v1.signer`).

Test fixtures (the signer harness, the market receiver, the Bitcoin vectors) live under `fixtures/` and `tests/`. The contract in `src/` contains no fixture data.

## Demo page

Two static pages in `web/`, no build step and no install.

1. Serve it: `python3 -m http.server 8080 --directory web`.
2. Open localhost port 8080. Select testnet or mainnet, then read a deployed Cachet contract and token. Connect the owning NEAR wallet to mint or manage a note. Each note uses slot 0; the page derives its Bitcoin address from the signer key and reads the note, access keys and Bitcoin activity from their named sources.
3. `claim.html` opens a claim link. The receiver connects a NEAR wallet, signs `cachet-claim:<contract>:<token>:<new owner>` in the browser, and submits `claim`. The page reads the new owner from the contract, then offers unseal and broadcast actions for the owner.

| Panel | Endpoint |
|---|---|
| Address | Selected NEAR RPC `call_function` to the configured signer `derived_public_key` (`path`, `predecessor`, `domain_id: 0`), compressed and encoded to bech32 P2WPKH in the browser |
| Note record and configuration | Selected NEAR RPC `call_function` `<contract>.note` and `<contract>.config` |
| Access keys | Selected NEAR RPC `view_access_key_list` on the contract account |
| Bitcoin activity and proofs | `mempool.space` address, transaction and block APIs for the selected Bitcoin network |
| Claim page | Selected NEAR RPC for `block`, `note`, `config` and `nft_token` |

The address derivation is checked against the `bitcoin` crate and the contract by `tests/web_parity.rs`, which reads the same `web/vectors.json` as `web/web.test.mjs`. Details: `web/README.md`.

## Telegram Hongbao

Deploy the Worker to serve the Cachet web app and share previews, then configure a Telegram bot with a Mini App named `hongbao` pointing to the Worker URL. Set `TELEGRAM_APP_SHORTNAME` to that exact short name.

```sh
npx wrangler deploy --config worker/wrangler.toml
TELEGRAM_BOT_TOKEN=<BotFather token> TELEGRAM_APP_SHORTNAME=hongbao CACHET_WEB_URL=<Worker URL> node bot/index.mjs
```

1. In the Cachet web app, connect a NEAR wallet, create a note, fund its Bitcoin address, wait for confirmation, and attest the funding output until the note is Sealed.
2. Create a claim link for that note in the web app. In a private chat with the bot, register it with `/link <note id> <claim URL>`, then share the sealed note using `/envelope <total-sats> <shares>`.
3. The recipient opens the inline button in Telegram's Mini App, connects a NEAR wallet, and taps **Claim this gift**. The Mini App submits the claim and confirms the recipient owns the note.

## State machine

| State | Entered by | Leaves by |
|---|---|---|
| Minted | `mint_note` callback with the derived key | `attest` |
| Attesting | `attest` | Light client confirms: Sealed. Fails or times out: Minted (`recover` after 400 blocks) |
| Sealed | funding attested | `unseal` (owner), `create_claim`, transfer, listing |
| Unsealing | `unseal` | signature recovers to the note key: Unsealed. The signer reports a failure: Sealed. No callback lands: `recover` after 400 blocks freezes the note at Unsealed with its destination, because the signature may already be public |
| Unsealed | sweep signed, or recovered from an unanswered unseal | `resign` (owner, fee only), `finalize` |
| Finalizing | `finalize` with the sweep proof | light client confirms: burn. Proof refusal: Unsealed |

`authorize_sign` is the only function that issues a `SignPermit`, and `request_signature` is the only caller of `v1.signer.sign`. A unit test enumerates every combination of operation, state, owner, in-transfer and claim-lock and asserts exactly three can sign. A source test asserts one `.sign(` call site.

## Methods

| Method | Who | Effect |
|---|---|---|
| `mint_note` | anyone, 0.02 NEAR minimum | derives the key, mints, shows the address only after the receipt succeeds; the deposit also prefunds every byte the note can add later, so a callback never meets an empty storage balance |
| `attest(token_id, raw_tx, vout, proof)` | owner | parses the raw transaction, rejects any whose witness-stripped form is 64 bytes, checks the output pays the note, and asks the configured Bitcoin light client to verify its inclusion proof and confirmation depth |
| `unseal(token_id, btc_dest, fee_rate)` | owner | signs a one-input BIP143 sweep through domain 0, low-S, verified by `ecrecover` against the note key before it is stored |
| `resign(token_id, fee_rate)` | owner | same sweep to the same destination at a new fee |
| `finalize(token_id, sweep_raw_tx, proof)` | anyone | burns the note after the configured Bitcoin light client verifies a Bitcoin transaction that spends the UTXO to the unseal destination |
| `create_claim`, `claim`, `cancel_claim` | owner, link holder | gift by link: an ed25519 key registered on the note; `claim` accepts only a signature over `cachet-claim:<contract>:<token>:<new owner>` |
| `recover` | owner | after 400 NEAR blocks: Attesting returns to Minted; Unsealing, Resigning and Finalizing land on Unsealed with the destination kept |
| `nft_transfer`, `nft_transfer_call` | owner | only Minted and Sealed notes move; a transfer clears any claim key; `claim` also clears NEP-178 approvals and refunds them to the previous owner; a note held by an escrow cannot be unsealed by its seller or by the receiver |
| `config`, `signed_sweep_tx` | anyone | reads the immutable signer, Bitcoin light client, network settings and a note's signed sweep |

## Trust roots

The unseal path trusts the NEAR MPC signer threshold. Every note address is derived from the signer's shared root key. Bitcoin confirmation uses the configured Omni Bridge Bitcoin light client, which checks the transaction inclusion proof against its tracked chain. The contract has no admin method or upgrade key. The 64-byte transaction rule follows Core Chain's Merkle forgery (https://fc25.ifca.ai/wtsc/PAPERS/WTSC25_paper1.pdf).

## Evidence in this repo

- `tests/vectors`: real mainnet transactions parsed to their published txids.
- `tests/sandbox.rs`, `tests/gift_and_lock.rs`, `tests/paper_design.rs`, `tests/attest_light_client.rs`, `tests/review_fixes.rs`: state machine, claim links, Bitcoin inclusion proofs, the 64-byte rule, failed derivation and storage funding.
- `tests/intents.rs`: the mainnet `intents.near` code holds a sealed note and nobody can unseal it; two parties sign `token_diff` intents, a relayer runs `execute_intents`, and the unseal right moves to the buyer while the seller keeps wNEAR and no signing path.
- `fixtures/signer`: `v1.signer` ABI harness. `fixtures/market`: NFT receiver harness.
- `web/web.test.mjs`: network selection, funding-address visibility, fee checks and a captured inclusion proof against the reviewed Bitcoin vector.
- `docs/TESTS.md`: acceptance and mutation evidence.

## Related projects

Cachet is independent of the other NEAR entries from this team: Voucher, Overdraft and Receipts. It shares no crate with them.
