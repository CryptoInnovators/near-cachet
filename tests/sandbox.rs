//! Sandbox tests for the note state machine. Every revert test names the guard it
//! exercises; docs/TESTS.md records the mutation run for each.

mod common;

use bitcoin::absolute::LockTime;
use bitcoin::consensus::serialize;
use bitcoin::hashes::Hash;
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::{Address, Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
use common::*;
use serde_json::{json, Value};
use std::str::FromStr;

fn assert_reverts(r: &near_workspaces::result::ExecutionFinalResult, needle: &str) {
    assert!(r.is_failure(), "expected a revert containing {needle:?}");
    let t = fail_text(r);
    assert!(t.contains(needle), "revert text {t:?} lacks {needle:?}");
}

/// BIP143 sighash for the sweep, computed with the bitcoin crate from the funding data.
fn expected_sighash(note: &Value, f: &Funding, dest: &str, fee: u64) -> String {
    let addr = Address::from_str(note["address"].as_str().unwrap()).unwrap().assume_checked();
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint { txid: Txid::from_str(&f.txid).unwrap(), vout: f.vout },
            script_sig: ScriptBuf::new(),
            sequence: Sequence(0xffff_fffd),
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(f.sats - fee),
            script_pubkey: Address::from_str(dest).unwrap().assume_checked().script_pubkey(),
        }],
    };
    let h = SighashCache::new(&tx)
        .p2wpkh_signature_hash(0, &addr.script_pubkey(), Amount::from_sat(f.sats), EcdsaSighashType::All)
        .unwrap();
    hex::encode(h.to_byte_array())
}

async fn signed_tx(w: &World, id: &str) -> String {
    w.worker.view(w.cachet.id(), "signed_sweep_tx").args_json(json!({"token_id": id})).await.unwrap().json::<Option<String>>().unwrap().expect("no signed sweep")
}

#[tokio::test]
async fn lifecycle_mint_attest_unseal_finalize_on_a_keyless_contract() {
    let w = World::new(2).await.keyless().await;
    let id = w.mint(&w.alice).await;
    let n = w.note(&id).await.unwrap();
    assert_eq!(n["state"], "Minted");
    assert_eq!(n["owner_id"], w.alice.id().as_str());
    assert_eq!(n["path"], format!("cachet/{id}/0"));
    // the key behind the address is the one the signer derives for (cachet, path)
    let key: String = w
        .worker
        .view(w.signer.id(), "derived_public_key")
        .args_json(json!({"path": n["path"], "predecessor": w.cachet.id(), "domain_id": 0}))
        .await
        .unwrap()
        .json()
        .unwrap();
    let raw = bs58::decode(key.strip_prefix("secp256k1:").unwrap()).into_vec().unwrap();
    let mut sec1 = vec![if raw[63] & 1 == 0 { 2u8 } else { 3u8 }];
    sec1.extend(&raw[..32]);
    assert_eq!(n["pubkey"], hex::encode(&sec1));
    let pk = bitcoin::PublicKey::from_slice(&sec1).unwrap();
    assert_eq!(n["address"], Address::p2wpkh(&pk.try_into().unwrap(), bitcoin::Network::Bitcoin).to_string());

    let f = w.fund(&id, 100_000, 6).await;
    let r = w.attest(&w.alice, &id, &f).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    println!("GAS attest {:.1} Tgas", tgas(r.total_gas_burnt));
    assert_eq!(r.json::<bool>().unwrap(), true);
    let n = w.note(&id).await.unwrap();
    assert_eq!(n["state"], "Sealed");
    assert_eq!(n["utxo"]["sats"], 100_000);
    assert_eq!(n["utxo"]["vout"], 1);
    assert_eq!(n["utxo"]["txid"], f.txid.as_str());
    assert_eq!(n["utxo"]["attestation_payload_hash"].as_str().unwrap().len(), 64);

    let r = w.unseal(&w.alice, &id, DEST, 10).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    println!("GAS unseal {:.1} Tgas", tgas(r.total_gas_burnt));
    assert_eq!(r.json::<bool>().unwrap(), true);
    assert_eq!(w.state(&id).await, "Unsealed");
    let log = w.sign_log().await;
    assert_eq!(log.len(), 1, "exactly one sign call");
    assert_eq!(log[0]["predecessor"], w.cachet.id().as_str());
    assert_eq!(log[0]["path"], n["path"]);
    assert_eq!(log[0]["domain_id"], 0);
    assert_eq!(log[0]["payload"], expected_sighash(&n, &f, DEST, 1100), "contract signs the BIP143 sighash");
    let n = w.note(&id).await.unwrap();
    let signed = signed_tx(&w, &id).await;
    let tx = verify_sweep(&n, &f, &signed, DEST, 10);

    assert_reverts(&w.transfer(&w.alice, &id, w.bob.id().as_str()).await, "cannot move in this state");

    // the sweep must be confirmed on Bitcoin before finalize
    let fin = |raw: String| {
        let w = w.clone();
        let id = id.clone();
        async move { w.bob.call(w.cachet.id(), "finalize").args_json(json!({"token_id": id, "sweep_raw_tx": raw})).max_gas().transact().await.unwrap() }
    };
    let r = fin(hex::encode(serialize(&tx))).await;
    assert!(r.is_success());
    assert_eq!(r.json::<bool>().unwrap(), false, "unconfirmed sweep is not accepted");
    assert_eq!(w.state(&id).await, "Unsealed");
    w.confirm(&tx.compute_txid().to_string(), 6).await;
    let r = fin(hex::encode(serialize(&tx))).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    println!("GAS finalize {:.1} Tgas", tgas(r.total_gas_burnt));
    assert_eq!(r.json::<bool>().unwrap(), true);
    assert!(w.note(&id).await.is_none());
    assert!(w.owner(&id).await.is_none());
    let supply: String = w.worker.view(w.cachet.id(), "nft_total_supply").await.unwrap().json().unwrap();
    assert_eq!(supply, "0");
    assert!(w.cachet.view_access_keys().await.unwrap().is_empty(), "still keyless");
}

