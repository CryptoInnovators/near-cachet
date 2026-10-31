# AGENTS.md

Cachet: sealed bitcoin notes as NEP-171 NFTs on NEAR. Rust contract in `src/`, no admin, no keys after deploy.

## Map
- `src/lib.rs`: contract and state machine (Minted, Attesting, Sealed, Unsealing, Unsealed, Resigning, Finalizing).
- `src/btc.rs`: raw tx parser, txid, bech32 P2WPKH, BIP143 sighash, DER and low-S, signed sweep. Pure Rust.
- `src/signer.rs`: wire types for `v1.signer` (derived_public_key, sign, verify_foreign_transaction).
- `fixtures/signer`: harness that speaks the v1.signer ABI with known keys. `fixtures/market`: NFT receiver harness.
- `tests/`: sandbox suites. `tests/vectors`: real mainnet transactions.
- `spikes/chainsig`: testnet probe. `docs/TESTS.md`, `docs/SPIKE.md`: measured results.

## Commands
- `source scripts/env.sh` then `cargo test --lib` (unit and property tests).
- `./scripts/fetch-fixtures.sh` then `cargo test --test sandbox --test gift_and_lock --test intents`.
- `cargo near build non-reproducible-wasm --env 'RUSTFLAGS=--cfg near -C link-arg=-s'` builds `target/near/cachet.wasm` and its ABI. The `--env` is required: cargo-near sets RUSTFLAGS itself and hides `.cargo/config.toml`, and without `--cfg near` the wasm loses `panic_utf8` and every revert message.
- `./scripts/mutate.sh` breaks each guard in turn and expects a red test.

## Rules
- `v1.signer.sign` is called in exactly one function, `request_signature`, which needs a `SignPermit` from `authorize_sign`.
- Callbacks never panic after a state change: every failure path restores the prior state.
- No method moves value without a sandbox test and a mutation row in `docs/TESTS.md`.
- Mainnet transactions and funded accounts need the human.
