# Tests and mutation checks

Every method that moves or gates value has a sandbox test, and every guard behind it has a mutation row: `scripts/mutate.sh` edits the guard out with a perl substitution, runs the named test, expects it red, restores the file, runs the same test and expects it green. A row reads `red=101 green=0` when cargo test failed with the guard removed and passed with it restored.

Commands:

```
./scripts/test.sh                      # fetch fixtures, then cargo test --workspace --no-fail-fast
./scripts/mutate.sh                    # all 36 rows
./scripts/mutate.sh M26                # one row
```

The original rows M01 to M34 were produced by mutation workflow run 41290436563 at commit `27bffe4`. Wave 5 rows M08, M19, M21, M35 and M36 were re-run by workflow run 41332375472, conclusion success. The full workspace check at commit `a5e10ba` is CI run 41330410217, conclusion success.

## Methods and the tests that gate them

| Method | Sandbox tests | Mutation rows |
|---|---|---|
| `mint_note` | `mint_requires_a_storage_deposit_and_refunds_the_rest`, `token_ids_are_never_reused_after_a_burn`, `a_failed_derivation_mints_no_note_and_shows_no_address`, `the_mint_deposit_funds_every_later_byte_a_note_can_grow` | M28, M29, M33, M34 |
| `attest` | `lifecycle_mint_attest_unseal_finalize_on_a_keyless_contract`, `attest_rejects_tx_paying_another_address_and_bad_vout`, `attest_rejects_a_raw_tx_that_does_not_hash_to_a_confirmed_txid`, `attest_waits_for_the_configured_confirmations`, `attest_is_owner_only_once_only_and_bounded`, `attest_and_finalize_reject_a_64_byte_transaction_before_asking_the_signer`, `a_proof_for_another_block_leaves_the_note_minted`, `an_unknown_tx_leaves_the_note_minted`, `the_light_client_gets_the_contracts_own_txid` | M05, M06, M07, M08, M19, M26, M35, M36 |
| `unseal` | `non_owner_unseal_reverts_and_never_reaches_sign`, `double_unseal_reverts`, `unseal_before_attestation_reverts`, `unseal_input_validation`, `signature_over_the_wrong_hash_is_rejected_by_ecrecover`, `high_s_signatures_are_folded_to_low_s_and_still_verify`, `failed_sign_returns_the_note_to_sealed_and_retry_works` | M01, M10, M11, M17, M18, M24 |
| `resign` | `resign_changes_only_the_fee_and_only_for_the_owner` | M22 |
| `finalize` | `finalize_guards`, `finalize_requires_the_sweep_to_pay_the_unseal_destination`, `lifecycle_mint_attest_unseal_finalize_on_a_keyless_contract`, `an_unconfirmed_sweep_cannot_park_a_note` | M12, M13, M21 |
| `create_claim`, `claim`, `cancel_claim` | `claim_clears_the_old_owners_approvals`, `claim_link_moves_a_sealed_note_once_and_binds_the_receiver`, `after_expiry_the_sender_can_cancel_or_unseal`, `expired_link_still_claims_until_the_owner_acts`, `selling_the_note_kills_the_claim_link`, `unsealed_note_cannot_be_gifted_or_claimed`, `the_signature_made_by_the_web_page_moves_the_note` | M03, M14, M15, M31 |
| `recover` | `in_flight_sign_blocks_transfer_and_second_unseal_until_the_signer_times_out`, `a_note_whose_signature_became_public_is_never_resealed` | M23, M32 |
| `nft_transfer`, `nft_transfer_call` | `unsealed_and_minted_transfers_follow_the_state_table`, `a_note_held_by_an_escrow_cannot_be_unsealed_by_the_seller`, `a_receiver_cannot_unseal_from_inside_nft_on_transfer`, `escrow_that_returns_the_note_hands_it_back`, `unsealed_note_cannot_be_listed` | M02, M04 |
| sale through `intents.near` | `real_intents_near_holds_a_sealed_note_and_nobody_can_unseal_it`, `a_signed_token_diff_trade_hands_the_unseal_right_to_the_buyer`, `a_seller_who_withdraws_before_execution_voids_the_trade` (the mainnet `intents.near` and `wrap.near` code, fetched by `view_code`) | M30 |
| signing permit | `signing_is_reachable_from_exactly_three_configurations_in_two_states`, `source_has_one_signer_sign_call_site_behind_a_permit` | M25 |
| Bitcoin parsing and signing in `src/btc.rs` | unit tests against the `bitcoin` crate, `secp256k1` and real mainnet transactions | M09, M16, M20, M27 |

