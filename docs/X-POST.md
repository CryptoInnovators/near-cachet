# X demo post, drafts

`REPO_URL` is the public repo link, supplied by the human. X counts any URL, including a bare `mempool.space`, as 23 characters. Measured that way: A 275, B 272, C 278, long-form 1,283. Attach the 90-second video from docs/DEMO-SCRIPT.md to every variant.

## Variant A (lead with the problem)

```
You can hand someone a bitcoin card. You can't send one by link without a custodian.

Cachet, built at NEAR HACKATHON: an NFT that owns a bc1q address. Only its holder can unseal it; NEAR Chain Signatures signs the sweep.

@NEARProtocol #NEARHackathon REPO_URL
```

## Variant B (lead with the moment)

```
Sending bitcoin by link means someone else holds the key.

Video: a bitcoin note changes owner on NEAR, a stranger's unseal fails, the new owner's sweep hits Bitcoin. The contract has zero keys.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon REPO_URL
```

## Variant C (next step: try one)

Needs the human's OK on the amount before posting, because it commits team bitcoin.

```
Bitcoin by link that the sender can't take back.

Each Cachet note is a NEAR NFT with its own bitcoin address; NEAR Chain Signatures signs only for the holder. Built at NEAR HACKATHON.

Reply with a .near account to get one.

@NEARProtocol #NEARHackathon REPO_URL
```

## Long-form

```
You can hand someone bitcoin in person on a sealed card. Over the internet there's no equivalent: send to their address and you need to ask for it first, use an ecash link and you're trusting a mint.

Cachet is my NEAR HACKATHON entry: a bitcoin note that is an NFT.

Each note owns a real bc1q address. NEAR Chain Signatures derives it for the contract, so no bridge pool and no wrapped token. When you fund it, the contract hashes the raw bitcoin transaction itself to read the amount, and NEAR's MPC network confirms that transaction on Bitcoin (verify_foreign_transaction). No oracle.

From then on the note moves like any NFT on NEAR, with no bitcoin transaction. Only the current holder can unseal it: the contract builds the sweep, NEAR Chain Signatures signs it, and the note freezes until the sweep confirms, then burns.

The contract has zero access keys. No admin, no upgrade. What you trust is the NEAR MPC signer threshold, and I'd rather say that than call it trustless.

In the video: a stranger's unseal fails, the note changes hands, the new holder's sweep lands on mempool.space.

Question for bitcoin people: what would you send by link first, and what would stop you?

Repo: REPO_URL
@NEARProtocol #NEARHackathon @NearBuilders @NearLegion
```
