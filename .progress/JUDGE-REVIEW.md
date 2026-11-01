# JUDGE-REVIEW: Cachet as it stands, 2026-10-31

Internal. Move this file to `.progress/` or delete it before the repo goes public; it is a critique, not a public surface.

Read for this review: `src/lib.rs`, `src/btc.rs` (grep level), `src/signer.rs`, `tests/*.rs`, `tests/common/mod.rs`, `fixtures/signer/src/lib.rs` (head), `scripts/*`, `spikes/chainsig/*`, `AGENTS.md`, `.env.example`, `.gitignore`, `git ls-files`, `git log`, docs/HACKATHON.md, docs/WIN-CONDITIONS.md, docs/PRIOR-ART.md, research VERDICT.md, JUDGES.md, GRAPH.md (nfts row). README.md, docs/TESTS.md and docs/SPIKE.md do not exist. Nothing was built or run: this lane is read-only and did not run cargo.

## What exists today

A keyless-by-design NEP-171/177/178/181 contract with a seven-state note machine (`src/lib.rs`), an in-contract Bitcoin tx parser, txid, bech32, BIP143, DER and low-S (`src/btc.rs`), wire types for `v1.signer` (`src/signer.rs`). One call site of `v1.signer.sign` behind a `SignPermit` (`src/lib.rs` `request_signature`), exhaustively enumerated in a unit test (`src/lib.rs` `signing_is_reachable_from_exactly_two_configurations`). Sandbox suites run against a signer harness with test-chosen roots, real mainnet tx vectors, and the real `intents.near` wasm fetched by `view_code` (`tests/intents.rs`). `scripts/mutate.sh` breaks 25 guards one at a time. The 64-byte tx guard from PRIOR-ART is in (`src/btc.rs:229`, `tests/paper_design.rs`, untracked).

Absent: README, any deployed account, any testnet or mainnet tx hash, spike output, a frontend or CLI a judge can use, the Intents sale leg (no `token_diff` code or test), any client that produces a claim-link signature.

## Judge by judge

Scores: T technical implementation, D design, I impact, O originality, S sustainability. Scored on the repo today, not the plan.

### Illia Polosukhin

Relied on: "The only solution is to only use code that is correct by construction: mathematically proven to be correct." (Substack 2025-08-26, JUDGES.md section 2, V-PAGE). Bias row: `nfts` low.

He reads the permit type and the enumeration test as the right instinct, and then notices it enumerates one pure function, not the contract. Domains 0 and 3 are used from a contract predecessor, which he will like. No Intents settlement, no NEAR AI Cloud, nothing on mainnet. "Correct by construction" is half-claimed: the permit is structural, the rest is tests.

T 7, D 5, I 3, O 7, S 3. Objection: "Show me it running on v1.signer, then show me the proof covers more than `authorize_sign`."

### Eddy Lazzarin

Relied on: "Provenance is just a chain of cryptographic evidence that something traversed some path between specific hands" (a16z Substack 2026-03-07, V-PAGE) and his wallet praise "seconds, even for a cross-chain transfer" and "$0.38 on a $10k deposit" (2026-10-20, V-X).

The note's provenance (funding txid, attestation payload hash, owner chain via NEP-171 events) fits his frame exactly. But he praises measured speed and cost, and the repo has zero measured attest or sign latency and no BTC fee per note; the sandbox prints Tgas only. Every note address is public and tied to a NEAR owner, which his privacy lens marks down.

T 7, D 5, I 3, O 6, S 3. Objection: "How long does attest take and what does a note cost end to end? No number, no score."

### Mert Mumtaz

Relied on: "Immutable financial code is akin to a spaceship leaving Earth that you have no further control over... It must work, or there will be [a] catastrophe." (2026-06-09 essay via Yahoo, V-PAGE) and "I'm still expecting a big NFT renaissance" (2026-08-18, V-X).

The lone NFT bull, and he checks admin keys first. The contract has no owner and no setters, and `World::keyless()` deletes every key in sandbox. On mainnet there is no `cachet.near` to run `view_access_key_list` against. His spaceship line cuts both ways: keyless plus pinned `v1.signer` shapes (3.17 mainnet, 3.18 testnet per `src/signer.rs:2`) means one interface change strands every note.

T 7, D 5, I 4, O 7, S 4. Objection: "Immutable is the pitch, so where is the deployed, keyless account?"

### Avichal Garg

Relied on: "What happens if there's not a human behind it at all? It's some piece of code that owns a wallet, executing code to make more money..." (NEARCON 2026 via CoinDesk 2026-02-24, V-PAGE), and the Empire digest line "productive assets with real revenue" (kazuha.ai, V-SUMMARY, digest wording, not his).

