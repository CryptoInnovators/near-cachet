# Cachet for X

An unpacked Manifest V3 extension that opens Cachet's existing create page from X profile and DM surfaces. The create page remains responsible for creating a note. When an X DM contains a `/claim?note=...` Cachet claim link, the extension offers to replace it with `/e/<note id>` and saves that note locally.

The popup resolves each saved note with `note(token_id)` on `cachet.testnet` through `https://rpc.testnet.near.org`. It displays live contract state and funded sats when available. The extension does not sign, hold keys, or write to NEAR.

Load `extension/` as an unpacked extension in Chrome. The recipient must be signed in to X for profile and DM actions to be available. Testnet state requires the public NEAR RPC to be reachable.
