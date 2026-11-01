//! The demo page (web/) derives addresses and signs claim links in JavaScript. These tests read the
//! same `web/vectors.json` as `web/web.test.mjs` and check it against independent Rust code, so the
//! page and the contract cannot drift apart unnoticed.

use bitcoin::{Address, CompressedPublicKey, Network};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::Value;

fn vectors() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("web/vectors.json");
    serde_json::from_slice(&std::fs::read(p).expect("web/vectors.json")).expect("valid json")
}

#[test]
fn page_addresses_match_the_bitcoin_crate() {
    let v = vectors();
    let list = v["address"].as_array().expect("address vectors");
    assert!(list.len() >= 2, "vector list is empty");
    for e in list {
        let key = e["signerKey"].as_str().unwrap().strip_prefix("secp256k1:").unwrap();
        let xy = bs58::decode(key).into_vec().unwrap();
        assert_eq!(xy.len(), 64);
        let mut sec1 = vec![0x04];
        sec1.extend_from_slice(&xy);
        let pk = CompressedPublicKey::from_slice(&secp_compress(&sec1)).unwrap();
        assert_eq!(hex::encode(pk.to_bytes()), e["compressed"].as_str().unwrap());
        assert_eq!(Address::p2wpkh(&pk, Network::Bitcoin).to_string(), e["address"].as_str().unwrap(), "{}", e["source"]);
    }
}

fn secp_compress(uncompressed: &[u8]) -> Vec<u8> {
    let mut out = vec![if uncompressed[64] & 1 == 0 { 0x02 } else { 0x03 }];
    out.extend_from_slice(&uncompressed[1..33]);
    out
}

#[test]
fn page_claim_signature_is_the_ed25519_signature_over_the_contract_message() {
    let v = vectors();
    let c = &v["claim"];
    let seed: [u8; 32] = hex::decode(c["seed"].as_str().unwrap()).unwrap().try_into().unwrap();
    let sk = SigningKey::from_bytes(&seed);
    assert_eq!(hex::encode(sk.verifying_key().to_bytes()), c["publicKey"].as_str().unwrap());
    let msg = format!("cachet-claim:{}:{}:{}", c["contract"].as_str().unwrap(), c["token"].as_str().unwrap(), c["newOwner"].as_str().unwrap());
    assert_eq!(msg, c["message"].as_str().unwrap());
    let sig = hex::decode(c["signature"].as_str().unwrap()).unwrap();
    assert_eq!(hex::encode(sk.sign(msg.as_bytes()).to_bytes()), hex::encode(&sig));
    let vk = VerifyingKey::from_bytes(&hex::decode(c["publicKey"].as_str().unwrap()).unwrap().try_into().unwrap()).unwrap();
    vk.verify(msg.as_bytes(), &ed25519_dalek::Signature::from_slice(&sig).unwrap()).unwrap();
}
