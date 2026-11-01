//! The real mainnet intents.near code (fetched byte for byte with view_code) receives a
//! sealed note through nft_transfer_call. While it holds the note nobody can unseal it.

mod common;

use common::*;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, KeyType, NearToken, SecretKey};
use near_workspaces::{AccountId, Contract, Worker};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

async fn patch_contract(worker: &Worker<Sandbox>, id: &str, wasm: &[u8]) -> Contract {
    let id: AccountId = id.parse().unwrap();
    let sk = SecretKey::from_seed(KeyType::ED25519, id.as_str());
    worker
        .patch(&id)
        .account(AccountDetailsPatch::default().balance(near(1000)))
        .access_key(sk.public_key(), AccessKey::full_access())
        .code(wasm)
        .transact()
        .await
        .unwrap();
    Contract::from_secret_key(id, sk, worker)
}


async fn deploy_market(w: &World, fee: u32) -> (Contract, Contract) {
    let wrap = patch_contract(&w.worker, "wrap.near", &fixture_wasm("wrap_near.wasm")).await;
    wrap.call("new").transact().await.unwrap().into_result().unwrap();
    let intents = patch_contract(&w.worker, "intents.near", &fixture_wasm("intents.wasm")).await;
    intents
        .call("new")
        .args_json(json!({"config": {"wnear_id": "wrap.near", "fees": {"fee": fee, "fee_collector": w.root.id()}, "roles": {}}}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    (wrap, intents)
}

#[tokio::test]
async fn real_intents_near_holds_a_sealed_note_and_nobody_can_unseal_it() {
    let w = World::new(2).await;
    let (_wrap, intents) = deploy_market(&w, 0).await;

    let (id, _) = w.sealed_note(&w.alice, 75_000).await;
    let r = w
        .alice
        .call(w.cachet.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id": "intents.near", "token_id": id, "msg": ""}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    println!("GAS nft_transfer_call into intents.near {:.1} Tgas", tgas(r.total_gas_burnt));
    assert_eq!(w.owner(&id).await.unwrap(), "intents.near", "intents.near keeps the note");
    let mt_id = format!("nep171:{}:{}", w.cachet.id(), id);
    let bal: String = w.worker.view(intents.id(), "mt_balance_of").args_json(json!({"account_id": w.alice.id(), "token_id": mt_id})).await.unwrap().json().unwrap();
    assert_eq!(bal, "1", "alice holds the note as an intents.near balance");

    let r = w.unseal(&w.alice, &id, DEST, 5).await;
    assert!(r.is_failure() && fail_text(&r).contains("only the note owner can request a signature"), "{}", fail_text(&r));
    let r = w
        .alice
        .call(w.cachet.id(), "nft_transfer")
        .args_json(json!({"receiver_id": w.alice.id(), "token_id": id}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_failure(), "seller cannot pull the note back out of intents.near");
    assert!(w.sign_log().await.is_empty());
}

fn seed_key(label: &str) -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(label.as_bytes()).into())
}

fn ed25519_str(bytes: &[u8]) -> String {
    format!("ed25519:{}", bs58::encode(bytes).into_string())
}

/// A raw_ed25519 intents payload carrying one token_diff, signed by `sk` for `signer`.
fn signed_diff(sk: &SigningKey, signer: &str, nonce_label: &str, diff: Value) -> Value {
    let nonce = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(nonce_label.as_bytes()));
    let payload = json!({
        "signer_id": signer,
        "verifying_contract": "intents.near",
        "deadline": "2099-01-01T00:00:00Z",
        "nonce": nonce,
        "intents": [{"intent": "token_diff", "diff": diff}],
    })
    .to_string();
    json!({
        "standard": "raw_ed25519",
        "payload": payload,
        "public_key": ed25519_str(sk.verifying_key().as_bytes()),
        "signature": ed25519_str(&sk.sign(payload.as_bytes()).to_bytes()),
    })
}

const PRICE: u128 = 3_000_000_000_000_000_000_000_000;

struct Sale {
    w: World,
    intents: Contract,
    id: String,
    note_token: String,
    alice_key: SigningKey,
    bob_key: SigningKey,
    fee: u128,
}

impl Sale {
    async fn balance(&self, who: &str, token: &str) -> String {
        self.w.worker.view(self.intents.id(), "mt_balance_of").args_json(json!({"account_id": who, "token_id": token})).await.unwrap().json().unwrap()
    }

    fn diffs(&self, bob_pays: u128) -> (Value, Value) {
        let seller_gets = PRICE - (PRICE * self.fee).div_ceil(1_000_000);
        let alice = signed_diff(&self.alice_key, self.w.alice.id().as_str(), "alice sells", json!({self.note_token.clone(): "-1", "nep141:wrap.near": seller_gets.to_string()}));
        let bob = signed_diff(&self.bob_key, self.w.bob.id().as_str(), "bob buys", json!({self.note_token.clone(): "1", "nep141:wrap.near": format!("-{bob_pays}")}));
        (alice, bob)
    }

    async fn execute(&self, signed: Vec<Value>) -> near_workspaces::result::ExecutionFinalResult {
        self.w.carol.call(self.intents.id(), "execute_intents").args_json(json!({"signed": signed})).max_gas().transact().await.unwrap()
    }
}

/// Alice's sealed note and Bob's wNEAR both sit as intents.near balances, each side has registered
/// the ed25519 key it will sign with, and carol is the relayer.
async fn market_with_a_sealed_note(fee: u128) -> Sale {
    let w = World::new(2).await;
    let (wrap, intents) = deploy_market(&w, fee as u32).await;
    let (id, _) = w.sealed_note(&w.alice, 75_000).await;
    let r = w
        .alice
        .call(w.cachet.id(), "nft_transfer_call")
        .args_json(json!({"receiver_id": "intents.near", "token_id": id, "msg": ""}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));

    let r = w.bob.call(wrap.id(), "near_deposit").deposit(near(5)).transact().await.unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    let r = w.bob.call(wrap.id(), "storage_deposit").args_json(json!({"account_id": "intents.near"})).deposit(near(1)).transact().await.unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    let r = w
        .bob
        .call(wrap.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": "intents.near", "amount": PRICE.to_string(), "msg": ""}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));

    let (alice_key, bob_key) = (seed_key("alice intents key"), seed_key("bob intents key"));
    for (who, key) in [(&w.alice, &alice_key), (&w.bob, &bob_key)] {
        let r = who
            .call(intents.id(), "add_public_key")
            .args_json(json!({"public_key": ed25519_str(key.verifying_key().as_bytes())}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await
            .unwrap();
        assert!(r.is_success(), "{}", fail_text(&r));
    }
    let note_token = format!("nep171:{}:{}", w.cachet.id(), id);
    let sale = Sale { w, intents, id, note_token, alice_key, bob_key, fee };
    assert_eq!(sale.balance(sale.w.alice.id().as_str(), &sale.note_token).await, "1", "alice holds the note in intents.near");
    assert_eq!(sale.balance(sale.w.bob.id().as_str(), "nep141:wrap.near").await, PRICE.to_string(), "bob holds the price in intents.near");
    sale
}

#[tokio::test]
async fn a_signed_token_diff_trade_hands_the_unseal_right_to_the_buyer() {
    let s = market_with_a_sealed_note(0).await;

    // a buyer who signs for less than the seller asks does not trade, and nothing moves
    let (alice, bob_short) = s.diffs(PRICE - 1);
    let r = s.execute(vec![alice, bob_short]).await;
    assert!(r.is_failure(), "mismatched diffs must not execute");
    println!("MISMATCHED DIFFS REVERT: {}", fail_text(&r).lines().next().unwrap_or(""));
    assert_eq!(s.balance(s.w.alice.id().as_str(), &s.note_token).await, "1");
    assert_eq!(s.balance(s.w.bob.id().as_str(), "nep141:wrap.near").await, PRICE.to_string());

    let (alice, bob) = s.diffs(PRICE);
    let r = s.execute(vec![alice.clone(), bob.clone()]).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    println!("GAS execute_intents note for wNEAR {:.1} Tgas", tgas(r.total_gas_burnt));
    assert_eq!(s.balance(s.w.bob.id().as_str(), &s.note_token).await, "1", "buyer holds the note");
    assert_eq!(s.balance(s.w.alice.id().as_str(), &s.note_token).await, "0", "seller no longer does");
    assert_eq!(s.balance(s.w.alice.id().as_str(), "nep141:wrap.near").await, PRICE.to_string(), "seller holds the price");
    assert_eq!(s.balance(s.w.bob.id().as_str(), "nep141:wrap.near").await, "0");

    // the same signed intents cannot run twice
    assert!(s.execute(vec![alice, bob]).await.is_failure(), "replay of the signed intents");

    // the seller cannot pull the note out after the sale
    let take = |who: &near_workspaces::Account| {
        who.call(s.intents.id(), "nft_withdraw")
            .args_json(json!({"token": s.w.cachet.id(), "receiver_id": who.id(), "token_id": s.id}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
    };
    assert!(take(&s.w.alice).await.unwrap().is_failure(), "seller has no balance left to withdraw");
    assert_eq!(s.w.owner(&s.id).await.unwrap(), "intents.near");

    // the buyer withdraws it, and only the buyer can unseal it
    let r = take(&s.w.bob).await.unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(s.w.owner(&s.id).await.unwrap(), s.w.bob.id().as_str(), "the note lives in bob's NEAR account");
    let r = s.w.unseal(&s.w.alice, &s.id, DEST, 5).await;
    assert!(r.is_failure() && fail_text(&r).contains("only the note owner can request a signature"), "{}", fail_text(&r));
    assert!(s.w.sign_log().await.is_empty(), "the seller never reached sign");
    let r = s.w.unseal(&s.w.bob, &s.id, DEST, 5).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(s.w.sign_log().await.len(), 1, "the buyer reached sign once");
}

#[tokio::test]
async fn a_sale_at_the_live_fee_settles() {
    let s = market_with_a_sealed_note(1).await;
    let fee = PRICE.div_ceil(1_000_000);
    let (alice, bob) = s.diffs(PRICE);
    let buyer_short = s.diffs(PRICE - fee);
    let r = s.execute(vec![alice.clone(), buyer_short.1]).await;
    assert!(r.is_failure(), "buyer short by 1 yocto must not settle");
    assert_eq!(s.balance(s.w.alice.id().as_str(), &s.note_token).await, "1");
    assert_eq!(s.balance(s.w.bob.id().as_str(), "nep141:wrap.near").await, PRICE.to_string());

    let r = s.execute(vec![alice, bob]).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(s.balance(s.w.bob.id().as_str(), &s.note_token).await, "1");
    assert_eq!(s.balance(s.w.alice.id().as_str(), "nep141:wrap.near").await, (PRICE - fee).to_string());
}

#[tokio::test]
async fn a_seller_who_withdraws_before_execution_voids_the_trade() {
    let s = market_with_a_sealed_note(0).await;
    let (alice, bob) = s.diffs(PRICE);
    let r = s
        .w
        .alice
        .call(s.intents.id(), "nft_withdraw")
        .args_json(json!({"token": s.w.cachet.id(), "receiver_id": s.w.alice.id(), "token_id": s.id}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(s.w.owner(&s.id).await.unwrap(), s.w.alice.id().as_str());
    let r = s.execute(vec![alice, bob]).await;
    assert!(r.is_failure(), "the signed trade cannot run without the note");
    assert_eq!(s.balance(s.w.bob.id().as_str(), "nep141:wrap.near").await, PRICE.to_string(), "buyer keeps the price");
    assert_eq!(s.w.owner(&s.id).await.unwrap(), s.w.alice.id().as_str());
}
