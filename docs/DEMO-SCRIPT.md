# Cachet demo, 90 seconds

One moment: a bitcoin note changes hands on NEAR with no bitcoin transaction, and the new holder unseals it into a sweep that lands on mempool.space. The sender cannot stop it, and a stranger cannot do it.

## NEAR's role, concretely

| NEAR piece | What it does in Cachet | Where |
|---|---|---|
| Chain Signatures, `derived_public_key` | Gives each note its own bitcoin key on path `cachet/<token>/0`, with the contract as predecessor. No pool, no wrapped token. | `src/lib.rs` `mint_note` |
| Chain Signatures, domain 3 `verify_foreign_transaction` | Confirms the funding txid is on Bitcoin with 2 confirmations. The contract hashes the raw tx itself to get the txid and reads the amount from the bytes. | `src/lib.rs` `attest`, `finalize` |
| Chain Signatures, domain 0 `sign` | Signs the BIP143 sweep that only the current owner can request. One call site, behind a permit. | `src/lib.rs` `request_signature` |
| Access keys | `cachet.near` has zero. No admin, no upgrade, nobody to take the bitcoin. The claim-link key is an ed25519 key the contract checks with `env::ed25519_verify`, not a NEAR access key. | `view_access_key_list` |
| NEAR Intents | While `intents.near` holds a note, nobody can unseal it: a listing lock that comes free with custody. | `tests/intents.rs` |
| NEAR AI Cloud, Sputnik DAO | Not used in Cachet. | |

## Before recording

Every on-camera step is a real mainnet transaction. Bitcoin confirmations take about 10 minutes each, so these are staged first, by the human, who signs everything:

1. `cachet.near` deployed with `new({"signer_id":"v1.signer","hrp":"bc","confirmations":2})`, then every access key deleted.
2. Note 1 minted by `OWNER`, funded with one output of at least 5,000 sats to its address, 2 confirmations, attested. Fund each address once only: a second payment to the same address cannot be swept.
3. Note 2 minted, funded, attested, unsealed and swept, sweep at 2 confirmations, not yet finalized.
4. Three team accounts, labelled as team accounts on screen: `OWNER`, `STRANGER`, `RECIPIENT`. No outside users appear and none are implied.

Shell setup used by every shot:

```sh
RPC=https://rpc.mainnet.fastnear.com          # NEAR_MAINNET_RPC in .env.example
C=cachet.near
OWNER=...; STRANGER=...; RECIPIENT=...        # the three team accounts
DEST=bc1q...                                  # RECIPIENT's own bitcoin address
call() { near contract call-function as-transaction $C "$1" json-args "$2" prepaid-gas '300.0 Tgas' attached-deposit "${4:-0 NEAR}" sign-as "$3" network-config mainnet sign-with-keychain send; }
view() { near contract call-function as-read-only $C "$1" json-args "$2" network-config mainnet now; }
```

Screen layout: terminal left, browser right (mempool.space and NearBlocks).

## Shots

**0:00 to 0:08. The problem.**
On screen, one line of text: "You can hand someone a bitcoin card. You can't send one by link without a custodian."
Browser: `https://mempool.space/address/<note 1 address>` showing the confirmed funding output.
Voice: "This bitcoin address belongs to an NFT."

**0:08 to 0:18. Nobody holds the key.**
```sh
curl -s $RPC -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"cachet.near"}}' \
  | jq '{keys: .result.keys, block: .result.block_height}'
```
Expected: `"keys": []` and a block height.
Voice: "The contract holding it has zero keys. No admin, no upgrade."

**0:18 to 0:30. Bitcoin, confirmed by NEAR.**
```sh
view note '{"token_id":"1"}'
```
Expected: `"state": "Sealed"`, `utxo.txid` equal to the txid on mempool.space, `attestation_payload_hash`.
Voice: "NEAR's MPC network confirmed this deposit on Bitcoin. The contract hashed the raw transaction itself to read the amount. No oracle."

**0:30 to 0:38. A stranger tries.**
```sh
call unseal "{\"token_id\":\"1\",\"btc_dest\":\"$DEST\",\"fee_rate\":5}" $STRANGER
```
Expected: failure `only the note owner can request a signature`.
Voice: "Anyone else who asks for a signature is refused."

**0:38 to 0:48. The handoff.**
```sh
call nft_transfer "{\"receiver_id\":\"$RECIPIENT\",\"token_id\":\"1\"}" $OWNER '1 yoctoNEAR'
```
Browser: refresh the mempool.space address page; no new bitcoin transaction.
Voice: "It changes hands on NEAR. On Bitcoin, nothing moved."

**0:48 to 1:10. The new holder unseals. This is the moment.**
```sh
call unseal "{\"token_id\":\"1\",\"btc_dest\":\"$DEST\",\"fee_rate\":5}" $RECIPIENT
HEX=$(curl -s $RPC -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$C\",\"method_name\":\"signed_sweep_tx\",\"args_base64\":\"$(printf '{"token_id":"1"}' | base64)\"}}" \
  | jq -r '.result.result | implode | fromjson')
curl -s -X POST -d "$HEX" https://mempool.space/api/tx
```
Expected: `unseal` returns `true`; the POST returns a txid.
Browser: `https://mempool.space/tx/<that txid>` showing the sweep to `DEST`.
Voice: "NEAR Chain Signatures signed the sweep because the new holder asked. It's on Bitcoin now."
Edit note: if the MPC signature takes longer than a few seconds, cut the wait and show the start and end block heights on screen. Do not speed up footage without saying so.

**1:10 to 1:20. Frozen once unsealed.**
```sh
call nft_transfer "{\"receiver_id\":\"$OWNER\",\"token_id\":\"1\"}" $RECIPIENT '1 yoctoNEAR'
call unseal "{\"token_id\":\"1\",\"btc_dest\":\"$DEST\",\"fee_rate\":5}" $RECIPIENT
```
Expected: `note cannot move in this state`, then `note is not sealed with attested funding`.
Voice: "An unsealed note can't be sold or unsealed twice."

**1:20 to 1:30. Burned after the sweep confirms.** (note 2, staged)
```sh
SWEEP=$(curl -s https://mempool.space/api/tx/<note 2 sweep txid>/hex)
call finalize "{\"token_id\":\"2\",\"sweep_raw_tx\":\"$SWEEP\"}" $OWNER
view nft_token '{"token_id":"2"}'
```
Expected: `finalize` returns `true`; `nft_token` returns `null`.
Browser: NearBlocks page for the finalize tx.
End card: repo URL and "Built at NEAR HACKATHON".

## What is on screen with zero outside users

Three team accounts, labelled as such; two notes the team funded; one mainnet sweep on mempool.space; one burn on NearBlocks; one `[]` from `view_access_key_list`. The video claims no users, volume or demand. Judges get the same experience by receiving a funded note from the team after submission.
