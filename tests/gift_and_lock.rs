//! Claim links (ed25519 bearer signature with a claw-back timelock) and the listing lock
//! (a note held by an escrow account cannot be unsealed).

mod common;

use common::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn assert_reverts(r: &near_workspaces::result::ExecutionFinalResult, needle: &str) {
    assert!(r.is_failure(), "expected a revert containing {needle:?}");
    let t = fail_text(r);
    assert!(t.contains(needle), "revert text {t:?} lacks {needle:?}");
}

struct Link {
    sk: SigningKey,
}

impl Link {
    fn new(label: &str) -> Link {
        Link { sk: SigningKey::from_bytes(&Sha256::digest(label.as_bytes()).into()) }
    }
    fn pubkey(&self) -> String {
        hex::encode(self.sk.verifying_key().to_bytes())
    }
    fn sign(&self, w: &World, id: &str, new_owner: &str) -> String {
        let msg = format!("cachet-claim:{}:{}:{}", w.cachet.id(), id, new_owner);
        hex::encode(self.sk.sign(msg.as_bytes()).to_bytes())
    }
}

async fn create_claim(w: &World, who: &near_workspaces::Account, id: &str, link: &Link, ahead: u64) -> near_workspaces::result::ExecutionFinalResult {
    let h = w.worker.view_block().await.unwrap().height();
    who.call(w.cachet.id(), "create_claim")
        .args_json(json!({"token_id": id, "claim_key": link.pubkey(), "expires_at_block": h + ahead}))
        .max_gas()
        .transact()
        .await
        .unwrap()
}

async fn claim(w: &World, id: &str, new_owner: &str, sig: String) -> near_workspaces::result::ExecutionFinalResult {
    w.carol.call(w.cachet.id(), "claim").args_json(json!({"token_id": id, "new_owner": new_owner, "signature": sig})).max_gas().transact().await.unwrap()
}

#[tokio::test]
async fn claim_link_moves_a_sealed_note_once_and_binds_the_receiver() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    let link = Link::new("link one");
    assert_reverts(&create_claim(&w, &w.bob, &id, &link, 5000).await, "only the note owner can do this");
    assert_reverts(&create_claim(&w, &w.alice, &id, &link, 100).await, "expiry must be 3600 to 3000000 blocks ahead");
    assert!(create_claim(&w, &w.alice, &id, &link, 5000).await.is_success());
    assert_reverts(&create_claim(&w, &w.alice, &id, &Link::new("two"), 5000).await, "a claim link already exists");
    let n = w.note(&id).await.unwrap();
    assert_eq!(n["claim"]["locked"], true);

    // a signature for bob cannot be redirected to carol
    let for_bob = link.sign(&w, &id, w.bob.id().as_str());
    assert_reverts(&claim(&w, &id, w.carol.id().as_str(), for_bob.clone()).await, "bad claim signature");
    // a signature from another key is refused
    let forged = Link::new("not the link").sign(&w, &id, w.bob.id().as_str());
    assert_reverts(&claim(&w, &id, w.bob.id().as_str(), forged).await, "bad claim signature");
    assert_reverts(&claim(&w, &id, w.bob.id().as_str(), "00".into()).await, "signature must be 64 bytes");

    // the sender cannot take it back while the link is locked
    assert_reverts(&w.transfer(&w.alice, &id, w.carol.id().as_str()).await, "claim link is active");
    assert_reverts(&w.unseal(&w.alice, &id, DEST, 5).await, "claim link is active");
    assert_reverts(&w.alice.call(w.cachet.id(), "cancel_claim").args_json(json!({"token_id": id})).transact().await.unwrap(), "claim link is still locked");
    assert!(w.sign_log().await.is_empty(), "sender never reached sign");

    let r = claim(&w, &id, w.bob.id().as_str(), for_bob.clone()).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(w.owner(&id).await.unwrap(), w.bob.id().as_str());
    assert!(w.note(&id).await.unwrap()["claim"].is_null());
    // replaying the same signature does nothing
    assert_reverts(&claim(&w, &id, w.bob.id().as_str(), for_bob).await, "no claim link");
    // the new owner is in control
    assert_reverts(&w.unseal(&w.alice, &id, DEST, 5).await, "only the note owner can request a signature");
    assert!(w.unseal(&w.bob, &id, DEST, 5).await.json::<bool>().unwrap());
}

