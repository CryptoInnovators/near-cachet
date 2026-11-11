//! Regression tests for the second review: approvals survive a claim, a failed sign callback
//! re-seals a note whose signature is public, and post-mint storage growth is unfunded.

mod common;

use common::*;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const BYTE: u128 = 10_000_000_000_000_000_000;
const TAPROOT_DEST: &str = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";

fn assert_reverts(r: &near_workspaces::result::ExecutionFinalResult, needle: &str) {
    assert!(r.is_failure(), "expected a revert containing {needle:?}");
    let t = fail_text(r);
    assert!(t.contains(needle), "revert text {t:?} lacks {needle:?}");
}

async fn is_approved(w: &World, id: &str, who: &near_workspaces::Account) -> bool {
    w.worker
        .view(w.cachet.id(), "nft_is_approved")
        .args_json(json!({"token_id": id, "approved_account_id": who.id()}))
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn approve(w: &World, from: &near_workspaces::Account, id: &str, to: &near_workspaces::Account) {
    let r = from
        .call(w.cachet.id(), "nft_approve")
        .args_json(json!({"token_id": id, "account_id": to.id()}))
        .deposit(milli(10))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "approve {}", fail_text(&r));
}

async fn gift(w: &World, from: &near_workspaces::Account, id: &str, to: &near_workspaces::Account, label: &str) {
    let sk = SigningKey::from_bytes(&Sha256::digest(label.as_bytes()).into());
    let h = w.worker.view_block().await.unwrap().height();
    let r = from
        .call(w.cachet.id(), "create_claim")
        .args_json(json!({"token_id": id, "claim_key": hex::encode(sk.verifying_key().to_bytes()), "expires_at_block": h + 5000}))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "create_claim {}", fail_text(&r));
    let msg = format!("cachet-claim:{}:{}:{}", w.cachet.id(), id, to.id());
    let sig = hex::encode(sk.sign(msg.as_bytes()).to_bytes());
    let r = to
        .call(w.cachet.id(), "claim")
        .args_json(json!({"token_id": id, "new_owner": to.id(), "signature": sig}))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "claim {}", fail_text(&r));
}

/// POC1: Alice approves an accomplice, hands the link to Bob, Bob claims. The accomplice's
/// approval must not survive the claim.
#[tokio::test]
async fn claim_clears_the_old_owners_approvals() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    approve(&w, &w.alice, &id, &w.carol).await;
    assert!(is_approved(&w, &id, &w.carol).await, "approval was granted");
    gift(&w, &w.alice, &id, &w.bob, "approvals link").await;
    assert_eq!(w.owner(&id).await.unwrap(), w.bob.id().as_str());
    assert!(!is_approved(&w, &id, &w.carol).await, "claim must drop the previous owner's approvals");
    assert_reverts(&w.transfer(&w.carol, &id, w.carol.id().as_str()).await, "Sender not approved");
    assert_eq!(w.owner(&id).await.unwrap(), w.bob.id().as_str(), "the receiver keeps the note");
}

async fn free_balance(w: &World) -> i128 {
    let a = w.worker.view_account(w.cachet.id()).await.unwrap();
    a.balance.as_yoctonear() as i128 - (a.storage_usage as u128 * BYTE) as i128
}

/// A note's whole lifecycle plus transfers to fresh owners may not push the contract's free
/// balance (balance minus storage staking) below where it stood before the mints.
#[tokio::test]
async fn the_mint_deposit_funds_every_later_byte_a_note_can_grow() {
    let w = World::new(2).await;
    let before = free_balance(&w).await;
    // receivers with the longest legal account id make the per-owner storage as large as it gets
    let long = |c: char| c.to_string().repeat(54);
    let bob = w.root.create_subaccount(&long('b')).initial_balance(near(10)).transact().await.unwrap().unwrap();
    let carol = w.root.create_subaccount(&long('c')).initial_balance(near(10)).transact().await.unwrap().unwrap();
    assert_eq!(bob.id().as_str().len(), 64);
    let (a, _) = w.sealed_note(&w.alice, 60_000).await;
    let (b, _) = w.sealed_note(&w.alice, 61_000).await;
    let (c, _) = w.sealed_note(&w.alice, 62_000).await;
    // b moves to a fresh owner (a new per-owner set), c is gifted to another fresh owner
    let t = w.transfer(&w.alice, &b, bob.id().as_str()).await;
    assert!(t.is_success(), "{}", fail_text(&t));
    gift(&w, &w.alice, &c, &carol, "storage link").await;
    // a grows to its largest: four additional confirmed outputs, five signatures and a 34-byte destination
    let mut extras = Vec::new();
    for n in 0..4 { extras.push(w.fund(&a, 10_000 + n, 6).await); }
    let additional_outputs = extras.iter().map(|f| json!({
        "raw_tx": f.raw_hex,
        "vout": f.vout,
        "proof": inclusion_proof(&f.txid),
    })).collect::<Vec<_>>();
    let r = w.alice.call(w.cachet.id(), "unseal")
        .args_json(json!({"token_id": a, "btc_dest": TAPROOT_DEST, "fee_rate": 10, "additional_outputs": additional_outputs}))
        .max_gas().transact().await.unwrap();
    assert!(r.is_success() && r.clone().json::<bool>().unwrap(), "unseal {}", fail_text(&r));
    let after = free_balance(&w).await;
    println!("free balance before mints {before}, after lifecycle {after}, slack {} bytes", (after - before) / BYTE as i128);
    assert!(after >= before, "the contract's free balance fell by {} bytes of storage", (before - after) / BYTE as i128);
}

