#!/usr/bin/env bash
# Breaks one guard at a time, runs the test that must catch it, expects RED, restores the file,
# runs the same test again and expects GREEN. One line per mutation:
#   <id> | <guard> | red=<exit of broken run> green=<exit after restore> | <first failure line>
# usage: scripts/mutate.sh [id ...]      (no ids = all)
set -u
cd "$(dirname "$0")/.."
source scripts/env.sh
export CACHET_NO_ABI=1
SANDBOX="cargo test --test sandbox --"
GIFT="cargo test --test gift_and_lock --"
UNIT="cargo test --lib --"
PAPER="cargo test --test paper_design --"
INTENTS="cargo test --test intents --"
REVIEW="cargo test --test review_fixes --"
ALC="cargo test --test attest_light_client --"
NODE="node --test web/web.test.mjs"
OUT=target/mutation
mkdir -p "$OUT"
want=("$@")
CUR_FILE=""; CUR_ORIG=""
restore() { [ -n "$CUR_FILE" ] && [ -f "$CUR_ORIG" ] && cp "$CUR_ORIG" "$CUR_FILE"; CUR_FILE=""; }
trap restore EXIT INT TERM HUP

mut() { # id file perl-expression test-command guard
  local id="$1" file="$2" expr="$3" cmd="$4" guard="$5"
  if [ ${#want[@]} -gt 0 ]; then
    local hit=0 w; for w in "${want[@]}"; do [ "$w" = "$id" ] && hit=1; done
    [ $hit = 1 ] || return 0
  fi
  cp "$file" "$OUT/$id.orig"; CUR_FILE="$file"; CUR_ORIG="$OUT/$id.orig"
  perl -0pi -e "$expr" "$file"
  if cmp -s "$file" "$OUT/$id.orig"; then echo "$id | $guard | MUTATION DID NOT APPLY"; return 0; fi
  [ "$id" != M26 ] || rm -f target/wasm/cachet.wasm
  $cmd > "$OUT/$id.red.log" 2>&1; local red=$?
  restore
  [ "$id" != M26 ] || rm -f target/wasm/cachet.wasm
  $cmd > "$OUT/$id.green.log" 2>&1; local green=$?
  echo "$id | $guard | red=$red green=$green | $(grep -E 'panicked at|^test result' "$OUT/$id.red.log" | head -1)"
}

mut M01 src/lib.rs 's/if !caller_is_owner \{/if false && !caller_is_owner {/' "$SANDBOX non_owner_unseal_reverts" "sign requires the note owner"
mut M02 src/lib.rs 's/if in_transfer \{/if false && in_transfer {/' "$GIFT a_receiver_cannot_unseal_from_inside" "sign refused while a transfer is in flight"
mut M03 src/lib.rs 's/\(SignOp::Unseal, State::Sealed\) if claim_locked => Err\("claim link is active"\),\n//' "$GIFT claim_link_moves_a_sealed_note" "unseal refused while a claim link is locked"
mut M04 src/lib.rs 's/require!\(matches!\(note\.state, State::Minted \| State::Sealed\), "note cannot move in this state"\);/require!(true);/' "$SANDBOX unsealed_and_minted_transfers" "transfers only in Minted and Sealed"
mut M05 src/lib.rs 's/require!\(out\.script == btc::p2wpkh_script\(&note\.pubkey33\(\)\), "output does not pay this note"\);//' "$SANDBOX attest_rejects_tx_paying_another_address" "attest output must pay the note address"
mut M06 src/lib.rs 's/require!\(out\.value >= MIN_NOTE_SATS, "funding below 1000 sats"\);//' "$SANDBOX attest_is_owner_only_once_only" "attest dust floor"
mut M07 src/lib.rs 's/require!\(self\.owner_of\(token_id\) == env::predecessor_account_id\(\), "only the note owner can do this"\);//' "$SANDBOX attest_is_owner_only_once_only" "owner-only note actions"
mut M08 src/lib.rs 's/let included = light_client::included\(0\);/let included = true;/' "$ALC an_unknown_tx_leaves_the_note_minted" "failed light-client proof credits nothing"
mut M09 src/btc.rs 's/txid: sha256d\(&stripped\)/txid: sha256d(raw)/' "$UNIT parses_real_mainnet_txs" "txid hashes the witness-stripped bytes"
mut M10 src/lib.rs 's/\(recovers\(v\) \|\| recovers\(v \^ 1\)\)\.then\(/true.then(/' "$SANDBOX signature_over_the_wrong_hash" "signature must recover to the note key"
mut M11 src/btc.rs 's/if s > SECP_HALF_N \{/if false && s > SECP_HALF_N {/' "$SANDBOX high_s_signatures" "low-S normalization"
mut M12 src/lib.rs 's/require!\(\s*tx\.inputs\.iter\(\)\.any\(\|i\| i\.prev_txid == u\.txid && i\.vout == u\.vout\),\s*"transaction does not spend this note"\s*\);//s' "$SANDBOX finalize_guards" "finalize tx must spend the note UTXO"
mut M13 src/lib.rs 's/require!\(tx\.outputs\.iter\(\)\.any\(\|o\| o\.script == note\.dest_script\), "transaction does not pay the unseal destination"\);//' "$SANDBOX finalize_requires_the_sweep" "finalize tx must pay the unseal destination"
mut M14 src/lib.rs 's/require!\(env::ed25519_verify\(&sig, msg\.as_bytes\(\), &key\), "bad claim signature"\);//' "$GIFT claim_link_moves_a_sealed_note" "claim needs the link signature"
mut M15 src/lib.rs 's/note\.claim_key = None;\n        note\.in_transfer = call;/note.in_transfer = call;/' "$GIFT selling_the_note_kills_the_claim_link" "a transfer kills the claim link"
mut M16 src/btc.rs 's/p\.extend_from_slice\(&self\.amount\.to_le_bytes\(\)\);/p.extend_from_slice(&(self.amount - 1).to_le_bytes());/' "$UNIT sighash_matches_bitcoin_crate_bip143" "BIP143 commits to the input amount"
mut M17 src/lib.rs 's/require!\(sats >= fee \+ MIN_SWEEP_OUTPUT, "fee leaves the sweep below dust"\);//g' "$SANDBOX unseal_input_validation" "sweep output above dust"
mut M18 src/lib.rs 's/\(SignOp::Unseal, State::Sealed\) \| \(SignOp::Resign, State::Unsealed\) => Ok/(SignOp::Unseal, State::Sealed) | (SignOp::Unseal, State::Unsealed) | (SignOp::Resign, State::Unsealed) => Ok/' "$SANDBOX double_unseal_reverts" "a second unseal is refused"
mut M19 src/lib.rs 's/proof_args_v2\(tx\.txid,/proof_args_v2(tx.txid_display(),/' "$ALC the_light_client_gets_the_contracts_own_txid" "light client receives the contract txid in internal byte order"
mut M20 src/btc.rs 's/0x3b6a_57b2/0x3b6a_57b3/' "$UNIT bip173_vector_address" "bech32 checksum"
mut M21 src/lib.rs 's/if light_client::included\(0\) \{\n            self\.burn/if true {\n            self.burn/' "$ALC an_unconfirmed_sweep_cannot_park_a_note" "finalize burns only after inclusion is proven"
mut M22 src/lib.rs 's/\| \(SignOp::Resign, State::Unsealed\) => Ok/| (SignOp::Resign, State::Unsealed) | (SignOp::Resign, State::Sealed) => Ok/' "$SANDBOX resign_changes_only_the_fee" "resign only after unseal"
mut M23 src/lib.rs 's/env::block_height\(\) >= note\.pending_since \+ RECOVER_AFTER_BLOCKS/true/' "$SANDBOX in_flight_sign_blocks_transfer" "recover waits out the signer timeout"
mut M24 src/lib.rs 's/note\.state = prior;/note.state = pending;/' "$SANDBOX failed_sign_returns_the_note_to_sealed" "a failed sign rolls the note back"
mut M25 src/lib.rs 's/\(SignOp::Unseal, State::Sealed\) \| \(SignOp::Resign, State::Unsealed\) => Ok/(SignOp::Unseal, _) | (SignOp::Resign, State::Unsealed) => Ok/' "$UNIT signing_is_reachable_from_exactly_three" "sign reachable only from the two permitted states"
mut M26 src/btc.rs 's/if stripped\.len\(\) == 64 \{/if false \&\& stripped.len() == 64 {/' "$PAPER attest_and_finalize_reject_a_64_byte" "attest and finalize reject a 64-byte witness-stripped transaction"
mut M27 src/btc.rs 's/if stripped\.len\(\) == 64 \{/if false \&\& stripped.len() == 64 {/' "$UNIT rejects_a_64_byte" "64-byte rule in the parser (unit)"
mut M28 src/lib.rs 's/(let Some\(pubkey\) = key else \{\n\s+)Self::refund\(&owner_id, deposit\.0\);/$1/' "$PAPER a_failed_derivation_mints_no_note" "failed derivation refunds the deposit and mints nothing"
mut M29 src/lib.rs 's/let Some\(pubkey\) = key else \{/let Some(pubkey) = key.or(Some([7u8; 64])) else {/' "$PAPER a_failed_derivation_mints_no_note" "a note exists only after the derived key came back"
mut M30 src/lib.rs 's/if !caller_is_owner \{/if false \&\& !caller_is_owner {/' "$INTENTS a_signed_token_diff_trade" "after an intents.near sale only the buyer can unseal"
mut M31 src/lib.rs 's/if let Some\(approved\) = self\.tokens\.approvals_by_id\.as_mut\(\)\.and_then\(\|a\| a\.remove\(&token_id\)\) \{/if let Some(approved) = None::<std::collections::HashMap<AccountId, u64>> {/' "$REVIEW claim_clears_the_old_owners_approvals" "claim clears NEP-178 approvals"
mut M32 src/lib.rs 's/State::Unsealing \| State::Resigning \| State::Finalizing => State::Unsealed,/State::Unsealing => State::Sealed,\n            State::Resigning | State::Finalizing => State::Unsealed,/' "$REVIEW a_note_whose_signature_became_public" "recover never re-seals an unsealing note"
mut M33 src/lib.rs 's/ \+ NOTE_STORAGE_RESERVE_BYTES as u128;/;/' "$REVIEW the_mint_deposit_funds_every_later" "mint prefunds the note storage growth"
mut M34 src/lib.rs 's/\n        self\.notes\.flush\(\);//' "$REVIEW the_mint_deposit_funds_every_later" "mint charges the note record itself"
mut M35 src/light_client.rs 's/proof\.merkle_proof\.len\(\) != proof\.coinbase_merkle_proof\.len\(\)/false/' "$UNIT proof_args_v2_refuses_mismatched_branches" "proof branches have equal depth"
mut M36 src/light_client.rs 's/btc::hex_32\(hex\)\.map\(btc::reversed\)/btc::hex_32(hex)/' "$UNIT proof_args_v2_matches_live_vector" "light-client hashes use internal byte order"
mut M37 web/outcome.js 's/return note\.state === "Minted";/return true;/' "$NODE" "funding address is hidden past Minted"
mut M38 src/lib.rs 's/\| \(SignOp::Resign, State::Unsealed\) => Ok/| (SignOp::Resign, State::Unsealed | State::Finalizing) => Ok/' "$SANDBOX finalization_pending_blocks_resign" "resign is refused while finalization is pending"