#[tokio::test]
async fn non_owner_unseal_reverts_and_never_reaches_sign() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    let r = w.unseal(&w.bob, &id, DEST, 5).await;
    assert_reverts(&r, "only the note owner can request a signature");
    assert_eq!(w.state(&id).await, "Sealed");
    assert!(w.sign_log().await.is_empty());
}

#[tokio::test]
async fn double_unseal_reverts() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    assert!(w.unseal(&w.alice, &id, DEST, 5).await.is_success());
    let r = w.unseal(&w.alice, &id, DEST, 5).await;
    assert_reverts(&r, "note is not sealed with attested funding");
    assert_eq!(w.sign_log().await.len(), 1);
}

#[tokio::test]
async fn unseal_before_attestation_reverts() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    assert_reverts(&w.unseal(&w.alice, &id, DEST, 5).await, "note is not sealed with attested funding");
    assert!(w.sign_log().await.is_empty());
}

#[tokio::test]
async fn unseal_input_validation() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 2_000).await;
    assert_reverts(&w.unseal(&w.alice, &id, "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", 5).await, "address network prefix mismatch");
    assert_reverts(&w.unseal(&w.alice, &id, "not an address", 5).await, "missing separator");
    assert_reverts(&w.unseal(&w.alice, &id, DEST, 0).await, "fee rate must be 1 to 1000");
    assert_reverts(&w.unseal(&w.alice, &id, DEST, 1001).await, "fee rate must be 1 to 1000");
    assert_reverts(&w.unseal(&w.alice, &id, DEST, 20).await, "fee leaves the sweep below dust");
    assert!(w.sign_log().await.is_empty());
    assert!(w.unseal(&w.alice, &id, DEST, 10).await.is_success());
}

#[tokio::test]
async fn attest_rejects_tx_paying_another_address_and_bad_vout() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    let other = w.mint(&w.bob).await;
    let f = w.fund(&other, 80_000, 6).await; // pays bob's note, not alice's
    let r = w.attest(&w.alice, &id, &f).await;
    assert_reverts(&r, "output does not pay this note");
    let r = w.attest(&w.alice, &id, &Funding { vout: 7, ..clone_funding(&f) }).await;
    assert_reverts(&r, "vout out of range");
    let r = w.attest(&w.alice, &id, &Funding { vout: 0, ..clone_funding(&f) }).await;
    assert_reverts(&r, "output does not pay this note");
    assert_eq!(w.state(&id).await, "Minted");
    assert!(w.note(&id).await.unwrap()["utxo"].is_null());
    let v: u64 = w.worker.view(w.signer.id(), "verify_calls").await.unwrap().json().unwrap();
    assert_eq!(v, 0, "no MPC call was made for a transaction that cannot belong to the note");
}