#[tokio::test]
async fn after_expiry_the_sender_can_cancel_or_unseal() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    let link = Link::new("link two");
    assert!(create_claim(&w, &w.alice, &id, &link, 3700).await.is_success());
    w.worker.fast_forward(3800).await.unwrap();
    let sig = link.sign(&w, &id, w.bob.id().as_str());
    // an expired link still works until the owner acts
    assert_eq!(w.note(&id).await.unwrap()["claim"]["locked"], false);
    assert!(w.alice.call(w.cachet.id(), "cancel_claim").args_json(json!({"token_id": id})).transact().await.unwrap().is_success());
    assert_reverts(&claim(&w, &id, w.bob.id().as_str(), sig).await, "no claim link");
    assert_eq!(w.owner(&id).await.unwrap(), w.alice.id().as_str());
}

#[tokio::test]
async fn expired_link_still_claims_until_the_owner_acts() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    let link = Link::new("link three");
    assert!(create_claim(&w, &w.alice, &id, &link, 3700).await.is_success());
    w.worker.fast_forward(3800).await.unwrap();
    assert!(claim(&w, &id, w.bob.id().as_str(), link.sign(&w, &id, w.bob.id().as_str())).await.is_success());
    assert_eq!(w.owner(&id).await.unwrap(), w.bob.id().as_str());
}

#[tokio::test]
async fn selling_the_note_kills_the_claim_link() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    let link = Link::new("link four");
    assert!(create_claim(&w, &w.alice, &id, &link, 3700).await.is_success());
    w.worker.fast_forward(3800).await.unwrap();
    // seller hands the note to a buyer after the lock expired; the link must not survive
    assert!(w.transfer(&w.alice, &id, w.bob.id().as_str()).await.is_success());
    assert!(w.note(&id).await.unwrap()["claim"].is_null());
    assert_reverts(&claim(&w, &id, w.alice.id().as_str(), link.sign(&w, &id, w.alice.id().as_str())).await, "no claim link");
    assert_eq!(w.owner(&id).await.unwrap(), w.bob.id().as_str());
}

#[tokio::test]
async fn unsealed_note_cannot_be_gifted_or_claimed() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    let link = Link::new("link five");
    assert!(create_claim(&w, &w.alice, &id, &link, 3700).await.is_success());
    w.worker.fast_forward(3800).await.unwrap();
    assert!(w.unseal(&w.alice, &id, DEST, 5).await.json::<bool>().unwrap());
    assert!(w.note(&id).await.unwrap()["claim"].is_null(), "unseal clears the link");
    assert_reverts(&claim(&w, &id, w.bob.id().as_str(), link.sign(&w, &id, w.bob.id().as_str())).await, "note cannot move in this state");
    assert_reverts(&create_claim(&w, &w.alice, &id, &link, 5000).await, "note cannot be gifted in this state");
}

async fn market(w: &World) -> near_workspaces::Contract {
    let wasm = build_wasm("fixtures/market", "cachet_market_fixture", false);
    let m = w.root.create_subaccount("market").initial_balance(near(20)).transact().await.unwrap().unwrap();
    m.deploy(&wasm).await.unwrap().unwrap()
}

