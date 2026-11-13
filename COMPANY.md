# Cachet

Cachet is a NEAR application that turns a Bitcoin UTXO into a transferable NFT note whose current owner can authorize its Bitcoin sweep.

## Who uses it

Bitcoin givers use Cachet to send a funded note by link; recipients claim the note and can pass it on or sweep its Bitcoin to an address they choose.

## How it works

The NEP-171 contract derives a Bitcoin key for each note through NEAR Chain Signatures, records the funding output after the configured Bitcoin light client verifies inclusion, and permits only the note owner to request a sweep signature. Claim links are verified by the contract. The Worker hosts the browser and Telegram claim flow. The public demo reads NEAR and Bitcoin state directly.

## Evidence

| Fact | Evidence |
|---|---|
| A funded Bitcoin testnet note was claimed, unsealed, swept, and burned. | [attest](https://explorer.testnet.near.org/transactions/F7yT17CT5GxU4nUhJQBvybEShzdeKKxik9cUAAHCVrkg), [claim](https://explorer.testnet.near.org/transactions/6kyB3vQ24Ezrmj12WJm64Np3CuXLUJrrs1TrRWWVuSSJ), [unseal](https://explorer.testnet.near.org/transactions/8bMnmy5muiiTGUk88Sz9n7z44cfuAg8c2fd57bwjZJx2), [Bitcoin sweep](https://mempool.space/testnet/tx/dc4e322b039eecf10a5d4f02cde246b4406b7845fc9ed9345b97df2654fffdde), [finalize](https://explorer.testnet.near.org/transactions/FwLo9qXY666vMQ8rwPYKGXPnfkzou11vrkFzqR2RDAJW) |
| A walletless link claim assigned a sealed note to the generated implicit account. | [Walletless linkdrop evidence](docs/EVIDENCE.md#walletless-linkdrop-claim-2026-11-11); `scripts/ops-judge-envelope.sh check` reads the claim key from testnet. |
| The current payout-enabled build was deployed without an access key. | [deploy](https://explorer.testnet.near.org/transactions/Ae267gBpvTijuiqonz4s9eyoDDSnf6Z2TrspPxiM6pXf), [key deletion](https://explorer.testnet.near.org/transactions/EaikCHsyjeruzqGCdoqkQJdunQrVt7U42tfvhRKKFAEM), [`scripts/check-judge-page.mjs`](docs/EVIDENCE.md) |
| Git history records `kamalbuilds` as commit author from 2026-10-31 through 2026-11-13. | `git log --reverse --format='%ad %an' --date=short`; `git log -1 --format='%ad %an' --date=short`. |

## Try it in 60 seconds

Open [the live Cachet app](https://near-cachet.earn-shield-alerts.workers.dev), open a note, then choose **Show how it is checked**. The page reads its NEAR note, signer key and Bitcoin funding proof. A claim link is available from the note page.

## Why NEAR

NEAR Chain Signatures derives the note key and signs the owner-authorized Bitcoin sweep. The contract also verifies foreign Bitcoin transaction inclusion through the configured light client. A sandbox test demonstrates that custody by `intents.near` prevents unsealing while the note is listed. Cachet does not use NEAR AI Cloud or Sputnik DAO.

## Team and build window

Git history records `kamalbuilds` as commit author from 2026-10-31 to 2026-11-13. The dates come from the first and latest commits; see the commands in the evidence table.
