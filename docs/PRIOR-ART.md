# Cachet: academic prior art

Run 2026-10-31. Product: sealed bitcoin notes (NEAR NFT, per-note BTC address from `v1.signer`, `attest` via `verify_foreign_transaction`, owner-only `unseal`). Source plan: docs/research/tracks/nfts/VERDICT.md.

Every paper below had its abstract opened. Three had body text opened: Merkle (WTSC25 PDF), NFTAA (arXiv PDF), Chaumian ecash (abstract only, PDF returned an HTML gate). Marked per entry.

## Papers

### 1. Revisiting Bitcoin's Merkle Tree Security: Practical Implications and an Attack on Core Chain
Financial Cryptography and Data Security workshops (WTSC 2025), Springer 2026. DOI 10.1007/978-3-032-00492-5_10. PDF https://fc25.ifca.ai/wtsc/PAPERS/WTSC25_paper1.pdf (full text read).
Measured: a 64-byte Merkle inner node can be read as a valid 64-byte transaction, which let the authors forge an inclusion proof against Core Chain's Bitcoin light client (more than 500M USD at risk at report time).
Implies: ATTACK TO DEFEND. Cachet's `attest` parses a caller-supplied raw tx. The paper's cheapest mitigation is to reject any tx whose witness-stripped serialization is exactly 64 bytes. Add that check plus a must-fail test. The paper also says this mitigation alone is not complete for light clients, which is why the MPC confirmation call must stay in the path and the parser must not stand alone.

### 2. Towards Proxy Staking Accounts Based on NFTs in Ethereum (NFTAA)
arXiv:2404.14074, 2024 (IEEE conference preprint). https://arxiv.org/abs/2404.14074 (body read, section on ERC-6551 comparison).
Measured: a design comparison, not a benchmark. It names two token-bound-account failure modes: assets sent to a TBA address that has no executable account become locked forever, and the holder can withdraw assets from the account while selling the NFT, so the buyer receives an empty account.
Implies: MECHANISM TO ADOPT AS THE CLAIM. The second failure is the rug-on-sale that Cachet's seal removes: no method reaches `sign` until the holder unseals, and unseal freezes transfers. Cite this paper as the named problem. DESIGN CHANGE: address-before-deploy lock-up is also Cachet's risk (funds sent to a derived address before `mint_note` finishes); only show a funding address after `mint_note` receipt succeeds.

### 3. SoK: Security of Cross-chain Bridges: Attack Surfaces, Defenses, and Open Problems
RAID 2024. DOI 10.1145/3678890.3678894. arXiv:2312.12573 https://arxiv.org/abs/2312.12573.
Measured: 12 attack vectors and a taxonomy of 10 attack types across bridge incidents, grouped by verification mechanism.
Implies: CLAIM TO SHARPEN. Cachet has no bridge pool and no wrapped token, so the pooled-custody classes (validator-key compromise, mint/burn mismatch) do not apply to it. The remaining surface is the verification step (`attest`) and the signer set. State exactly that, not "bridgeless means safe".

### 4. Bridging Bitcoin to Second Layers via BitVM2
USENIX Security 2026 (per the usenix.org prepub PDF); IACR ePrint 2025/1158. https://eprint.iacr.org/2025/1158.
Proved: a light-client-based Bitcoin bridge whose setup trust drops from t-of-n honest to 1-of-n existential honesty, with permissionless challengers; a challenge was executed on Bitcoin mainnet.
Implies: CLAIM TO DROP. Do not say "trustless" or "trust-minimized" for Cachet. The unseal path trusts the NEAR MPC threshold (11 of 16 per VERDICT). Say "threshold-controlled, keyless contract" and name the trust root. BitVM2 is the number to point at as what real trust minimization costs.

### 5. Threshold ECDSA in Three Rounds (DKLs23)
IEEE S&P 2024. IACR ePrint 2023/765. https://eprint.iacr.org/2023/765.
Proved: three-round threshold ECDSA with malicious security against a dishonest majority, UC-secure under ideal commitment and two-party multiplication.
Implies: MECHANISM CONTEXT. This is the signing family the BTC key sits behind. Cachet's latency budget (sign inside 60 s per spike) is dominated by NEAR yield/resume, not the rounds. Do not claim anything about the MPC protocol's security in the README beyond linking the NEAR audits.

### 6. Alpha-Rays: Key Extraction Attacks on Threshold ECDSA Implementations
IACR ePrint 2021/1621. https://eprint.iacr.org/2021/1621.
Measured: full secret-key extraction from GG18/GG20 implementations by one malicious party, in 8 signatures (fast MtA) or 1 signature (small Paillier key).
Implies: ATTACK TO NAME. Every note address is a derived child of one MPC root key, so a root-key extraction empties all notes at once. Cachet cannot defend this; it must disclose it as the shared-root risk and keep per-note value small. Add a per-note cap in the UI copy and EVIDENCE.md.