async fn transfer_call(w: &World, who: &near_workspaces::Account, to: &str, id: &str, msg: &str) -> near_workspaces::result::ExecutionFinalResult {
    who.call(w.cachet.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id": to, "token_id": id, "msg": msg}))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap()
}

#[tokio::test]
async fn a_note_held_by_an_escrow_cannot_be_unsealed_by_the_seller() {
    let w = World::new(2).await;
    let m = market(&w).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    let r = transfer_call(&w, &w.alice, m.id().as_str(), &id, "keep").await;
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(w.owner(&id).await.unwrap(), m.id().as_str(), "escrow holds the note");
    assert_eq!(w.note(&id).await.unwrap()["in_transfer"], false, "transfer resolved");
    assert_reverts(&w.unseal(&w.alice, &id, DEST, 5).await, "only the note owner can request a signature");
    assert_reverts(&w.transfer(&w.alice, &id, w.bob.id().as_str()).await, "");
    assert!(w.sign_log().await.is_empty());
    // the escrow releases it to the buyer, who can unseal
    let r = w.bob.call(m.id(), "release").args_json(json!({"nft": w.cachet.id(), "token_id": id, "to": w.bob.id()})).deposit(near_workspaces::types::NearToken::from_yoctonear(1)).max_gas().transact().await.unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(w.owner(&id).await.unwrap(), w.bob.id().as_str());
    assert!(w.unseal(&w.bob, &id, DEST, 5).await.json::<bool>().unwrap());
}

#[tokio::test]
async fn a_receiver_cannot_unseal_from_inside_nft_on_transfer() {
    let w = World::new(2).await;
    let m = market(&w).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    let r = transfer_call(&w, &w.alice, m.id().as_str(), &id, &format!("unseal:{DEST}")).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(w.state(&id).await, "Sealed", "mid-transfer unseal did not start");
    assert!(w.sign_log().await.is_empty(), "sign was never reached from inside the transfer");
}

#[tokio::test]
async fn escrow_that_returns_the_note_hands_it_back() {
    let w = World::new(2).await;
    let m = market(&w).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    assert!(transfer_call(&w, &w.alice, m.id().as_str(), &id, "return").await.is_success());
    assert_eq!(w.owner(&id).await.unwrap(), w.alice.id().as_str());
    assert_eq!(w.note(&id).await.unwrap()["in_transfer"], false);
    assert!(w.unseal(&w.alice, &id, DEST, 5).await.json::<bool>().unwrap());
}

#[tokio::test]
async fn unsealed_note_cannot_be_listed() {
    let w = World::new(2).await;
    let m = market(&w).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    assert!(w.unseal(&w.alice, &id, DEST, 5).await.json::<bool>().unwrap());
    assert_reverts(&transfer_call(&w, &w.alice, m.id().as_str(), &id, "keep").await, "cannot move in this state");
    let v: Value = w.note(&id).await.unwrap();
    assert_eq!(v["owner_id"], w.alice.id().as_str());
}

#[tokio::test]
async fn the_signature_made_by_the_web_page_moves_the_note() {
    let v: Value = serde_json::from_slice(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("web/vectors.json")).unwrap()).unwrap();
    let c = &v["claim"];
    let w = World::new(2).await;
    assert_eq!(w.cachet.id().as_str(), c["contract"].as_str().unwrap(), "vector assumes this contract account");
    assert_eq!(w.bob.id().as_str(), c["newOwner"].as_str().unwrap(), "vector assumes this receiver");
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    assert_eq!(id, c["token"].as_str().unwrap(), "vector assumes this token id");
    let h = w.worker.view_block().await.unwrap().height();
    let r = w
        .alice
        .call(w.cachet.id(), "create_claim")
        .args_json(json!({"token_id": id, "claim_key": c["publicKey"], "expires_at_block": h + 5000}))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    let sig = c["signature"].as_str().unwrap().to_string();
    assert_reverts(&claim(&w, &id, w.carol.id().as_str(), sig.clone()).await, "bad claim signature");
    let r = claim(&w, &id, w.bob.id().as_str(), sig).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(w.owner(&id).await.unwrap(), w.bob.id().as_str());
}