fn clone_funding(f: &Funding) -> Funding {
    Funding { raw_hex: f.raw_hex.clone(), txid: f.txid.clone(), vout: f.vout, sats: f.sats }
}

#[tokio::test]
async fn attest_rejects_a_raw_tx_that_does_not_hash_to_a_confirmed_txid() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    let f = w.fund(&id, 90_000, 6).await;
    // flip one byte of the locktime: the bytes now hash to a txid Bitcoin has never seen
    let mut raw = hex::decode(&f.raw_hex).unwrap();
    let n = raw.len();
    raw[n - 1] ^= 1;
    let forged = Funding { raw_hex: hex::encode(raw), ..clone_funding(&f) };
    let r = w.attest(&w.alice, &id, &forged).await;
    assert!(r.is_success());
    assert_eq!(r.json::<bool>().unwrap(), false);
    assert_eq!(w.state(&id).await, "Minted", "failed attestation rolls back");
    assert!(w.note(&id).await.unwrap()["utxo"].is_null(), "no sats credited");
    // the genuine bytes still attest afterwards
    assert_eq!(w.attest(&w.alice, &id, &f).await.json::<bool>().unwrap(), true);
    assert_eq!(w.note(&id).await.unwrap()["utxo"]["sats"], 90_000);
}

#[tokio::test]
async fn attest_waits_for_the_configured_confirmations() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    let f = w.fund(&id, 90_000, 1).await;
    let r = w.attest(&w.alice, &id, &f).await;
    assert_eq!(r.json::<bool>().unwrap(), false);
    assert_eq!(w.state(&id).await, "Minted");
    w.confirm(&f.txid, 2).await;
    assert_eq!(w.attest(&w.alice, &id, &f).await.json::<bool>().unwrap(), true);
    assert_eq!(w.state(&id).await, "Sealed");
}

#[tokio::test]
async fn attest_is_owner_only_once_only_and_bounded() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    let f = w.fund(&id, 90_000, 6).await;
    assert_reverts(&w.attest(&w.bob, &id, &f).await, "only the note owner can do this");
    let dust = w.fund(&id, 999, 6).await;
    assert_reverts(&w.attest(&w.alice, &id, &dust).await, "funding below 1000 sats");
    let mut junk = hex::decode(&f.raw_hex).unwrap();
    junk.push(0);
    assert_reverts(&w.attest(&w.alice, &id, &Funding { raw_hex: hex::encode(junk), ..clone_funding(&f) }).await, "trailing bytes");
    assert_reverts(&w.attest(&w.alice, &id, &Funding { raw_hex: "zz".into(), ..clone_funding(&f) }).await, "bad hex digit");
    assert!(w.attest(&w.alice, &id, &f).await.is_success());
    let second = w.fund(&id, 95_000, 6).await;
    assert_reverts(&w.attest(&w.alice, &id, &second).await, "note is not awaiting funding");
    assert_eq!(w.note(&id).await.unwrap()["utxo"]["sats"], 90_000, "first attested UTXO is final");
}

#[tokio::test]
async fn failed_sign_returns_the_note_to_sealed_and_retry_works() {
    let w = World::new(2).await;
    let (id, f) = w.sealed_note(&w.alice, 60_000).await;
    w.set_mode(true, false, false, false).await;
    let r = w.unseal(&w.alice, &id, DEST, 10).await;
    assert!(r.is_success());
    assert_eq!(r.json::<bool>().unwrap(), false);
    assert_eq!(w.state(&id).await, "Sealed");
    assert!(w.note(&id).await.unwrap()["sweep"].is_null(), "destination cleared after a failed sign");
    w.set_mode(false, false, false, false).await;
    assert!(w.unseal(&w.alice, &id, DEST, 10).await.json::<bool>().unwrap());
    let n = w.note(&id).await.unwrap();
    verify_sweep(&n, &f, &signed_tx(&w, &id).await, DEST, 10);
}

#[tokio::test]
async fn signature_over_the_wrong_hash_is_rejected_by_ecrecover() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 60_000).await;
    w.set_mode(false, true, false, false).await;
    let r = w.unseal(&w.alice, &id, DEST, 10).await;
    assert_eq!(r.json::<bool>().unwrap(), false);
    assert_eq!(w.state(&id).await, "Sealed", "an unverifiable signature is never stored");
    let n = w.note(&id).await.unwrap();
    assert!(n["sweep"].is_null());
}

