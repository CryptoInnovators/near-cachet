# Cachet submission fields

Fields the human decides (project name, lead, email, team size, payout account, repo URL, demo URL, consent) are not drafted here; HACKATHON.md "What the human decides" lists them.

## idea ("What did you build")

```
Problem: bitcoin can be handed over in person as a sealed bearer card (Coinkite SATSCARD, OPENDIME), but not sent over the internet without a custodian. Ecash by link is a claim on its mint, and a token-bound account can be emptied by its seller mid-sale.

Product: Cachet is a NEP-171 NFT contract on NEAR where each note owns a native bitcoin address. mint_note derives a P2WPKH address from v1.signer derived_public_key on path cachet/<token>/0, with the contract as predecessor. attest takes the funding transaction's raw bytes, hashes them to the txid in the contract, checks that the output pays the note and reads the amount, then asks the NEAR MPC network (verify_foreign_transaction, domain 3) to confirm the txid on Bitcoin. A sealed note moves with nft_transfer and no bitcoin transaction. Only its current owner can unseal: the contract builds the BIP143 sweep, v1.signer signs it on domain 0, the contract checks the signature recovers to the note key, and the note freezes. finalize burns it once the sweep is confirmed on Bitcoin. Gift by link: the owner registers an ed25519 claim key, and whoever holds the secret moves the note to an account they name. While intents.near holds a note, nobody can unseal it.

How NEAR fits: Chain Signatures gives a contract its own bitcoin keys and a bitcoin confirmation check with no bridge pool and no oracle. The contract has no owner method and no setters; v1.signer.sign has one call site, behind a permit that only the owner check issues. The trust root is the NEAR MPC signer threshold.

Tests: sandbox suites against real mainnet bitcoin transactions and the mainnet intents.near code, and a mutation script that breaks each of 25 guards and expects a red test.
```

## tracks

```json
["nfts", "defi"]
```

- `nfts`: the brief asks for "assets that own money"; each note owns a native bitcoin UTXO and its behaviour is the seal, enforced by NEP-171 transfer hooks.
- `defi`: native bitcoin custody by a keyless contract through Chain Signatures, with `intents.near` custody acting as the listing lock; the track's hints name Chain Signatures and NEAR Intents.

## Q-015 disclosure (README and submission)

```
The same team also builds Voucher, Overdraft, Receipts, Customs, Long Con, Sworn and Taster for NEAR HACKATHON; each is an independent repository, and Cachet shares no code or crate with any of them.
```
