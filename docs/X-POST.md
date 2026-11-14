# X demo post drafts

The human edits and posts these. Attach the demo video from `docs/DEMO-SCRIPT.md` to the post. X counts any link as 23 characters, and the counts below assume that.

## A (269 characters)

```unknown
A Bitcoin red envelope that only the named person can sweep.

Built at #NEARHackathon: Cachet, a NEP-171 NFT that owns a Bitcoin output. NEAR Chain Signatures signs the sweep only for the holder. A heir note pays one bound address. https://near-cachet.earn-shield-alerts.workers.dev/ @NEARProtocol
```

## B (262 characters)

```unknown
Sell the NFT and the Bitcoin goes with it. Each Cachet note is an NFT with its own Bitcoin address, and the contract holds no signing key and no upgrade key.

Built at #NEARHackathon, running on Bitcoin testnet. Take a note: https://near-cachet.earn-shield-alerts.workers.dev/ @NEARProtocol
```

## C (216 characters)

```unknown
Tap Take note. About ten seconds later you hold a Bitcoin note on NEAR. Press Pass it on and a link moves it to someone else in one transaction.

Built at #NEARHackathon: Cachet. https://near-cachet.earn-shield-alerts.workers.dev/ @NEARProtocol
```

## Long form (893 characters)

```unknown
Bitcoin held through an NFT usually sits in a token-bound account, and the seller can empty it while the NFT is being sold. The buyer receives an empty account.

We built Cachet at #NEARHackathon so the NFT is the Bitcoin. Each token is one native Bitcoin output. mint_note asks the NEAR MPC signer for a P2WPKH address, anyone funds it, and a Bitcoin light client verifies the funding proof. The contract holds no signing key and no upgrade key. Only the current owner can ask the signer to unseal, and nft_transfer or a one-use claim link is the only way the owner changes.

An heir note fixes one Bitcoin destination at creation. Unseal to any other address is refused on chain. It arrives as a red envelope in a Telegram Mini App.

Open the live page on Bitcoin testnet, press Take note, then Pass it on. No wallet.

Try it: https://near-cachet.earn-shield-alerts.workers.dev/

@NEARProtocol @NearBuilders @NearLegion
```
