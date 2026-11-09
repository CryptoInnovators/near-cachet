//! Test harness for the `v1.signer` ABI: same method names, JSON shapes, tweak derivation
//! and Bitcoin payload hashing as near/mpc 3.17 to 3.18, but with root secrets chosen by
//! the test, so sandbox tests can verify the signatures it returns with an independent
//! secp256k1 implementation. Only the sandbox ever deploys this.

use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use k256::elliptic_curve::{sec1::ToEncodedPoint, PrimeField};
use k256::{ProjectivePoint, Scalar};
use base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::serde::Serialize;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, PanicOnDefault, Promise, PromiseOrValue};
use sha3::{Digest, Sha3_256};

#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct SignArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
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

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ChainTx {
    pub block_hash: String,
    pub confirmations: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct ProofArgsV2 {
    pub tx_id: [u8; 32],
    pub tx_block_blockhash: [u8; 32],
    pub tx_index: u64,
    pub merkle_proof: Vec<[u8; 32]>,
    pub coinbase_tx_id: [u8; 32],
    pub coinbase_merkle_proof: Vec<[u8; 32]>,
    pub confirmations: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
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
    lc_calls: u64,
    lc_last_args: String,
    fail_sign: bool,
    wrong_hash: bool,
    high_s: bool,
    hang_sign: bool,
    inclusion_pending: bool,
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

fn hex32(s: &str) -> [u8; 32] {
    hex::decode(s).expect("hex").try_into().expect("32 bytes")
}

#[near]
impl Fixture {
    #[init]
    pub fn new(sign_root: String) -> Self {
        let mut roots = LookupMap::new(b"r".to_vec());
        roots.insert(0, hex32(&sign_root));
        Self { roots, txs: LookupMap::new(b"t".to_vec()), sign_log: vec![], lc_calls: 0, lc_last_args: String::new(), fail_sign: false, wrong_hash: false, high_s: false, hang_sign: false, inclusion_pending: false }
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

    pub fn verify_transaction_inclusion_v2(&mut self, #[serializer(borsh)] args: ProofArgsV2) -> PromiseOrValue<bool> {
        self.lc_calls += 1;
        self.lc_last_args = STANDARD.encode(near_sdk::borsh::to_vec(&args).unwrap());
        if self.inclusion_pending {
            return PromiseOrValue::Promise(self.park_inclusion());
        }
        PromiseOrValue::Value(self.verify_inclusion(args))
    }

    fn park_inclusion(&self) -> Promise {
        Promise::new_yield("inclusion_timed_out", b"{}", Gas::from_tgas(0), GasWeight(1)).0
    }

    fn verify_inclusion(&self, args: ProofArgsV2) -> bool {
        let txid = hex::encode(reversed(args.tx_id));
        let tx = self.txs.get(&txid).unwrap_or_else(|| env::panic_str("block does not belong to the current main chain"));
        if hex32(&tx.block_hash) != reversed(args.tx_block_blockhash) {
            return false;
        }
        require!(tx.confirmations >= args.confirmations, "Not enough blocks confirmed");
        true
    }

    /// Resume target of a parked inclusion check nobody resumes. While pending mode is on
    /// it parks the check again, so the light client stays unanswered past the 200 block
    /// yield limit, the way a stalled Bitcoin relay does. Once pending mode is off it fails
    /// like the real client does when it gives up.
    #[private]
    pub fn inclusion_timed_out(&self) -> PromiseOrValue<bool> {
        require!(self.inclusion_pending, "fixture: inclusion check timed out");
        PromiseOrValue::Promise(self.park_inclusion())
    }

    pub fn set_inclusion_pending(&mut self, pending: bool) {
        self.inclusion_pending = pending;
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

    pub fn lc_calls(&self) -> u64 {
        self.lc_calls
    }

    pub fn lc_last_args(&self) -> String {
        self.lc_last_args.clone()
    }
}

fn reversed(mut bytes: [u8; 32]) -> [u8; 32] {
    bytes.reverse();
    bytes
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

}
