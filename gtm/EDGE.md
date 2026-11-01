# Cachet edge sweep

Run: 2026-10-31 UTC. Search lanes: `papers search "Bitcoin bearer transfer ownership protocol NFT UTXO"`, Exa search for NEAR Chain Signatures and UTXO ownership, RivalSearch web search, and direct fetches of first-party NEAR docs and the current NEAR blog.

## Adopted this week

### Chain Signatures now run in TEEs, 2026-10-23

- First-party source: https://www.near.org/blog/chain-signatures-tee
- Verbatim: “all Chain Signatures operations now run inside TEEs (trusted execution environments), enabling independent on-chain verification and further upgrading security of the MPC (multiparty computation) network.”
- Relevant detail: the post reports an 11-of-17 mainnet signing threshold, onchain operator and audit visibility, and a 3-of-5 RPC quorum for foreign-chain deposit reads.
- Companion independent read: https://kot.cash/blog/near-chain-signatures-tee-update, published 2026-10-28. It warns that an attested signing environment does not prove the recipient is correct.
- Adoption in this GTM pass: Cachet's evidence and outreach wording will say threshold-controlled and keyless, name the MPC trust root, and keep transaction recipient and postcondition checks separate from signer-environment claims. No contract or source change was made because this pass is restricted to demand validation.

### Existing implementation surface

- NEAR Chain Signatures docs: https://docs.near.org/chain-abstraction/chain-signatures/implementation
- Verbatim: “There are five steps to create a Chain Signature: 1. Deriving the Foreign Address ... 3. Requesting a Signature ... 5. Relaying the Signed Transaction.”
- The docs link the `chainsig.js` library and `near/omni-transaction-rs`. Cachet already has its own raw Bitcoin transaction path, so this was recorded as an integration boundary, not adopted as a dependency.

### Intents edge

- First-party docs: https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api
- Verbatim: “REST API for cross-chain swaps powered by NEAR Intents.”
- Cachet's intended sale path remains a spike target, not a demand claim. No async sale result was available in this GTM-only pass.

## Paper search result

`papers search` returned no results from OpenAlex, arXiv, or Semantic Scholar for the targeted query. Existing checked-in prior art remains the usable paper set, especially TOOP and the ERC-6551 comparison in `docs/PRIOR-ART.md`. This week’s adopted edge is the first-party TEE announcement, not a guessed new paper.

## Kill list

- Do not claim TEEs make Cachet trustless.
- Do not claim a new SDK was adopted when no dependency or spike was run.
- Do not claim the TEE announcement proves a Bitcoin deposit or recipient postcondition.