#[tokio::test]
async fn high_s_signatures_are_folded_to_low_s_and_still_verify() {
    let w = World::new(2).await;
    let (id, f) = w.sealed_note(&w.alice, 60_000).await;
    w.set_mode(false, false, true, false).await;
    assert!(w.unseal(&w.alice, &id, DEST, 10).await.json::<bool>().unwrap());
    let n = w.note(&id).await.unwrap();
    verify_sweep(&n, &f, &signed_tx(&w, &id).await, DEST, 10);
}

#[tokio::test]
async fn resign_changes_only_the_fee_and_only_for_the_owner() {
    let w = World::new(2).await;
    let (id, f) = w.sealed_note(&w.alice, 60_000).await;
    assert_reverts(&w.alice.call(w.cachet.id(), "resign").args_json(json!({"token_id": id, "fee_rate": 20})).max_gas().transact().await.unwrap(), "note is not unsealed");
    assert!(w.unseal(&w.alice, &id, DEST, 10).await.json::<bool>().unwrap());
    let n1 = w.note(&id).await.unwrap();
    let first = signed_tx(&w, &id).await;
    let call = |who: &near_workspaces::Account, args: Value| {
        let who = who.clone();
        let w = w.clone();
        async move { who.call(w.cachet.id(), "resign").args_json(args).max_gas().transact().await.unwrap() }
    };
    assert_reverts(&call(&w.bob, json!({"token_id": id, "fee_rate": 20})).await, "only the note owner can request a signature");
    assert_reverts(&call(&w.alice, json!({"token_id": id, "fee_rate": 5000})).await, "fee rate must be 1 to 1000");
    // there is no destination argument: an extra one is ignored and the sweep keeps its address
    let r = call(&w.alice, json!({"token_id": id, "fee_rate": 20, "btc_dest": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"})).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    assert!(r.json::<bool>().unwrap());
    let second = signed_tx(&w, &id).await;
    assert_ne!(first, second);
    verify_sweep(&n1, &f, &second, DEST, 20);
    assert_eq!(w.sign_log().await.len(), 2);
    assert_eq!(w.state(&id).await, "Unsealed");
}

#[tokio::test]
async fn in_flight_sign_blocks_transfer_and_second_unseal_until_the_signer_times_out() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 60_000).await;
    w.set_mode(false, false, false, true).await;
    let pending = w
        .alice
        .call(w.cachet.id(), "unseal")
        .args_json(json!({"token_id": id, "btc_dest": DEST, "fee_rate": 10}))
        .max_gas()
        .transact_async()
        .await
        .unwrap();
    // wait until the request is parked in the signer
    for _ in 0..40 {
        if w.state(&id).await == "Unsealing" {
            break;
        }
        w.worker.fast_forward(1).await.unwrap();
    }
    assert_eq!(w.state(&id).await, "Unsealing");
    assert_reverts(&w.transfer(&w.alice, &id, w.bob.id().as_str()).await, "cannot move in this state");
    assert_reverts(&w.unseal(&w.alice, &id, DEST, 10).await, "note is not sealed with attested funding");
    let rec = w.alice.call(w.cachet.id(), "recover").args_json(json!({"token_id": id})).transact().await.unwrap();
    assert_reverts(&rec, "request may still be pending");
    w.worker.fast_forward(260).await.unwrap();
    let r = pending.await.unwrap();
    assert_eq!(r.json::<bool>().unwrap(), false, "the yield timed out and the callback rolled back");
    assert_eq!(w.state(&id).await, "Sealed");
    assert_reverts(&w.alice.call(w.cachet.id(), "recover").args_json(json!({"token_id": id})).transact().await.unwrap(), "note is not mid-request");
}

#[tokio::test]
async fn finalize_guards() {
    let w = World::new(2).await;
    let (id, f) = w.sealed_note(&w.alice, 60_000).await;
    let (other, _) = w.sealed_note(&w.bob, 70_000).await;
    let fin = |id: &str, raw: String| {
        let w = w.clone();
        let id = id.to_string();
        async move { w.carol.call(w.cachet.id(), "finalize").args_json(json!({"token_id": id, "sweep_raw_tx": raw})).max_gas().transact().await.unwrap() }
    };
    assert_reverts(&fin(&id, f.raw_hex.clone()).await, "note is not unsealed");
    assert!(w.unseal(&w.alice, &id, DEST, 10).await.json::<bool>().unwrap());
    // the funding tx itself does not spend the funded outpoint
    assert_reverts(&fin(&id, f.raw_hex.clone()).await, "transaction does not spend this note");
    // a real sweep of the other note does not spend this one
    assert!(w.unseal(&w.bob, &other, DEST, 10).await.json::<bool>().unwrap());
    let foreign = signed_tx(&w, &other).await;
    assert_reverts(&fin(&id, foreign).await, "transaction does not spend this note");
    assert_eq!(w.state(&id).await, "Unsealed");
    assert!(w.note(&id).await.is_some());
}

#[tokio::test]
async fn finalize_requires_the_sweep_to_pay_the_unseal_destination() {
    let w = World::new(2).await;
    let (id, f) = w.sealed_note(&w.alice, 60_000).await;
    assert!(w.unseal(&w.alice, &id, DEST, 10).await.json::<bool>().unwrap());
    // a tx spending the right outpoint but paying somewhere else
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint { txid: Txid::from_str(&f.txid).unwrap(), vout: f.vout },
            script_sig: ScriptBuf::new(),
            sequence: Sequence(0xffff_fffd),
            witness: Witness::from_slice(&[vec![1u8; 71], vec![2u8; 33]]),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(50_000),
            script_pubkey: Address::from_str("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").unwrap().assume_checked().script_pubkey(),
        }],
    };
    w.confirm(&tx.compute_txid().to_string(), 6).await;
    let r = w.carol.call(w.cachet.id(), "finalize").args_json(json!({"token_id": id, "sweep_raw_tx": hex::encode(serialize(&tx))})).max_gas().transact().await.unwrap();
    assert_reverts(&r, "transaction does not pay the unseal destination");
    assert!(w.note(&id).await.is_some(), "note survives");
}