### 7. Threshold ECDSA for Decentralized Asset Custody
IACR ePrint 2020/498. https://eprint.iacr.org/2020/498.
Proved: a threshold ECDSA with robustness and fault attributability for large committees, with LAN and WAN experiments.
Implies: NUMBER TO FRAME. Liveness, not secrecy, is the failure mode for large committees: a sign request can stall. Cachet's `resign` and a user-visible "signature pending" state are required, which VERDICT already lists as a cut candidate. Keep `resign`; it is the liveness answer.

### 8. Blind Spots in Blind Signatures: A System-Level Security Analysis of Deployed Chaumian Ecash
IACR ePrint 2026/2174, September 2026. https://eprint.iacr.org/2026/2174 (abstract only; PDF fetch returned an HTML gate).
Measured: all 58 indexed Cashu mints; every deployed incident is compositional (keyset rotation, wallet recovery, multi-mint identity), including a cross-mint theft disclosed in early 2026, and the stated lesson is "recoverability is not free".
Implies: COMPETITOR WEAKNESS, WITH A MATCHING RISK. This is the strongest citation for "a bearer note without a mint". It also warns that recovery features create theft paths. Cachet's `resign` (same locked destination only) and the claim-link key are the recovery paths. Each needs a must-fail test that a recovery action cannot redirect funds.

### 9. Proof of reserves and non-double spends for Chaumian Mints
arXiv:2306.12783, 2023. https://arxiv.org/abs/2306.12783. The arXiv record is marked withdrawn, with a note of an error in section 3.1.
Stated: a Chaumian mint requires trust in the server to prevent double spends and not to debase the token; the paper proposed a proof-of-reserves scheme.
Implies: CLAIM, USE WITH CAUTION. Cite only the problem statement (mint trust), never the withdrawn scheme. Do not use it as evidence that Cashu has a reserves proof.

## DESIGN CHANGES

1. Reject any raw tx whose witness-stripped length is 64 bytes in `attest`, add a must-fail test with a crafted 64-byte object (paper 1). Keep the MPC confirmation call mandatory.
2. Show a funding address only after the `mint_note` receipt succeeds, so no BTC lands on an address whose note was never minted (paper 2).
3. Add a must-fail test that a recovery path cannot redirect funds: `resign` to a new destination, and the claim-link key calling anything but `claim` (paper 8).
4. Replace "trustless" and "bridgeless means safe" with named trust roots: the MPC threshold and the shared derived-key root (papers 3, 4, 6).
5. Cap value per note in the demo and docs, and say why: one root key backs all notes (paper 6).
6. Keep `resign` out of the cut list; it is the liveness answer to stalled signing (paper 7). Revise the VERDICT cut order to drop the Intents sale before `resign`.
7. Use the rug-on-sale framing as the lead problem: a token-bound account can be emptied during a sale (paper 2); a sealed note cannot.

## README SENTENCES

Token-bound accounts can be emptied by the seller while the NFT is being sold, a fraud class named in the ERC-6551 comparison of Valastin et al. (https://arxiv.org/abs/2404.14074); a Cachet note has no signing path until its holder unseals it, and unsealing freezes transfers.

Cachet's raw-transaction parser rejects 64-byte transactions, the construction behind the Bitcoin Merkle-tree forgery shown against Core Chain's light client (https://fc25.ifca.ai/wtsc/PAPERS/WTSC25_paper1.pdf).

Deployed Chaumian ecash has had a cross-mint theft and is a claim on a mint (https://eprint.iacr.org/2026/2174); a Cachet note is a native Bitcoin output at its own address, with its trust placed in the NEAR threshold signer set rather than a mint.

## BLIND SPOTS

- Search tooling: `papers search` returned nothing. OpenAlex answered "Rate limit exceeded" (shared free budget spent) and Semantic Scholar answered 429; the CLI also calls arXiv over http, which does not return results without following the redirect. Discovery therefore ran through exa/Parallel web search (about 9 queries, free tier throttled mid-run) and arXiv/eprint pages, with abstract reads by `exa fetch` and `curl`. No citation-graph follow-up (`papers cite`) ran. Retry after midnight UTC or set an OpenAlex key.
- Venue/year for NFTAA (IEEE conference name truncated in the abstract page) and the BitVM2 USENIX 2026 listing (taken from a prepub PDF URL) were not confirmed against a proceedings page.
- Paper 8 PDF did not load, so its theorem and measurements are abstract-level only. Paper 4, 5, 6, 7 are abstract-level only.
- No paper found that studies NFT-controlled Bitcoin wallets directly, or measures consumer demand for remote bearer Bitcoin. "Unwanted" vs "unique" remains unresearched in the literature.
- Topic searches for threshold-ECDSA-plus-Bitcoin on arXiv with strict phrase queries returned nothing; eprint carries most of this literature, and eprint has no keyword API used here.
- The 64-byte rule is a mitigation the paper itself calls insufficient on its own for light clients. Whether `v1.signer`'s foreign-chain inspector applies it was not read in source.
