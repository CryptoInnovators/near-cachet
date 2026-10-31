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
OUT=target/mutation
mkdir -p "$OUT"
want=("$@")

mut() { # id file perl-expression test-command guard
  local id="$1" file="$2" expr="$3" cmd="$4" guard="$5"
  if [ ${#want[@]} -gt 0 ]; then
    local hit=0 w; for w in "${want[@]}"; do [ "$w" = "$id" ] && hit=1; done
    [ $hit = 1 ] || return 0
  fi
  cp "$file" "$OUT/$id.orig"
  perl -0pi -e "$expr" "$file"
  if cmp -s "$file" "$OUT/$id.orig"; then echo "$id | $guard | MUTATION DID NOT APPLY"; return 0; fi
  $cmd > "$OUT/$id.red.log" 2>&1; local red=$?
  cp "$OUT/$id.orig" "$file"
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
mut M08 src/lib.rs 's/let proof = Self::verify_result\(\);/let proof = Some(Self::verify_result().unwrap_or([0u8; 32]));/' "$SANDBOX attest_rejects_a_raw_tx_that_does_not_hash" "failed MPC attestation credits nothing"
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
mut M19 src/lib.rs 's/self\.verify_btc_tx\(&tx\.txid_display\(\)\)/self.verify_btc_tx(&tx.txid)/g' "$SANDBOX lifecycle_mint_attest" "MPC is asked about the explorer-order txid"
mut M20 src/btc.rs 's/0x3b6a_57b2/0x3b6a_57b3/' "$UNIT bip173_vector_address" "bech32 checksum"
mut M21 src/lib.rs 's/if Self::verify_result\(\)\.is_some\(\) \{/if true {/' "$SANDBOX lifecycle_mint_attest" "finalize burns only after the sweep is attested"
mut M22 src/lib.rs 's/\| \(SignOp::Resign, State::Unsealed\) => Ok/| (SignOp::Resign, State::Unsealed) | (SignOp::Resign, State::Sealed) => Ok/' "$SANDBOX resign_changes_only_the_fee" "resign only after unseal"
mut M23 src/lib.rs 's/env::block_height\(\) >= note\.pending_since \+ RECOVER_AFTER_BLOCKS/true/' "$SANDBOX in_flight_sign_blocks_transfer" "recover waits out the signer timeout"
mut M24 src/lib.rs 's/note\.state = prior;/note.state = pending;/' "$SANDBOX failed_sign_returns_the_note_to_sealed" "a failed sign rolls the note back"
mut M25 src/lib.rs 's/\(SignOp::Unseal, State::Sealed\) \| \(SignOp::Resign, State::Unsealed\) => Ok/(SignOp::Unseal, _) | (SignOp::Resign, State::Unsealed) => Ok/' "$UNIT signing_is_reachable_from_exactly_two" "sign reachable only from the two permitted states"