#[tokio::test]
async fn mint_requires_a_storage_deposit_and_refunds_the_rest() {
    let w = World::new(2).await;
    let r = w.alice.call(w.cachet.id(), "mint_note").deposit(milli(5)).max_gas().transact().await.unwrap();
    assert_reverts(&r, "attach at least 0.02 NEAR");
    let before = w.alice.view_account().await.unwrap().balance;
    let r = w.alice.call(w.cachet.id(), "mint_note").deposit(near(1)).max_gas().transact().await.unwrap();
    assert!(r.is_success());
    let spent = before.as_yoctonear() - w.alice.view_account().await.unwrap().balance.as_yoctonear();
    assert!(spent < milli(100).as_yoctonear(), "1 NEAR deposit refunded down to storage plus gas, spent {spent}");
    println!("MINT 1 NEAR attached, net cost {:.5} NEAR, gas {:.1} Tgas", spent as f64 / 1e24, tgas(r.total_gas_burnt));
}

#[tokio::test]
async fn token_ids_are_never_reused_after_a_burn() {
    let w = World::new(2).await;
    let a = w.mint(&w.alice).await;
    let b = w.mint(&w.alice).await;
    assert_ne!(a, b);
    let supply: String = w.worker.view(w.cachet.id(), "nft_total_supply").await.unwrap().json().unwrap();
    assert_eq!(supply, "2");
    let toks: Vec<Value> = w.worker.view(w.cachet.id(), "nft_tokens_for_owner").args_json(json!({"account_id": w.alice.id()})).await.unwrap().json().unwrap();
    assert_eq!(toks.len(), 2);
    assert!(toks[0]["metadata"]["extra"].as_str().unwrap().contains("\"state\":\"Minted\""));
}

#[tokio::test]
async fn unsealed_and_minted_transfers_follow_the_state_table() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    // an unfunded note can move
    assert!(w.transfer(&w.alice, &id, w.bob.id().as_str()).await.is_success());
    assert_eq!(w.owner(&id).await.unwrap(), w.bob.id().as_str());
    // a stranger cannot move it
    assert!(w.transfer(&w.carol, &id, w.alice.id().as_str()).await.is_failure());
    // after funding, attest is the new owner's
    let f = w.fund(&id, 40_000, 6).await;
    assert_reverts(&w.attest(&w.alice, &id, &f).await, "only the note owner can do this");
    assert!(w.attest(&w.bob, &id, &f).await.is_success());
    assert!(w.transfer(&w.bob, &id, w.carol.id().as_str()).await.is_success(), "sealed notes are tradable");
    assert_reverts(&w.unseal(&w.bob, &id, DEST, 5).await, "only the note owner can request a signature");
    assert!(w.unseal(&w.carol, &id, DEST, 5).await.json::<bool>().unwrap());
    assert_reverts(&w.transfer(&w.carol, &id, w.alice.id().as_str()).await, "cannot move in this state");
}
