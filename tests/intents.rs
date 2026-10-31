//! The real mainnet intents.near code (fetched byte for byte with view_code) receives a
//! sealed note through nft_transfer_call. While it holds the note nobody can unseal it.

mod common;

use common::*;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, KeyType, NearToken, SecretKey};
use near_workspaces::{AccountId, Contract, Worker};
use serde_json::json;

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

#[tokio::test]
async fn real_intents_near_holds_a_sealed_note_and_nobody_can_unseal_it() {
    let w = World::new(2).await;
    let wrap = patch_contract(&w.worker, "wrap.near", &fixture_wasm("wrap_near.wasm")).await;
    wrap.call("new").transact().await.unwrap().into_result().unwrap();
    let intents = patch_contract(&w.worker, "intents.near", &fixture_wasm("intents.wasm")).await;
    intents
        .call("new")
        .args_json(json!({"config": {"wnear_id": "wrap.near", "fees": {"fee": 0, "fee_collector": w.root.id()}, "roles": {}}}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();

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
