mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::*;
use near_sdk::borsh::from_slice;
use serde_json::json;

#[tokio::test]
async fn a_proof_for_another_block_leaves_the_note_minted() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    let funding = w.fund(&id, 20_000, 6).await;
    let mut proof = inclusion_proof(&funding.txid);
    proof["block_hash"] = json!("ff".repeat(32));
    let r = w.alice.call(w.cachet.id(), "attest")
        .args_json(json!({"token_id": id, "raw_tx": funding.raw_hex, "vout": funding.vout, "proof": proof}))
        .max_gas().transact().await.unwrap();
    assert!(r.is_success());
    assert_eq!(r.json::<bool>().unwrap(), false);
    assert_eq!(w.state(&id).await, "Minted");
}

#[tokio::test]
async fn an_unknown_tx_leaves_the_note_minted() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    let funding = w.fund(&id, 20_000, 6).await;
    let mut raw = hex::decode(&funding.raw_hex).unwrap();
    let last = raw.len() - 1;
    raw[last] ^= 1;
    let r = w.alice.call(w.cachet.id(), "attest")
        .args_json(json!({"token_id": id, "raw_tx": hex::encode(raw), "vout": funding.vout, "proof": inclusion_proof(&funding.txid)}))
        .max_gas().transact().await.unwrap();
    assert!(r.is_success());
    assert_eq!(r.json::<bool>().unwrap(), false);
    assert_eq!(w.state(&id).await, "Minted");
    assert!(w.note(&id).await.unwrap()["utxo"].is_null());
}

#[tokio::test]
async fn an_unconfirmed_sweep_cannot_park_a_note() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 60_000).await;
    assert!(w.unseal(&w.alice, &id, DEST, 10).await.json::<bool>().unwrap());
    let raw: Option<String> = w.worker.view(w.cachet.id(), "signed_sweep_tx").args_json(json!({"token_id": id})).await.unwrap().json().unwrap();
    let raw = raw.unwrap();
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&hex::decode(&raw).unwrap()).unwrap();
    let txid = tx.compute_txid().to_string();
    w.confirm(&txid, 1).await;
    let r = w.finalize(&w.bob, &id, raw, &txid).await;
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(r.json::<bool>().unwrap(), false);
    assert_eq!(w.state(&id).await, "Unsealed");
    let r = w.alice.call(w.cachet.id(), "resign").args_json(json!({"token_id": id, "fee_rate": 11})).max_gas().transact().await.unwrap();
    assert!(r.is_success(), "{}", fail_text(&r));
    assert_eq!(r.json::<bool>().unwrap(), true);
}

#[tokio::test]
async fn the_light_client_gets_the_contracts_own_txid() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    let funding = w.fund(&id, 20_000, 6).await;
    assert!(w.attest(&w.alice, &id, &funding).await.is_success());
    let encoded: String = w.worker.view(w.signer.id(), "lc_last_args").await.unwrap().json().unwrap();
    let args: cachet::light_client::ProofArgsV2 = from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    let parsed = cachet::btc::parse_tx(&hex::decode(&funding.raw_hex).unwrap()).unwrap();
    assert_eq!(args.tx_id, parsed.txid);
}
