# Cachet web reader

A static, read-only page for one Cachet note on NEAR mainnet. It derives the note address in the browser from the live `v1.signer` key, reads the note record from the contract, lists the contract access keys, and reads Bitcoin activity at the derived address.

There is no build step and no dependency install. The note reader is `index.html`, `app.js` and `style.css`. The claim-link page is `claim.html`, `claim.js` and `claim-lib.js`.

## Run it

From the repository root:

```
python3 -m http.server 8080 --directory web
```

Open port 8080 on localhost in a browser.

The page also works from any static host. It calls the Fastnear mainnet RPC and mempool.space directly from the browser, and both allow cross-origin reads.

## What it reads

| Panel | Source | Call |
|---|---|---|
| Address | Fastnear mainnet RPC | `v1.signer.derived_public_key` with `path`, `predecessor`, `domain_id: 0` |
| Bitcoin activity | mempool.space | `/api/address/<address>` and `/api/blocks` |
| Note record | Fastnear mainnet RPC | `<contract>.note` with the token id |
| Access keys | Fastnear mainnet RPC | `view_access_key_list` on the contract account |

The contract `config` view supplies the signer account and the bech32 prefix. The address panel derives from the live `v1.signer` key for any contract account, and each other panel prints the exact chain response for the account it reads.

Every result names its source and the NEAR block it was read at.

## Query parameters

The form supports a contract account, a token id, and a derivation slot. It writes `contract`, `token`, and `slot` to the URL, so a read can be linked.

The default is `cachet.near`, token `1`, slot `0`.

## Address derivation

The page treats the signer key as a 64-byte secp256k1 point, compresses it to 33 bytes, hashes it with HASH160, and encodes a bech32 version 0 P2WPKH address. SHA-256 and RIPEMD-160 are implemented in `app.js`, so the output does not depend on a wallet or an external crypto library.

`node web/app.js` is safe to run for a syntax check. The crypto functions and BIP173 vectors are exported on `globalThis.cachetInternals` for local testing.

## Read-only by design

The page reads live chain state. Wallet connection, signing, and sends live in the contract methods, not in this reader. The contract's `attest` and `unseal` calls remain the authority for a note, and mempool.space supplies the public view of its Bitcoin output.