## Mutation output

Format: `id | guard | exit of the broken run, exit after restore | first failure line of the broken run`.

```
M01 | sign requires the note owner | red=101 green=0 | thread 'non_owner_unseal_reverts_and_never_reaches_sign' panicked at tests/sandbox.rs:17:5:
M02 | sign refused while a transfer is in flight | red=101 green=0 | thread 'a_receiver_cannot_unseal_from_inside_nft_on_transfer' panicked at tests/gift_and_lock.rs:180:5:
M03 | unseal refused while a claim link is locked | red=101 green=0 | thread 'claim_link_moves_a_sealed_note_once_and_binds_the_receiver' panicked at tests/gift_and_lock.rs:12:5:
M04 | transfers only in Minted and Sealed | red=101 green=0 | thread 'unsealed_and_minted_transfers_follow_the_state_table' panicked at tests/sandbox.rs:17:5:
M05 | attest output must pay the note address | red=101 green=0 | thread 'attest_rejects_tx_paying_another_address_and_bad_vout' panicked at tests/sandbox.rs:17:5:
M06 | attest dust floor | red=101 green=0 | thread 'attest_is_owner_only_once_only_and_bounded' panicked at tests/sandbox.rs:17:5:
M07 | owner-only note actions | red=101 green=0 | thread 'attest_is_owner_only_once_only_and_bounded' panicked at tests/sandbox.rs:17:5:
M08 | failed light-client proof credits nothing | red=101 green=0 | thread 'an_unknown_tx_leaves_the_note_minted' panicked at tests/attest_light_client.rs:35:5:
M09 | txid hashes the witness-stripped bytes | red=101 green=0 | thread 'btc::tests::parses_real_mainnet_txs_to_their_published_txid' panicked at src/btc.rs:586:13:
M10 | signature must recover to the note key | red=101 green=0 | thread 'signature_over_the_wrong_hash_is_rejected_by_ecrecover' panicked at tests/sandbox.rs:260:5:
M11 | low-S normalization | red=101 green=0 | thread 'high_s_signatures_are_folded_to_low_s_and_still_verify' panicked at tests/sandbox.rs:271:5:
M12 | finalize tx must spend the note UTXO | red=101 green=0 | thread 'finalize_guards' panicked at tests/sandbox.rs:17:5:
M13 | finalize tx must pay the unseal destination | red=101 green=0 | thread 'finalize_requires_the_sweep_to_pay_the_unseal_destination' panicked at tests/sandbox.rs:17:5:
M14 | claim needs the link signature | red=101 green=0 | thread 'claim_link_moves_a_sealed_note_once_and_binds_the_receiver' panicked at tests/gift_and_lock.rs:12:5:
M15 | a transfer kills the claim link | red=101 green=0 | thread 'selling_the_note_kills_the_claim_link' panicked at tests/gift_and_lock.rs:120:5:
M16 | BIP143 commits to the input amount | red=101 green=0 | thread 'btc::tests::sighash_matches_bitcoin_crate_bip143' panicked at src/btc.rs:694:9:
M17 | sweep output above dust | red=101 green=0 | thread 'unseal_input_validation' panicked at tests/sandbox.rs:19:5:
M18 | a second unseal is refused | red=101 green=0 | thread 'double_unseal_reverts' panicked at tests/sandbox.rs:17:5:
M19 | light client receives the contract txid in internal byte order | red=101 green=0 | thread 'the_light_client_gets_the_contracts_own_txid' panicked at tests/attest_light_client.rs:66:98:
M20 | bech32 checksum | red=101 green=0 | thread 'btc::tests::bip173_vector_address' panicked at src/btc.rs:550:9:
M21 | finalize burns only after inclusion is proven | red=101 green=0 | thread 'an_unconfirmed_sweep_cannot_park_a_note' panicked at tests/attest_light_client.rs:52:5:
M22 | resign only after unseal | red=101 green=0 | thread 'resign_changes_only_the_fee_and_only_for_the_owner' panicked at tests/sandbox.rs:17:5:
M23 | recover waits out the signer timeout | red=101 green=0 | thread 'in_flight_sign_blocks_transfer_and_second_unseal_until_the_signer_times_out' panicked at tests/sandbox.rs:17:5:
M24 | a failed sign rolls the note back | red=101 green=0 | thread 'failed_sign_returns_the_note_to_sealed_and_retry_works' panicked at tests/sandbox.rs:246:5:
M25 | sign reachable only from the two permitted states | red=101 green=0 | thread 'tests::signing_is_reachable_from_exactly_three_configurations_in_two_states' panicked at src/lib.rs:915:9:
M26 | attest and finalize reject a 64-byte witness-stripped transaction | red=101 green=0 | thread 'attest_and_finalize_reject_a_64_byte_transaction_before_asking_the_signer' panicked at tests/paper_design.rs:11:5:
M27 | 64-byte rule in the parser (unit) | red=101 green=0 | thread 'btc::tests::rejects_a_64_byte_witness_stripped_transaction' panicked at src/btc.rs:623:9:
M28 | failed derivation refunds the deposit and mints nothing | red=101 green=0 | thread 'a_failed_derivation_mints_no_note_and_shows_no_address' panicked at tests/paper_design.rs:88:5:
M29 | a note exists only after the derived key came back | red=101 green=0 | thread 'a_failed_derivation_mints_no_note_and_shows_no_address' panicked at tests/paper_design.rs:82:5:
M30 | after an intents.near sale only the buyer can unseal | red=101 green=0 | thread 'a_signed_token_diff_trade_hands_the_unseal_right_to_the_buyer' panicked at tests/intents.rs:226:5:
M31 | claim clears NEP-178 approvals | red=101 green=0 | thread 'claim_clears_the_old_owners_approvals' panicked at tests/review_fixes.rs:76:5:
M32 | recover never re-seals an unsealing note | red=101 green=0 | thread 'a_note_whose_signature_became_public_is_never_resealed' panicked at tests/review_fixes.rs:177:5:
M33 | mint prefunds the note storage growth | red=101 green=0 | thread 'the_mint_deposit_funds_every_later_byte_a_note_can_grow' panicked at tests/review_fixes.rs:109:5:
M34 | mint charges the note record itself | red=101 green=0 | thread 'the_mint_deposit_funds_every_later_byte_a_note_can_grow' panicked at tests/review_fixes.rs:109:5:
M37 | funding address is hidden past Minted | red=1 green=0 | node test `funding address is visible only while Minted` failed after the guard was removed
```

## Wave 5 focused unit mutation checks

These two rows ran locally with `./scripts/mutate.sh M35 M36` and in mutation workflow run 41332375472. Each test failed with its guard removed, then passed after restoration.

M37 ran locally with `./scripts/mutate.sh M37`; it failed with the guard removed and passed after restoration. The browser test suite also compares the inclusion proof assembled from captured mempool.space responses with the public mainnet light-client vector.

```
M35 | proof branches have equal depth | red=101 green=0 | thread 'light_client::tests::proof_args_v2_refuses_mismatched_branches' panicked at src/light_client.rs:90:54:
M36 | light-client hashes use internal byte order | red=101 green=0 | thread 'light_client::tests::proof_args_v2_matches_live_vector' panicked at src/light_client.rs:84:9:
```
