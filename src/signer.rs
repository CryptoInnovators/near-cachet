//! Wire types for the `v1.signer` MPC contract (near/mpc `near-mpc-contract-interface`,
//! mainnet 3.17.0 and testnet 3.18.0). Shapes are pinned against the live contract in
//! docs/SPIKE.md.

use near_sdk::{ext_contract, near, AccountId};

pub const DOMAIN_SIGN: u32 = 0;
pub const DOMAIN_FOREIGN_TX: u32 = 3;
pub const PAYLOAD_VERSION_V1: u8 = 1;

#[near(serializers = [json])]
#[derive(Clone)]
pub enum Payload {
    Ecdsa(String),
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct SignArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct BitcoinRequest {
    pub tx_id: String,
    pub confirmations: u64,
    pub extractors: Vec<String>,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub enum ForeignChainRequest {
    Bitcoin(BitcoinRequest),
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct VerifyArgs {
    pub request: ForeignChainRequest,
    pub domain_id: u32,
    pub payload_version: u8,
}

#[ext_contract(ext_signer)]
pub trait Signer {
    fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u32>,
    ) -> String;
    fn sign(&mut self, request: SignArgs);
    fn verify_foreign_transaction(&mut self, request: VerifyArgs);
}

/// Subset of `VerifyForeignTransactionResponse` the note contract reads.
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct VerifyResponse {
    pub payload_hash: String,
}

#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AffinePoint {
    pub affine_point: String,
}

#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Scalar {
    pub scalar: String,
}

/// `SignatureResponse` is internally tagged on `scheme`; only Secp256k1 can sign for a
/// P2WPKH note.
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 { big_r: AffinePoint, s: Scalar, recovery_id: u8 },
    Ed25519 {},
}

/// Parses `secp256k1:<base58 of 64 bytes x||y>`, the NEAR public key string v1.signer returns.
pub fn parse_secp256k1_key(s: &str) -> Result<[u8; 64], &'static str> {
    let b58 = s.strip_prefix("secp256k1:").ok_or("not a secp256k1 key")?;
    let raw = bs58::decode(b58).into_vec().map_err(|_| "bad base58")?;
    raw.try_into().map_err(|_| "secp256k1 key must be 64 bytes")
}
