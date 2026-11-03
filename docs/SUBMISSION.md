# Cachet submission fields

Fields the human decides (project name, lead, email, team size, payout account, repo URL, demo URL, consent) are not drafted here; HACKATHON.md "What the human decides" lists them.

## idea ("What did you build")

```
Problem: a sealed bearer card can hand Bitcoin to someone in person, but it needs a courier. A seed phrase or ecash link needs the receiver to trust how the funds are held. A token-bound account can also be emptied by its seller while an NFT sale is in progress.

Product: Cachet makes each Bitcoin note a NEP-171 token on NEAR. `mint_note` derives a P2WPKH address from `v1.signer` at `cachet/<token>/0`, with the contract as predecessor. `attest` parses the funding transaction, checks that its output pays the note, and asks the configured Bitcoin light client to verify the transaction's inclusion proof and confirmation depth. A sealed note transfers without a Bitcoin transaction. Its owner can unseal it: the contract builds a BIP143 sweep, the signer signs on domain 0, and the contract verifies the signature against the note key before freezing the note. `finalize` burns the token after the light client verifies the sweep. A claim link lets its holder move the note to a NEAR account they choose.

How NEAR fits: Chain Signatures derives each Bitcoin address from the NEAR MPC signer and signs the owner's sweep. The Omni Bridge Bitcoin light client verifies funding and sweep inclusion proofs. The contract has no admin method or upgrade key, and its only signer call is guarded by the owner and note state. The `intents.near` escrow guard prevents a note held in an atomic swap from being unsealed by its seller.

Tests: workspace sandbox suites cover real Bitcoin transaction vectors, the light-client proof interface, claim links, and the `intents.near` contract. The web tests cover claim signatures, network selection, fee guards, and the captured proof vector. Mutation checks remove guards and require their tests to fail before confirming they pass after restoration.
```

## tracks

```json
["nfts", "defi"]
```

- `nfts`: each note owns a native Bitcoin UTXO, and NEP-171 transfer hooks enforce its sealed state.
- `defi`: a keyless contract uses Chain Signatures to control native Bitcoin notes, while the `intents.near` escrow guard protects the note during an atomic swap.

## Q-015 disclosure (README and submission)

```
The same team also builds Voucher, Overdraft, Receipts, Customs, Long Con, Sworn and Taster for NEAR HACKATHON; each is an independent repository, and Cachet shares no code or crate with any of them.
```