async fn drain_to(w: &World, margin_bytes: u128) {
    let acc = w.worker.view_account(w.cachet.id()).await.unwrap();
    let need = acc.storage_usage as u128 * BYTE + margin_bytes * BYTE;
    let bal = acc.balance.as_yoctonear();
    if bal > need + 25 * BYTE {
        w.cachet.as_account().transfer_near(w.root.id(), NearToken::from_yoctonear(bal - need - 25 * BYTE)).await.unwrap().into_result().unwrap();
    } else {
        w.root.transfer_near(w.cachet.id(), NearToken::from_yoctonear(need + 25 * BYTE - bal)).await.unwrap().into_result().unwrap();
        let acc = w.worker.view_account(w.cachet.id()).await.unwrap();
        let bal = acc.balance.as_yoctonear();
        w.cachet.as_account().transfer_near(w.root.id(), NearToken::from_yoctonear(bal - need - 25 * BYTE)).await.unwrap().into_result().unwrap();
    }
}

fn signature_in_signer_receipt(r: &near_workspaces::result::ExecutionFinalResult, signer: &str) -> Option<Value> {
    for o in r.receipt_outcomes() {
        if o.executor_id.as_str() == signer {
            if let Ok(near_workspaces::result::ValueOrReceiptId::Value(v)) = o.clone().into_result() {
                if let Ok(j) = v.json::<Value>() {
                    if j.get("big_r").is_some() {
                        return Some(j);
                    }
                }
            }
        }
    }
    None
}

/// POC2: the callback fails after the signer signed (no balance for the signature bytes). The
/// signature is public in the signer's receipt, so recover must never make the note
/// transferable again.
#[tokio::test]
async fn a_note_whose_signature_became_public_is_never_resealed() {
    let w = World::new(2).await;
    let mut notes = vec![];
    for _ in 0..10 {
        notes.push(w.sealed_note(&w.alice, 60_000).await);
    }
    let (mut hit, mut m, mut i) = (None, 0u128, 0usize);
    while i < notes.len() && m < 600 {
        let (id, f) = &notes[i];
        drain_to(&w, m).await;
        let before = w.sign_log().await.len();
        let r = w.unseal(&w.alice, id, DEST, 10).await;
        let after = w.sign_log().await.len();
        let st = w.state(id).await;
        println!("margin={m} bytes note={id} unseal_ok={} sign_calls+={} state={st}", r.is_success(), after - before);
        if st == "Unsealing" && after > before {
            hit = Some((id.clone(), f.txid.clone(), r));
            break;
        }
        if st == "Unsealed" {
            i += 1;
            m = m.saturating_sub(16);
        } else {
            m += 8;
        }
    }
    let (id, _txid, r) = hit.expect("no balance margin made on_signed fail after the signer signed");
    assert!(signature_in_signer_receipt(&r, w.signer.id().as_str()).is_some(), "the signature is public in the signer receipt");
    w.root.transfer_near(w.cachet.id(), near(5)).await.unwrap().into_result().unwrap();
    w.worker.fast_forward(410).await.unwrap();
    let rec = w.alice.call(w.cachet.id(), "recover").args_json(json!({"token_id": id})).transact().await.unwrap();
    assert!(rec.is_success(), "recover {}", fail_text(&rec));
    assert_ne!(w.state(&id).await, "Sealed", "a note with a public sweep signature must not be transferable");
    assert_reverts(&w.transfer(&w.alice, &id, w.bob.id().as_str()).await, "cannot move in this state");
    let n = w.note(&id).await.unwrap();
    assert!(!n["sweep"].is_null(), "the unseal destination stays bound to the note");
    // the owner can still obtain a stored signature, to the same destination
    let rs = w.alice.call(w.cachet.id(), "resign").args_json(json!({"token_id": id, "fee_rate": 12})).max_gas().transact().await.unwrap();
    assert!(rs.is_success() && rs.clone().json::<bool>().unwrap(), "resign {}", fail_text(&rs));
    let n = w.note(&id).await.unwrap();
    assert!(!n["sweep"]["signed_tx"].is_null());
}
