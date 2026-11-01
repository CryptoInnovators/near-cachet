//! Throwaway spike: turns a v1.signer key and signature into a Bitcoin sweep and checks it
//! with libbitcoinconsensus, the script engine Bitcoin Core runs.
//!
//!   consensus address <near key> <hrp>
//!   consensus sighash <near key> <txid:vout> <sats> <dest> <rate>
//!   consensus verify  <near key> <txid:vout> <sats> <dest> <rate> <signature response json>

#[path = "../../../../src/btc.rs"]
#[allow(dead_code)]
mod btc;

use bitcoin::consensus::serialize;
use bitcoin::{Amount, ScriptBuf, Transaction, TxOut};

fn key(s: &str) -> [u8; 33] {
    let raw = bs58::decode(s.strip_prefix("secp256k1:").expect("secp256k1: prefix")).into_vec().unwrap();
    btc::compress_pubkey(&raw.try_into().expect("64 bytes"))
}

fn outpoint(value: &str) -> Result<([u8; 32], u32), &'static str> {
    let (txid, vout) = value.split_once(':').ok_or("outpoint must be txid:vout")?;
    if vout.contains(':') { return Err("outpoint must be txid:vout"); }
    Ok((btc::reversed(btc::hex_32(txid)?), vout.parse().map_err(|_| "invalid vout")?))
}

fn sweep(pk: [u8; 33], outpoint_text: &str, sats: u64, dest: &str, rate: u64) -> btc::Sweep {
    let hrp = dest.split('1').next().unwrap();
    let script = btc::address_to_script(hrp, dest).unwrap();
    let (prev_txid, vout) = outpoint(outpoint_text).unwrap();
    btc::Sweep { prev_txid, vout, amount: sats, pubkey: pk, dest_script: script.clone(), fee: btc::sweep_fee(rate, script.len()).unwrap() }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a[1].as_str() {
        "address" => {
            let pk = key(&a[2]);
            println!("{}", btc::p2wpkh_address(&a[3], &pk));
        }
        "sighash" => {
            let s = sweep(key(&a[2]), &a[3], a[4].parse().unwrap(), &a[5], a[6].parse().unwrap());
            println!("{}", btc::hex_encode(&s.sighash()));
        }
        "verify" => {
            let pk = key(&a[2]);
            let s = sweep(pk, &a[3], a[4].parse().unwrap(), &a[5], a[6].parse().unwrap());
            let v: serde_json::Value = serde_json::from_str(&a[7]).unwrap();
            let big_r = btc::hex_decode(v["big_r"]["affine_point"].as_str().unwrap()).unwrap();
            let r: [u8; 32] = big_r[1..].try_into().unwrap();
            let sc = btc::hex_32(v["s"]["scalar"].as_str().unwrap()).unwrap();
            let (r, sc, _) = btc::normalize_low_s(r, sc, v["recovery_id"].as_u64().unwrap() as u8).unwrap();
            let raw = s.signed_tx(&btc::der_signature(&r, &sc));
            let tx: Transaction = bitcoin::consensus::deserialize(&raw).unwrap();
            assert_eq!(serialize(&tx), raw);
            let spk = ScriptBuf::from_bytes(btc::p2wpkh_script(&pk));
            let spent = TxOut { value: Amount::from_sat(s.amount), script_pubkey: spk.clone() };
            tx.verify(|_| Some(spent.clone())).expect("libbitcoinconsensus rejected the sweep");
            // negative case: the same signature on a sweep with one satoshi more fee must fail
            let mut worse = s.clone();
            worse.fee += 1;
            let bad: Transaction = bitcoin::consensus::deserialize(&worse.signed_tx(&btc::der_signature(&r, &sc))).unwrap();
            assert!(bad.verify(|_| Some(spent.clone())).is_err(), "tampered sweep must not verify");
            println!("CONSENSUS OK txid {} input {}:{} vsize {} fee {} tampered_rejected true", tx.compute_txid(), a[3].split(':').next().unwrap(), s.vout, tx.vsize(), s.fee);
            println!("{}", btc::hex_encode(&raw));
        }
        _ => panic!("unknown command"),
    }
}
