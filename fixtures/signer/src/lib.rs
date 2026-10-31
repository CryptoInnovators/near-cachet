//! Test harness for the `v1.signer` ABI: same method names, JSON shapes, tweak derivation
//! and Bitcoin payload hashing as near/mpc 3.17 to 3.18, but with root secrets chosen by
//! the test, so sandbox tests can verify the signatures it returns with an independent
//! secp256k1 implementation. Only the sandbox ever deploys this.

use k256::ecdsa::{signature::hazmat::PrehashSigner, RecoveryId, Signature, SigningKey};
use k256::elliptic_curve::{sec1::ToEncodedPoint, PrimeField};
use k256::{ProjectivePoint, Scalar};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, PanicOnDefault, Promise, PromiseOrValue};
use sha2::{Digest, Sha256};
use sha3::Sha3_256;

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub enum Payload {
    Ecdsa(String),
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SignArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BitcoinRequest {
    pub tx_id: String,
    pub confirmations: u64,
    pub extractors: Vec<String>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub enum ForeignChainRequest {
    Bitcoin(BitcoinRequest),
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct VerifyArgs {
    pub request: ForeignChainRequest,
    pub domain_id: u32,
    pub payload_version: u8,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AffinePoint {
    affine_point: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ScalarHex {
    scalar: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 { big_r: AffinePoint, s: ScalarHex, recovery_id: u8 },
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct VerifyResponse {
    payload_hash: String,
    signature: SignatureResponse,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct ChainTx {
    pub block_hash: String,
    pub confirmations: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct SignCall {
    pub predecessor: AccountId,
    pub path: String,
    pub payload: String,
    pub domain_id: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Fixture {
    roots: LookupMap<u32, [u8; 32]>,
    txs: LookupMap<String, ChainTx>,
    sign_log: Vec<SignCall>,
    verify_calls: u64,
    fail_sign: bool,
    wrong_hash: bool,
    high_s: bool,
    hang_sign: bool,
}

fn scalar(b: &[u8; 32]) -> Scalar {
    Scalar::from_repr((*b).into()).into_option().expect("scalar out of range")
}

fn tweak(predecessor: &AccountId, path: &str) -> Scalar {
    let prefix = "near-mpc-recovery v0.1.0 epsilon derivation:";
    let mut h = Sha3_256::new();
    h.update(format!("{prefix}{predecessor},{path}").as_bytes());
    let out: [u8; 32] = h.finalize().into();
    scalar(&out)
}

fn near_key(sk: &Scalar) -> String {
    let pt = (ProjectivePoint::GENERATOR * sk).to_affine();
    let enc = pt.to_encoded_point(false);
    format!("secp256k1:{}", bs58::encode(&enc.as_bytes()[1..]).into_string())
}

fn respond(sk: &Scalar, hash: &[u8; 32], high_s: bool) -> SignatureResponse {
    let key = SigningKey::from_bytes(&sk.to_bytes()).unwrap();
    let (sig, rid): (Signature, RecoveryId) = key.sign_prehash_recoverable(hash).unwrap();
    let (r, s) = sig.split_scalars();
    let (s, mut v) = (*s, rid.to_byte());
    let s = if high_s {
        v ^= 1;
        -s
    } else {
        s
    };
    let mut point = [0u8; 33];
    point[0] = 2 + (v & 1);
    point[1..].copy_from_slice(&r.to_bytes());
    SignatureResponse::Secp256k1 {
        big_r: AffinePoint { affine_point: hex::encode(point) },
        s: ScalarHex { scalar: hex::encode(s.to_bytes()) },
        recovery_id: v,
    }
}

/// Borsh of `ForeignTxSignPayload::V1 { request: Bitcoin(..), values: [BlockHash] }`, the
/// layout near/mpc hashes in `compute_msg_hash`.
pub fn bitcoin_payload_hash(tx_id: &[u8; 32], confirmations: u64, block_hash: &[u8; 32]) -> [u8; 32] {
    let mut b = vec![0u8]; // ForeignTxSignPayload::V1
    b.push(3); // ForeignChainRpcRequest::Bitcoin
    b.extend_from_slice(tx_id);
    b.extend_from_slice(&confirmations.to_le_bytes());
    b.extend_from_slice(&1u32.to_le_bytes()); // extractors.len
    b.push(0); // BitcoinExtractor::BlockHash
    b.extend_from_slice(&1u32.to_le_bytes()); // values.len
    b.push(0); // ExtractedValue::BitcoinExtractedValue
    b.push(0); // BitcoinExtractedValue::BlockHash
    b.extend_from_slice(block_hash);
    Sha256::digest(&b).into()
}

fn hex32(s: &str) -> [u8; 32] {
    hex::decode(s).expect("hex").try_into().expect("32 bytes")
}

#[near]
impl Fixture {
    #[init]
    pub fn new(sign_root: String, foreign_root: String) -> Self {
        let mut roots = LookupMap::new(b"r".to_vec());
        roots.insert(0, hex32(&sign_root));
        roots.insert(3, hex32(&foreign_root));
        Self { roots, txs: LookupMap::new(b"t".to_vec()), sign_log: vec![], verify_calls: 0, fail_sign: false, wrong_hash: false, high_s: false, hang_sign: false }
    }

    pub fn derived_public_key(&self, path: String, predecessor: Option<AccountId>, domain_id: Option<u32>) -> String {
        let pred = predecessor.unwrap_or_else(env::predecessor_account_id);
        let root = scalar(self.roots.get(&domain_id.unwrap_or(0)).expect("unknown domain"));
        near_key(&(root + tweak(&pred, &path)))
    }

    pub fn domain_public_key(&self, domain_id: u32) -> String {
        near_key(&scalar(self.roots.get(&domain_id).expect("unknown domain")))
    }

    #[payable]
    pub fn sign(&mut self, request: SignArgs) -> PromiseOrValue<SignatureResponse> {
        require!(env::attached_deposit().as_yoctonear() >= 1, "deposit at least 1 yocto");
        require!(env::prepaid_gas().as_tgas() >= 15, "attach at least 15 Tgas");
        let Payload::Ecdsa(p) = request.payload_v2;
        let caller = env::predecessor_account_id();
        self.sign_log.push(SignCall { predecessor: caller.clone(), path: request.path.clone(), payload: p.clone(), domain_id: request.domain_id });
        require!(!self.fail_sign, "fixture: signing disabled");
        if self.hang_sign {
            let (p, _) = Promise::new_yield("sign_timed_out", b"{}", Gas::from_tgas(5), GasWeight(0));
            return PromiseOrValue::Promise(p);
        }
        let hash = if self.wrong_hash { [0x42u8; 32] } else { hex32(&p) };
        let root = scalar(self.roots.get(&request.domain_id).expect("unknown domain"));
        PromiseOrValue::Value(respond(&(root + tweak(&caller, &request.path)), &hash, self.high_s))
    }

    /// Resume target of a yield nobody resumes: the runtime calls it after 200 blocks, which
    /// is how the real signer fails a request its MPC nodes never answer.
    #[private]
    pub fn sign_timed_out(&self) -> SignatureResponse {
        env::panic_str("fixture: yield timed out")
    }

    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: VerifyArgs) -> VerifyResponse {
        require!(env::attached_deposit().as_yoctonear() >= 1, "deposit at least 1 yocto");
        require!(env::prepaid_gas().as_tgas() >= 15, "attach at least 15 Tgas");
        require!(request.domain_id == 3 && request.payload_version == 1, "fixture: domain 3 payload v1 only");
        let ForeignChainRequest::Bitcoin(r) = request.request;
        require!(r.extractors == ["BlockHash"], "fixture: BlockHash extractor only");
        let tx = self.txs.get(&r.tx_id).cloned().unwrap_or_else(|| env::panic_str("TransactionNotFound"));
        require!(tx.confirmations >= r.confirmations, "NotEnoughBlockConfirmations");
        self.verify_calls += 1;
        let ph = bitcoin_payload_hash(&hex32(&r.tx_id), r.confirmations, &hex32(&tx.block_hash));
        let root = scalar(self.roots.get(&3).unwrap());
        VerifyResponse { payload_hash: hex::encode(ph), signature: respond(&root, &ph, false) }
    }

    pub fn set_tx(&mut self, txid: String, block_hash: String, confirmations: u64) {
        self.txs.insert(txid, ChainTx { block_hash, confirmations });
    }

    pub fn set_mode(&mut self, fail_sign: bool, wrong_hash: bool, high_s: bool, hang_sign: bool) {
        self.hang_sign = hang_sign;
        self.fail_sign = fail_sign;
        self.wrong_hash = wrong_hash;
        self.high_s = high_s;
    }

    pub fn sign_log(&self) -> Vec<SignCall> {
        self.sign_log.clone()
    }

    pub fn verify_calls(&self) -> u64 {
        self.verify_calls
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::sec1::FromEncodedPoint;
    use k256::{AffinePoint, EncodedPoint};

    fn parse_key(s: &str) -> ProjectivePoint {
        let raw = bs58::decode(s.strip_prefix("secp256k1:").unwrap()).into_vec().unwrap();
        let mut sec1 = vec![4u8];
        sec1.extend(raw);
        let ep = EncodedPoint::from_bytes(&sec1).unwrap();
        ProjectivePoint::from(AffinePoint::from_encoded_point(&ep).unwrap())
    }

    /// The live testnet `v1.signer-prod.testnet` domain 0 root key and the derived key it
    /// returned for predecessor `cachet.testnet`, path `cachet/1/0`, both read with
    /// `query call_function` (see docs/SPIKE.md for block and command).
    const LIVE_ROOT: &str = "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";
    const LIVE_DERIVED: &str = "secp256k1:2QpWzNkfX6Chb8KuJhbRWCYBtmDj83227DyKnSKUVgwivw5bh4voFJWEdbbNcKuitpdpMsCcxnxdUbt8Xugoh993";

    fn derive(root: &str, pred: &str, path: &str) -> String {
        let t = tweak(&pred.parse().unwrap(), path);
        let pt = (ProjectivePoint::GENERATOR * t + parse_key(root)).to_affine();
        let enc = pt.to_encoded_point(false);
        format!("secp256k1:{}", bs58::encode(&enc.as_bytes()[1..]).into_string())
    }

    #[test]
    fn tweak_and_point_math_reproduce_the_live_testnet_derived_key() {
        assert_eq!(derive(LIVE_ROOT, "cachet.testnet", "cachet/1/0"), LIVE_DERIVED);
    }

    #[test]
    fn a_different_path_derives_a_different_key() {
        assert_ne!(derive(LIVE_ROOT, "cachet.testnet", "cachet/2/0"), LIVE_DERIVED);
        assert_ne!(derive(LIVE_ROOT, "other.testnet", "cachet/1/0"), LIVE_DERIVED);
    }

    #[test]
    fn bitcoin_payload_hash_reproduces_the_live_mainnet_attestation() {
        // mainnet tx EFq8tUeeSMVCATrkbmyWs5VrtgM4nrFjUaTgC2RwJSDQ: Bitcoin tx 58ee37.. at
        // 1 confirmation in block 00000000000000000001fadaf3f8591e071c202762193cf78e389ea691f2ecab,
        // response payload_hash 67d5b3ab8340bd07bf8d17a44d7b8080aba42449ce5fc272c4378eadd25220ba
        let txid: [u8; 32] = hex::decode("58ee376171bcc4e2cc040c13848d420b5eaf2f634872055b0a08c1fc2ec6453c").unwrap().try_into().unwrap();
        let block: [u8; 32] = hex::decode("00000000000000000001fadaf3f8591e071c202762193cf78e389ea691f2ecab").unwrap().try_into().unwrap();
        assert_eq!(hex::encode(bitcoin_payload_hash(&txid, 1, &block)), "67d5b3ab8340bd07bf8d17a44d7b8080aba42449ce5fc272c4378eadd25220ba");
        assert_ne!(hex::encode(bitcoin_payload_hash(&txid, 2, &block)), "67d5b3ab8340bd07bf8d17a44d7b8080aba42449ce5fc272c4378eadd25220ba");
    }
}
