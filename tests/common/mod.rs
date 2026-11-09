#![allow(dead_code)]
//! Sandbox world: the Cachet contract built with cargo-near, a signer harness that speaks the
//! v1.signer ABI with known keys, and an independent Bitcoin implementation (the `bitcoin`
//! crate) that checks everything the contract produces.

use bitcoin::absolute::LockTime;
use bitcoin::consensus::{deserialize, serialize};
use bitcoin::hashes::Hash;
use bitcoin::secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::{Address, Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

pub const MAX_GAS: Gas = Gas::from_tgas(300);

pub fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

pub fn milli(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}

pub fn root_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Newest mtime among the sources a package build depends on.
fn newest_source(dir: &str) -> std::time::SystemTime {
    let mut newest = std::time::UNIX_EPOCH;
    let base = root_dir().join(dir);
    let mut stack = vec![base.join("src"), base.join("Cargo.toml")];
    if dir != "." {
        stack.push(root_dir().join("Cargo.lock"));
    }
    while let Some(p) = stack.pop() {
        if p.file_name().map_or(false, |n| n.to_string_lossy().starts_with("._")) {
            continue;
        }
        let md = std::fs::metadata(&p).unwrap();
        if md.is_dir() {
            for e in std::fs::read_dir(&p).unwrap() {
                stack.push(e.unwrap().path());
            }
        } else {
            newest = newest.max(md.modified().unwrap());
        }
    }
    newest
}

static BUILT: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();

/// Builds `dir` with cargo-near once per process and returns the wasm.
pub fn build_wasm(dir: &str, name: &str, abi: bool) -> Vec<u8> {
    let map = BUILT.get_or_init(|| Mutex::new(HashMap::new()));
    let mut g = map.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = g.get(name) {
        return w.clone();
    }
    let out = root_dir().join("target/wasm");
    std::fs::create_dir_all(&out).unwrap();
    let built = out.join(format!("{name}.wasm"));
    if std::fs::metadata(&built).and_then(|m| m.modified()).map_or(false, |m| m >= newest_source(dir)) {
        let w = std::fs::read(&built).unwrap();
        assert_host_panic(name, &w);
        g.insert(name.to_string(), w.clone());
        return w;
    }
    let mut args = vec!["near", "build", "non-reproducible-wasm", "--env", NEAR_RUSTFLAGS, "--manifest-path"];
    let manifest = root_dir().join(dir).join("Cargo.toml");
    let manifest = manifest.to_string_lossy().to_string();
    args.push(&manifest);
    args.extend(["--out-dir", out.to_str().unwrap()]);
    if !abi || std::env::var_os("CACHET_NO_ABI").is_some() {
        args.push("--no-abi");
    }
    let st = Command::new("cargo").args(&args).status().expect("cargo-near is not installed");
    assert!(st.success(), "cargo near build failed for {dir}");
    let w = std::fs::read(out.join(format!("{name}.wasm"))).expect("wasm missing after build");
    assert_host_panic(name, &w);
    g.insert(name.to_string(), w.clone());
    w
}

/// cargo-near sets RUSTFLAGS itself, which hides `.cargo/config.toml`; the `near` cfg
/// selects the on-chain panic_utf8, sha256 and ripemd160 host functions in near-sdk.
pub const NEAR_RUSTFLAGS: &str = "RUSTFLAGS=--cfg near -C link-arg=-s";

fn assert_host_panic(name: &str, w: &[u8]) {
    if name == "cachet" {
        assert!(w.windows(10).any(|x| x == b"panic_utf8"), "cachet.wasm lacks the panic_utf8 import: built without --cfg near");
    }
}

pub fn fixture_wasm(name: &str) -> Vec<u8> {
    let p = root_dir().join("fixtures/wasm").join(name);
    std::fs::read(&p).unwrap_or_else(|_| panic!("{} missing: run scripts/fetch-fixtures.sh", p.display()))
}

pub fn sk_from_label(label: &str) -> String {
    hex::encode(Sha256::digest(label.as_bytes()))
}

pub fn fail_text(r: &ExecutionFinalResult) -> String {
    let mut s = String::new();
    for f in r.failures() {
        s.push_str(&format!("{:?}\n", (*f).clone().into_result().err()));
    }
    if s.is_empty() {
        s = format!("{:?}", r.clone().into_result().err());
    }
    s
}

pub fn tgas(g: Gas) -> f64 {
    g.as_gas() as f64 / 1e12
}

#[derive(Clone)]
pub struct World {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub signer: Contract,
    pub cachet: Contract,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
}

pub struct Funding {
    pub raw_hex: String,
    pub txid: String,
    pub vout: u32,
    pub sats: u64,
}

impl World {
    pub async fn new(confirmations: u64) -> World {
        let cachet_wasm = build_wasm(".", "cachet", true);
        let signer_wasm = build_wasm("fixtures/signer", "cachet_signer_fixture", false);
        let worker = near_workspaces::sandbox().await.unwrap();
        let root = worker.root_account().unwrap();
        let signer = root.create_subaccount("signer").initial_balance(near(20)).transact().await.unwrap().unwrap();
        let signer = signer.deploy(&signer_wasm).await.unwrap().unwrap();
        signer
            .call("new")
            .args_json(json!({"sign_root": sk_from_label("cachet test sign root")}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let cachet = root.create_subaccount("cachet").initial_balance(near(30)).transact().await.unwrap().unwrap();
        let cachet = cachet.deploy(&cachet_wasm).await.unwrap().unwrap();
        cachet
            .call("new")
            .args_json(json!({"signer_id": signer.id(), "hrp": "bc", "confirmations": confirmations, "btc_light_client": signer.id()}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
        let mk = |n: &'static str| {
            let root = root.clone();
            async move { root.create_subaccount(n).initial_balance(near(100)).transact().await.unwrap().unwrap() }
        };
        let (alice, bob, carol) = (mk("alice").await, mk("bob").await, mk("carol").await);
        World { worker, root, signer, cachet, alice, bob, carol }
    }

    /// Same world with the contract's keys deleted, as it is deployed.
    pub async fn keyless(self) -> World {
        for k in self.cachet.view_access_keys().await.unwrap() {
            self.cachet.as_account().batch(self.cachet.id()).delete_key(k.public_key).transact().await.unwrap().into_result().unwrap();
        }
        assert!(self.cachet.view_access_keys().await.unwrap().is_empty());
        self
    }

    pub async fn mint(&self, who: &Account) -> String {
        let r = who.call(self.cachet.id(), "mint_note").deposit(milli(50)).max_gas().transact().await.unwrap();
        assert!(r.is_success(), "mint failed: {}", fail_text(&r));
        r.json::<Option<String>>().unwrap().expect("mint returned no token id")
    }

    pub async fn note(&self, id: &str) -> Option<Value> {
        self.worker.view(self.cachet.id(), "note").args_json(json!({"token_id": id})).await.unwrap().json().unwrap()
    }

    pub async fn state(&self, id: &str) -> String {
        self.note(id).await.map(|n| n["state"].as_str().unwrap().to_string()).unwrap_or_else(|| "burned".into())
    }

    pub async fn owner(&self, id: &str) -> Option<String> {
        let t: Option<Value> = self.worker.view(self.cachet.id(), "nft_token").args_json(json!({"token_id": id})).await.unwrap().json().unwrap();
        t.map(|t| t["owner_id"].as_str().unwrap().to_string())
    }

    pub async fn sign_log(&self) -> Vec<Value> {
        self.worker.view(self.signer.id(), "sign_log").await.unwrap().json().unwrap()
    }

    pub async fn set_mode(&self, fail: bool, wrong_hash: bool, high_s: bool, hang: bool) {
        self.signer
            .call("set_mode")
            .args_json(json!({"fail_sign": fail, "wrong_hash": wrong_hash, "high_s": high_s, "hang_sign": hang}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
    }

    /// While on, the fixture's light client parks every inclusion check unanswered.
    pub async fn set_inclusion_pending(&self, pending: bool) {
        self.signer
            .call("set_inclusion_pending")
            .args_json(json!({"pending": pending}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
    }

    pub async fn confirm(&self, txid: &str, confirmations: u64) {
        self.signer
            .call("set_tx")
            .args_json(json!({"txid": txid, "block_hash": hex::encode(Sha256::digest(txid.as_bytes())), "confirmations": confirmations}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
    }

    /// A segwit transaction paying `sats` to the note's address at output 1 (output 0 is
    /// change to an unrelated address), registered on the chain harness at `confirmations`.
    pub async fn fund(&self, id: &str, sats: u64, confirmations: u64) -> Funding {
        let n = self.note(id).await.unwrap();
        let addr = Address::from_str(n["address"].as_str().unwrap()).unwrap().assume_checked();
        let other = Address::from_str("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").unwrap().assume_checked();
        let seed = Sha256::digest(format!("funding-{id}-{sats}").as_bytes());
        let mut wit = Witness::new();
        let filler: Vec<u8> = seed.iter().cycle().take(71).copied().collect();
        wit.push(&filler);
        wit.push(&filler[..33]);
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint { txid: Txid::from_byte_array(seed.into()), vout: 0 },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: wit,
            }],
            output: vec![
                TxOut { value: Amount::from_sat(12_345), script_pubkey: other.script_pubkey() },
                TxOut { value: Amount::from_sat(sats), script_pubkey: addr.script_pubkey() },
            ],
        };
        let txid = tx.compute_txid().to_string();
        self.confirm(&txid, confirmations).await;
        Funding { raw_hex: hex::encode(serialize(&tx)), txid, vout: 1, sats }
    }

    pub async fn attest(&self, who: &Account, id: &str, f: &Funding) -> ExecutionFinalResult {
        who.call(self.cachet.id(), "attest")
            .args_json(json!({"token_id": id, "raw_tx": f.raw_hex, "vout": f.vout, "proof": inclusion_proof(&f.txid)}))
            .max_gas()
            .transact()
            .await
            .unwrap()
    }

    pub async fn finalize(&self, who: &Account, id: &str, raw: String, txid: &str) -> ExecutionFinalResult {
        who.call(self.cachet.id(), "finalize")
            .args_json(json!({"token_id": id, "sweep_raw_tx": raw, "proof": inclusion_proof(txid)}))
            .max_gas()
            .transact()
            .await
            .unwrap()
    }

    /// Mint, fund and attest a note owned by `who`.
    pub async fn sealed_note(&self, who: &Account, sats: u64) -> (String, Funding) {
        let id = self.mint(who).await;
        let f = self.fund(&id, sats, 6).await;
        let r = self.attest(who, &id, &f).await;
        assert!(r.is_success(), "attest failed: {}", fail_text(&r));
        assert_eq!(self.state(&id).await, "Sealed");
        (id, f)
    }

    pub async fn unseal(&self, who: &Account, id: &str, dest: &str, rate: u64) -> ExecutionFinalResult {
        who.call(self.cachet.id(), "unseal")
            .args_json(json!({"token_id": id, "btc_dest": dest, "fee_rate": rate}))
            .max_gas()
            .transact()
            .await
            .unwrap()
    }

    pub async fn transfer(&self, who: &Account, id: &str, to: &str) -> ExecutionFinalResult {
        who.call(self.cachet.id(), "nft_transfer")
            .args_json(json!({"receiver_id": to, "token_id": id}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await
            .unwrap()
    }
}

pub fn inclusion_proof(txid: &str) -> Value {
    json!({
        "block_hash": hex::encode(Sha256::digest(txid.as_bytes())),
        "tx_index": 1,
        "merkle_proof": ["00".repeat(32)],
        "coinbase_tx_id": "11".repeat(32),
        "coinbase_merkle_proof": ["22".repeat(32)]
    })
}

pub const DEST: &str = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

/// Checks, with the `bitcoin` crate only, that `signed_hex` is a valid P2WPKH spend of the
/// funded outpoint: correct input, destination and amount, a low-S signature that verifies
/// against the BIP143 sighash under the note's key, and the key hashes to the address.
pub fn verify_sweep(note: &Value, f: &Funding, signed_hex: &str, dest: &str, rate: u64) -> Transaction {
    let raw = hex::decode(signed_hex).unwrap();
    let tx: Transaction = deserialize(&raw).unwrap();
    assert_eq!(serialize(&tx), raw, "canonical serialization");
    assert_eq!(tx.input.len(), 1);
    assert_eq!(tx.input[0].previous_output, OutPoint { txid: Txid::from_str(&f.txid).unwrap(), vout: f.vout });
    assert_eq!(tx.output.len(), 1);
    let dest_script = Address::from_str(dest).unwrap().assume_checked().script_pubkey();
    assert_eq!(tx.output[0].script_pubkey, dest_script);
    let est = cachet::btc::sweep_vsize(dest_script.len());
    let fee = f.sats - tx.output[0].value.to_sat();
    assert_eq!(fee, rate * est, "fee is rate times the vsize estimate");
    assert!(est >= tx.vsize() as u64 && est <= tx.vsize() as u64 + 1, "estimate {} vs actual vsize {}", est, tx.vsize());
    let w = tx.input[0].witness.to_vec();
    assert_eq!(w.len(), 2);
    let (sig_bytes, hashtype) = w[0].split_at(w[0].len() - 1);
    assert_eq!(hashtype, [1], "SIGHASH_ALL");
    let sig = Signature::from_der(sig_bytes).unwrap();
    let mut low = sig;
    low.normalize_s();
    assert_eq!(sig, low, "signature must be low-S");
    let pk = PublicKey::from_slice(&w[1]).unwrap();
    assert_eq!(hex::encode(pk.serialize()), note["pubkey"].as_str().unwrap());
    let funded = Address::from_str(note["address"].as_str().unwrap()).unwrap().assume_checked();
    let pk_bitcoin = bitcoin::PublicKey::new(pk);
    assert_eq!(funded.script_pubkey(), ScriptBuf::new_p2wpkh(&pk_bitcoin.wpubkey_hash().unwrap()));
    let spk = funded.script_pubkey();
    let mut cache = SighashCache::new(&tx);
    let h = cache.p2wpkh_signature_hash(0, &spk, Amount::from_sat(f.sats), EcdsaSighashType::All).unwrap();
    Secp256k1::verification_only().verify_ecdsa(&Message::from_digest(h.to_byte_array()), &sig, &pk).expect("signature verifies");
    tx
}
