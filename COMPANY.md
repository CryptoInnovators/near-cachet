# Cachet

Cachet is an NFT that owns Bitcoin: whoever holds the NEP-171 token controls one native Bitcoin output, and an Heir note pays one named person only, delivered as a red envelope inside a Telegram Mini App.

## Who uses it

Anyone sending Bitcoin to a friend in a Telegram chat. The named heir opens the envelope in the Mini App; a thief who gets the link can only sweep to the heir's address, and the contract refuses any other destination. The token carries the Bitcoin, its sweep right and its access right: send or sell it and all three move with it, and the contract clears the claim key and revokes approvals on every move, so the old owner keeps nothing.

## How it works

The NEP-171 contract derives a Bitcoin key for each note through NEAR Chain Signatures, records the funding output after the configured Bitcoin light client verifies inclusion, and permits only the note owner to request a sweep signature. Claim links are verified by the contract. The Worker hosts the browser and Telegram claim flow. The public demo reads NEAR and Bitcoin state directly.

## Evidence

| Fact | Evidence |
|---|---|
| A funded Bitcoin testnet note was claimed, unsealed, swept, and burned. | [attest](https://explorer.testnet.near.org/transactions/F7yT17CT5GxU4nUhJQBvybEShzdeKKxik9cUAAHCVrkg), [claim](https://explorer.testnet.near.org/transactions/6kyB3vQ24Ezrmj12WJm64Np3CuXLUJrrs1TrRWWVuSSJ), [unseal](https://explorer.testnet.near.org/transactions/8bMnmy5muiiTGUk88Sz9n7z44cfuAg8c2fd57bwjZJx2), [Bitcoin sweep](https://mempool.space/testnet/tx/dc4e322b039eecf10a5d4f02cde246b4406b7845fc9ed9345b97df2654fffdde), [finalize](https://explorer.testnet.near.org/transactions/FwLo9qXY666vMQ8rwPYKGXPnfkzou11vrkFzqR2RDAJW) |
| A walletless link claim assigned a sealed note to the generated implicit account. | [Walletless linkdrop evidence](docs/EVIDENCE.md#walletless-linkdrop-claim-2026-11-11); `scripts/ops-judge-envelope.sh check` reads the claim key from testnet. |
| The current payout-enabled build was deployed without an access key. | [deploy](https://explorer.testnet.near.org/transactions/Ae267gBpvTijuiqonz4s9eyoDDSnf6Z2TrspPxiM6pXf), [key deletion](https://explorer.testnet.near.org/transactions/EaikCHsyjeruzqGCdoqkQJdunQrVt7U42tfvhRKKFAEM), [`scripts/check-judge-page.mjs`](docs/EVIDENCE.md) |
| Heir notes: the contract fixes the only sweep address at creation. | `bind_heir` [tx](https://testnet.nearblocks.io/txns/AYyNdNb4XKrFAGf8XZijRtZshzZ6zAQJ1SWCwWZ4EXMz) on `heir.cachet-ops.testnet`; any other destination is refused with "this note sweeps only to its heir". |
| A real Telegram account claims an Heir note inside the Mini App in about ten seconds. | [claim, 9.6 s](https://testnet.nearblocks.io/txns/CpztEVc9FQyaGBToLdAinX4mpvs3sq9Lyr8HQst2uDE6), [claim, 10.6 s](https://testnet.nearblocks.io/txns/6vnN9jPLvr5pLqNZN4zWPqVFEZyGTeHWdW7xHz4S2ZiB); `bash scripts/gate-pre.sh` drives it through a Telethon session. |
| Take it anyway is refused on chain. | [refused tx](https://testnet.nearblocks.io/txns/BcbyfrbytfV3Lx2Q37hKucSqpipRsbKv47hVZS2W7Cyp), reason "sweeps only to its heir". |
| The same run passes on a phone-width Mini App and on desktop, 30 of 30 checks each. | 390 px run: [claim, 12.0 s](https://testnet.nearblocks.io/txns/Dq6kuy1Hhtt2XyAG4qnmTRcNtE1q41yGuNaj1MYFJrKh), [refusal](https://testnet.nearblocks.io/txns/3MbJCM9eNMvPJoB1sdeVMYL5t2MJBT94FG2fo7v8KyQt), [Bitcoin sweep to the bound heir](https://blockstream.info/testnet/tx/a500d243b605c03e534fd98b0204ea8d55ea24aa24e3d911c8f91adaf4204ef0); 1440 px run: [claim, 9.1 s](https://testnet.nearblocks.io/txns/GypH7tZr4BjUFYYbqf5ZcBCvSJb6W8uHvZpeYZHw3TMH), [refusal](https://testnet.nearblocks.io/txns/2QLrMtvPKahCehq2uNqiTU43ghjFnVhtUEYxmv3Lk4eL), [Bitcoin sweep](https://blockstream.info/testnet/tx/561e3825f37b2b9eabf1e2b52883c270fb52356add4b38f33188d791d88af9c1). |
| The worker refuses writes without valid Telegram initData and verifies a HOT NEP-413 sign-in against mainnet access keys. | `cd worker && node --test` (initdata and hot tests; each goes red with its check removed). |
| Git history records `kamalbuilds` as commit author from 2026-10-31 through 2026-11-13. | `git log --reverse --format='%ad %an' --date=short`; `git log -1 --format='%ad %an' --date=short`. |

## Try it in 60 seconds

Open [the live Cachet app](https://near-cachet.nearlive.workers.dev), open a note, then choose **Show how it is checked**. The page reads its NEAR note, signer key and Bitcoin funding proof. A claim link is available from the note page.

## Why NEAR

NEAR Chain Signatures derives the note key and signs the owner-authorized Bitcoin sweep. The contract also verifies foreign Bitcoin transaction inclusion through the configured light client. A sandbox test demonstrates that custody by `intents.near` prevents unsealing while the note is listed. Cachet does not use NEAR AI Cloud or Sputnik DAO.

## Team and build window

Git history records `kamalbuilds` as commit author from 2026-10-31 to 2026-11-13. The dates come from the first and latest commits; see the commands in the evidence table.