A note is code that owns a wallet, but it does not make money: it is a monetary instrument with no yield and no fee. VERDICT already expects a 4 from him; with nothing deployed it is lower.

T 6, D 4, I 2, O 5, S 2. Objection: "What is the cash flow?"

### Kain Warwick

Relied on: "People do not care about custody. They care about utility, right?" (The Defiant 2026-01-30, V-PAGE), "We also have a proof of concept implementation of BTC support that uses NEAR chain signatures" (Paragraph 2025-01-09, V-PAGE), "NFTs are not currently in in the best shape" (Defiant transcript).

He built a BTC chain-signatures POC himself, so he knows what a fixture signer is and will look for a real sweep on mempool.space first. There is no UI: the product today is a Rust crate and near-cli calls. His "Why is Infinex so boring?" lens lands on that.

T 7, D 3, I 3, O 5, S 3. Objection: "I did this as a POC. Where is the thing a person uses?"

### Haseeb Qureshi

Relied on: "Something that works with money 90% of the time is unusable for actual economic activity." and "You want to be very cautious of trying to ingest your worldview of technology by reading Twitter hype people and watching Twitter demos." (NEARCON 2026 via CoinDesk 2026-02-23, V-PAGE).

The best fit on the panel for what is built: must-fail tests per guard, a mutation script, callbacks that roll back, ecrecover on every MPC signature, low-S folding. He will ask for the real-money success count, which is zero runs. He will also find the stranding case: a second payment to a note address can never be swept, because `attest` binds one output, the sweep is one-input, slot is always 0, and `finalize` burns the id for good.

T 8, D 5, I 3, O 6, S 3. Objection: "Zero mainnet runs, and a user who tops up a note loses the top-up."

### Stepan Gershuni

Relied on: "cypherpunk is not dead - instead of NFT and DAO it's just swarms of AI agents with Coasean bargaining" (2026-02-22, V-X) and "UX of Near intents is better than any other chain in crypto" (2025-11-07, V-X).

He dismisses NFTs on sight. The only lever VERDICT gave for him, the Intents sale, is not built: `tests/intents.rs` shows `intents.near` holding a note, not selling one.

T 6, D 4, I 2, O 5, S 2. Objection: "NFT, no agents, no Intents trade. Next."

### Panel means today

| | T | D | I | O | S |
|---|---|---|---|---|---|
| Today | 6.9 | 4.4 | 2.9 | 5.9 | 2.9 |
| VERDICT plan for the Wax shape (KILL-judges) | 8.3 | 6.7 | 4.6 | 7.4 | 4.8 |

The gap to the plan is evidence and surface, not contract quality.

## Kill shot

Every signature and every Bitcoin confirmation this repo has ever seen came from `fixtures/signer`, a harness whose root keys the test picks. There is no `cachet.near`, no tx hash, no sweep on mempool.space, and no README. Until one real note goes mint, attest, unseal, sweep, finalize against `v1.signer`, "an NFT that owns bitcoin" is a claim, and the judge who built a BTC chain-signatures POC himself checks that first.

## Three changes, each under a day

1. **One real note, end to end, written into `docs/EVIDENCE.md`.** Human signs: deploy to `cachet.near` (or a sub-account) with `new({"signer_id":"v1.signer","hrp":"bc","confirmations":2})`, fund one note with a 5,000-sat output, attest, unseal to a team bc1q, broadcast `signed_sweep_tx`, finalize after 2 confirmations, delete all keys. Record every NEAR tx hash, both BTC txids, `view_access_key_list` with block height, measured attest and sign latency (block delta), Tgas and sat fee. Cost per VERDICT section 9: about 0.2 NEAR plus the UTXO. Wall time is dominated by two 2-confirmation waits (about 40 minutes). Run the negative cases from VERDICT section 9 in the same session (all-zero txid, `confirmations` too high). This removes the kill shot and gives Eddy and Haseeb their numbers.
2. **A note page a judge can use without near-cli.** One static page: reads `note(token_id)` over RPC, shows the bc1q address with a mempool.space link, state and attestation hash; "Make claim link" generates an ed25519 keypair client-side and puts the secret in the URL fragment; the recipient page signs `cachet-claim:<contract>:<token>:<new owner>` and submits `claim`, then offers `unseal` to a pasted bc1q. Today no tool in the repo produces a claim signature, so the gift-by-link verb has no user path. This is the Kain and design fix, and it is how judges receive funded notes.
3. **Intents sale as a sandbox test against the real `intents.wasm`.** The fixtures already deploy `intents.near` and `wrap.near` from mainnet bytes. Add a test where seller and buyer each register a key on `intents.near` and sign a `token_diff` (seller: minus `nep171:<cachet>:<id>`, plus wNEAR; buyer: the reverse), a relayer calls `execute_intents`, then assert the buyer can `nft_withdraw` and unseal while the seller cannot. Confirm in near/intents source that `token_diff` accepts nep171 ids before starting. This turns `tests/intents.rs` from "a lock" into "a trade", the one thing Stepan, Illia and Haseeb credit. Mainnet 1Click from Solana stays a separate, later step.

