# Cachet

[![ci](https://github.com/kamalbuilds/near-cachet/actions/workflows/ci.yml/badge.svg)](https://github.com/kamalbuilds/near-cachet/actions/workflows/ci.yml)

Cachet is a NEP-171 NFT contract on NEAR where each token owns a native Bitcoin output. `mint_note` asks the NEAR MPC signer (`v1.signer`) for a P2WPKH address derived at `cachet/<token_id>/<slot>`, anyone can fund that address, and `attest` binds the funding output to the token after the MPC network confirms the transaction on Bitcoin. The contract holds no key and exposes no method that reaches `sign` except `unseal` and `resign`, which only the token owner can call on an attested, unspent slot.

## The problem

Bitcoin held through an NFT today is held by a token-bound account, and the seller can empty the account while the NFT is being sold. Valastin et al. name this in their ERC-6551 comparison (https://arxiv.org/abs/2404.14074): the buyer receives an empty account. A Cachet note has no signing path until its holder calls `unseal`, and `unseal` freezes transfers, so a buyer who sees `state: Sealed` and `utxo.sats` is looking at the whole claim.

Physical bearer notes (Coinkite SATSCARD, Opendime) have the same property and need a courier. A Cachet note moves as an NFT, listed on any NEAR market that supports `nft_transfer_call`, or as a link.

## Run it from a clean clone

Requires Rust stable with the `wasm32-unknown-unknown` target, `cargo-near` 0.16, `curl`, `jq`, Node 20 or later (for the page tests) and network access: the sandbox downloads `near-sandbox` once and `fetch-fixtures.sh` reads two contracts from mainnet RPC.

1. Run everything in one command: `./scripts/test.sh`. It fetches the fixtures, then runs `cargo test --workspace`. Expect every `test result` line to read `ok`. The same command runs on GitHub Actions for each push to main (badge above).
2. Or run the suites one at a time. Unit and property tests: `cargo test --lib`, expect `15 passed`. Fixtures: `./scripts/fetch-fixtures.sh`, expect two `-> fixtures/wasm/...` lines. Sandbox suites: `cargo test --test sandbox --test gift_and_lock --test intents --test paper_design --test web_parity`, expect `19`, `10`, `3`, `2` and `2` passed. They build the contract with cargo-near and run it in a NEAR sandbox against a signer harness that speaks the `v1.signer` ABI with known keys. `gift_and_lock` advances blocks and takes a few minutes.
3. Page tests: `node --test web/web.test.mjs`. Expect `pass 6`.
4. Mutation check: `./scripts/mutate.sh M26`. Expect a line ending `red=101 green=0`: the 64-byte guard is broken, a test goes red, the file is restored, the same test goes green. `./scripts/mutate.sh` with no ids runs all 30 rows.
5. Build the deployable wasm: `cargo near build non-reproducible-wasm --env 'RUSTFLAGS=--cfg near -C link-arg=-s'`. Expect `target/near/cachet.wasm` and `target/near/cachet_abi.json`. The `--env` flag selects near-sdk's on-chain `panic_utf8`, `sha256` and `ripemd160` host functions; the sandbox harness asserts the wasm imports `panic_utf8`.
6. Read the numbers: `docs/TESTS.md` (every value-moving method, its sandbox test and its mutation row with output) and `docs/SPIKE.md` (measured against `v1.signer-prod.testnet` and mainnet `v1.signer`).

Test fixtures (the signer harness, the market receiver, the Bitcoin vectors) live under `fixtures/` and `tests/`. The contract in `src/` contains no fixture data.

## Demo page

Two static pages in `web/`, no build step and no install.

1. Serve it: `python3 -m http.server 8080 --directory web`.
2. Open localhost port 8080 in a browser. See the Bitcoin address that `v1.signer` derives for `cachet/1/0`, the note record, the contract access keys and the Bitcoin activity at the address, each with its source and the NEAR block it was read at. The form takes any contract account, token id and slot, and writes them to the URL so a read can be linked.
3. Open `claim.html` on the same port. Press "Make link" to see a fresh ed25519 key pair made in the tab, the `create_claim` call for the owner, and a link that carries the secret after the `#`. Open that link as the receiver, enter your NEAR account, and see the signature over `cachet-claim:<contract>:<token>:<new owner>` with the `claim` and `unseal` calls ready to run.

| Panel | Endpoint |
|---|---|
| Address | `rpc.mainnet.fastnear.com` `call_function` `v1.signer.derived_public_key` (`path`, `predecessor`, `domain_id: 0`), compressed and encoded to bech32 P2WPKH in the browser |
| Note record | `rpc.mainnet.fastnear.com` `call_function` `<contract>.note` and `<contract>.config` |
| Access keys | `rpc.mainnet.fastnear.com` `view_access_key_list` on the contract account |
| Bitcoin activity | `mempool.space/api/address/<address>` and `/api/blocks` |
| Claim page | `rpc.mainnet.fastnear.com` `block` and `call_function` `<contract>.note` |

The address derivation is checked against the `bitcoin` crate and the contract by `tests/web_parity.rs`, which reads the same `web/vectors.json` as `web/web.test.mjs`. Details: `web/README.md`.

## State machine

| State | Entered by | Leaves by |
|---|---|---|
| Minted | `mint_note` callback with the derived key | `attest` |
| Attesting | `attest` | MPC confirms: Sealed. Fails or times out: Minted (`recover` after 400 blocks) |
| Sealed | funding attested | `unseal` (owner), `create_claim`, transfer, listing |
| Unsealing | `unseal` | signature recovers to the note key: Unsealed. The signer reports a failure: Sealed. No callback lands: `recover` after 400 blocks freezes the note at Unsealed with its destination, because the signature may already be public |
| Unsealed | sweep signed, or recovered from an unanswered unseal | `resign` (owner, fee only), `finalize` |
| Finalizing | `finalize` with the confirmed sweep | burn |

`authorize_sign` is the only function that issues a `SignPermit`, and `request_signature` is the only caller of `v1.signer.sign`. A unit test enumerates every combination of operation, state, owner, in-transfer and claim-lock and asserts exactly three can sign. A source test asserts one `.sign(` call site.

## Methods

| Method | Who | Effect |
|---|---|---|
| `mint_note` | anyone, 0.02 NEAR minimum | derives the key, mints, shows the address only after the receipt succeeds; the deposit also prefunds every byte the note can add later, so a callback never meets an empty storage balance |
| `attest(token_id, raw_tx, vout)` | owner | parses the raw transaction, rejects any whose witness-stripped form is 64 bytes, checks the output pays the note, asks MPC domain 3 to confirm the txid |
| `unseal(token_id, btc_dest, fee_rate)` | owner | signs a one-input BIP143 sweep through domain 0, low-S, verified by `ecrecover` against the note key before it is stored |
| `resign(token_id, fee_rate)` | owner | same sweep to the same destination at a new fee |
| `finalize(token_id, sweep_raw_tx)` | anyone | burns the note after MPC confirms a Bitcoin transaction that spends the UTXO to the unseal destination |
| `create_claim`, `claim`, `cancel_claim` | owner, link holder | gift by link: an ed25519 key registered on the note; `claim` accepts only a signature over `cachet-claim:<contract>:<token>:<new owner>` |
| `recover` | owner | after the signer's own 200 block timeout: Attesting returns to Minted, Unsealing, Resigning and Finalizing land on Unsealed (frozen, destination kept) |
| `nft_transfer`, `nft_transfer_call` | owner | only Minted and Sealed notes move; a transfer clears any claim key; `claim` also clears NEP-178 approvals and refunds them to the previous owner; a note held by an escrow cannot be unsealed by its seller or by the receiver |

## Trust roots

The unseal path trusts the NEAR MPC threshold behind `v1.signer` (11 of 16 participants on domain 0 and domain 3). Every note address is a child of one MPC root key, so the signer set is the shared root for all notes. Bitcoin confirmation comes from the providers `v1.signer` is configured with. Cachet adds no admin, no upgrade key and no oracle on top of these: `new` takes three immutable values, and the lifecycle test runs against a contract whose access keys have all been deleted. The 64-byte rule follows Core Chain's Merkle forgery (https://fc25.ifca.ai/wtsc/PAPERS/WTSC25_paper1.pdf); the MPC confirmation stays mandatory beside it.

## Evidence in this repo

- `tests/vectors`: real mainnet transactions parsed to their published txids.
- `tests/sandbox.rs`, `tests/gift_and_lock.rs`, `tests/paper_design.rs`: state machine, claim links, 64-byte rule, failed derivation.
- `tests/intents.rs`: the mainnet `intents.near` code holds a sealed note and nobody can unseal it; two parties sign `token_diff` intents, a relayer runs `execute_intents`, and the unseal right moves to the buyer while the seller keeps wNEAR and no signing path.
- `fixtures/signer`: `v1.signer` ABI harness. `fixtures/market`: NFT receiver harness.
- `docs/PRIOR-ART.md`: the papers behind the design and what each changed.

## Related projects

Cachet is independent of the other NEAR entries from this team: Voucher, Overdraft and Receipts. It shares no crate with them.
