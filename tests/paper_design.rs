//! Design changes taken from docs/PRIOR-ART.md, each with a must-fail case.

mod common;

use common::*;
use serde_json::json;

fn assert_reverts(r: &near_workspaces::result::ExecutionFinalResult, needle: &str) {
    assert!(r.is_failure(), "expected a revert containing {needle:?}");
    let t = fail_text(r);
    assert!(t.contains(needle), "revert text {t:?} lacks {needle:?}");
}

/// A serialized transaction whose witness-stripped form is exactly 64 bytes, the size of a
/// Merkle inner node (WTSC25, Core Chain forgery).
fn tx_of_64_bytes() -> String {
    let mut raw = vec![1, 0, 0, 0, 1];
    raw.extend_from_slice(&[7u8; 32]);
    raw.extend_from_slice(&0u32.to_le_bytes());
    raw.push(0);
    raw.extend_from_slice(&u32::MAX.to_le_bytes());
    raw.push(1);
    raw.extend_from_slice(&5000u64.to_le_bytes());
    raw.extend_from_slice(&[4, 0xaa, 0xbb, 0xcc, 0xdd]);
    raw.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(raw.len(), 64);
    hex::encode(raw)
}

async fn verify_calls(w: &World) -> u64 {
    w.worker.view(w.signer.id(), "verify_calls").await.unwrap().json().unwrap()
}

#[tokio::test]
async fn attest_and_finalize_reject_a_64_byte_transaction_before_asking_the_signer() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 60_000).await;
    let spent = verify_calls(&w).await;
    assert!(spent > 0, "the honest attest did reach verify_foreign_transaction");
    let minted = w.mint(&w.alice).await;
    let r = w
        .alice
        .call(w.cachet.id(), "attest")
        .args_json(json!({"token_id": minted, "raw_tx": tx_of_64_bytes(), "vout": 0}))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert_reverts(&r, "64-byte transaction");
    assert_eq!(w.state(&minted).await, "Minted");
    assert!(w.unseal(&w.alice, &id, DEST, 10).await.json::<bool>().unwrap());
    let r = w
        .bob
        .call(w.cachet.id(), "finalize")
        .args_json(json!({"token_id": id, "sweep_raw_tx": tx_of_64_bytes()}))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert_reverts(&r, "64-byte transaction");
    assert_eq!(w.state(&id).await, "Unsealed");
    assert_eq!(verify_calls(&w).await, spent, "no 64-byte attempt reached the signer");
}

#[tokio::test]
async fn a_failed_derivation_mints_no_note_and_shows_no_address() {
    let w = World::new(2).await;
    let wasm = build_wasm(".", "cachet", true);
    let orphan = w.root.create_subaccount("orphan").initial_balance(near(30)).transact().await.unwrap().unwrap();
    let orphan = orphan.deploy(&wasm).await.unwrap().unwrap();
    orphan
        .call("new")
        .args_json(json!({"signer_id": "no-signer.test.near", "hrp": "bc", "confirmations": 2}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let before = w.alice.view_account().await.unwrap().balance;
    let r = w.alice.call(orphan.id(), "mint_note").deposit(milli(50)).max_gas().transact().await.unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(r.json::<Option<String>>().unwrap(), None, "mint reports no token");
    let supply: String = w.worker.view(orphan.id(), "nft_total_supply").await.unwrap().json().unwrap();
    assert_eq!(supply, "0");
    let n: Option<serde_json::Value> = w.worker.view(orphan.id(), "note").args_json(json!({"token_id": "1"})).await.unwrap().json().unwrap();
    assert!(n.is_none(), "no note, so no funding address anywhere");
    let after = w.alice.view_account().await.unwrap().balance;
    assert!(before.as_yoctonear() - after.as_yoctonear() < milli(5).as_yoctonear(), "deposit refunded, only gas spent");
}