The README is not on this list because it is not optional; it is item 1 of the screen fixes below.

## What the Claude Code and Codex screen fails on today

Ordered by damage.

1. **No README.md** (`git ls-files` has none). No product sentence, no run steps, no NEAR usage table, no Q-005 library list, no Q-015 disclosure. HACKATHON.md procedure step 1 asks for exactly this.
2. **`source scripts/env.sh` fails on a clean clone.** It sources `../../env.sh`, a file outside the repo (`/Users/kamal/Desktop/near/build/env.sh`), which hardcodes `CARGO_TARGET_DIR=/Users/kamal/...`. The first command in AGENTS.md errors, and `scripts/mutate.sh` sources it too.
3. **Prerequisites undocumented.** Tests shell out to `cargo near build` (`tests/common/mod.rs:89`) and panic "cargo-near is not installed" without it. Not stated: cargo-near version (Cargo.toml pins image `cargo-near:0.16.0-rust-1.86.0`), `rustup target add wasm32-unknown-unknown`, `jq`, network access for the near-sandbox download and `view_code`. No `rust-toolchain.toml`.
4. **`cargo test` is not one command.** `fixtures/wasm/` is gitignored, so `tests/intents.rs` panics "intents.wasm missing: run scripts/fetch-fixtures.sh" until the fetch runs. Needs one `scripts/test.sh` that fetches then runs every suite.
5. **Cited files missing.** AGENTS.md cites `docs/TESTS.md` and `docs/SPIKE.md`; `src/signer.rs:2-3` says shapes "are pinned against the live contract in docs/SPIKE.md". Neither exists. A screener opens the file named and finds nothing. The AGENTS rule "a mutation row in docs/TESTS.md" cannot be satisfied.
6. **Only a stand-in signer has been exercised.** `fixtures/signer` is legitimate test infrastructure, deployed only in sandbox. With no real run anywhere, it is the sole evidence for the Chain Signatures path, and a feature-verification pass will report it that way. `spikes/chainsig/probe` and `consensus` exist with no FINDINGS or output, so spike status is unreadable.
7. **Untracked `mitm_mcp_traffic.db` (24 KB) in the repo root, not in `.gitignore`.** One `git add -A` publishes captured MCP traffic, which may hold tokens. Add it to `.gitignore` before anything else.
8. **Name and assertion disagree.** `signing_is_reachable_from_exactly_two_configurations` in `src/lib.rs` asserts three tuples; the third is `Resign` with `claim_locked` true. A code-reading judge flags this. Rename to "two states" or have `resign` pass the real `claim_locked`.
9. **Commit dates.** All commits are 2026-10-31 +0530, before 2026-11-01. Q-001 allows work from 2026-10-19, but the inferred screener heuristic (JUDGES.md section 9, rewarded item 5) flags pre-11-01 history. One README line citing Q-001 defuses it.
10. **No CI.** A GitHub Actions run of the full suite is the cheapest proof that tests pass from a clean checkout.
11. **64-byte guard has no mutation row** in `scripts/mutate.sh`, and `tests/paper_design.rs` is untracked.

Secrets needed: none for tests. `.env.example` lists RPC URLs and an empty probe account only. Mainnet runs need a funded NEAR account and BTC, both held by the human.

## Submission blockers that are not code

- Owner slot under Q-015 is still MISSING (WIN-CONDITIONS line 14): one person or email can carry at most 2 entries. The Q-015 sentence in SUBMISSION.md must be cut down to the submitter's actual other entry once that is decided.
- `docs/X-POST.md` carries `REPO_URL`; the human supplies it. The variant that offers a funded note commits team BTC: the human approves the amount first.
- Post the X demo only after `docs/EVIDENCE.md` holds the mainnet sweep txid; the demo script assumes it.
- `docs/SUBMISSION.md` describes only what the code does today. Once EVIDENCE.md exists, add one sentence with the `cachet.near` account, the sweep txid and the measured latency.
