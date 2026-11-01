use crate::btc;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

pub const MAX_BRANCH: usize = 24;
pub const GAS_LC: Gas = Gas::from_tgas(30);

#[near(serializers = [json])]
#[derive(Clone)]
pub struct InclusionProof {
    pub block_hash: String,
    pub tx_index: u64,
    pub merkle_proof: Vec<String>,
    pub coinbase_tx_id: String,
    pub coinbase_merkle_proof: Vec<String>,
}

#[near(serializers = [borsh])]
pub struct ProofArgsV2 {
    pub tx_id: [u8; 32],
    pub tx_block_blockhash: [u8; 32],
    pub tx_index: u64,
    pub merkle_proof: Vec<[u8; 32]>,
    pub coinbase_tx_id: [u8; 32],
    pub coinbase_merkle_proof: Vec<[u8; 32]>,
    pub confirmations: u64,
}

fn internal(hex: &str) -> Result<[u8; 32], &'static str> {
    btc::hex_32(hex).map(btc::reversed)
}

pub fn proof_args_v2(txid: [u8; 32], proof: &InclusionProof, confirmations: u64) -> Result<Vec<u8>, &'static str> {
    if proof.merkle_proof.len() != proof.coinbase_merkle_proof.len() {
        return Err("branch lengths differ");
    }
    if !(1..=MAX_BRANCH).contains(&proof.merkle_proof.len()) {
        return Err("branch length out of range");
    }
    let args = ProofArgsV2 {
        tx_id: txid,
        tx_block_blockhash: internal(&proof.block_hash)?,
        tx_index: proof.tx_index,
        merkle_proof: proof.merkle_proof.iter().map(|h| internal(h)).collect::<Result<_, _>>()?,
        coinbase_tx_id: internal(&proof.coinbase_tx_id)?,
        coinbase_merkle_proof: proof.coinbase_merkle_proof.iter().map(|h| internal(h)).collect::<Result<_, _>>()?,
        confirmations,
    };
    near_sdk::borsh::to_vec(&args).map_err(|_| "could not serialize inclusion proof")
}

pub fn verify(light_client: AccountId, args: Vec<u8>) -> Promise {
    Promise::new(light_client).function_call(
        "verify_transaction_inclusion_v2",
        args,
        NearToken::from_yoctonear(0),
        GAS_LC,
    )
}

pub fn included(index: u64) -> bool {
    env::promise_result_checked(index, 16)
        .ok()
        .and_then(|bytes| near_sdk::serde_json::from_slice::<bool>(&bytes).ok())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{proof_args_v2, InclusionProof, MAX_BRANCH};
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn proof_args_v2_matches_live_vector() {
        let vector: serde_json::Value = serde_json::from_str(include_str!("../tests/vectors/lc_mainnet_974135.json")).unwrap();
        let proof: InclusionProof = near_sdk::serde_json::from_value(serde_json::json!({
            "block_hash": vector["block_hash"],
            "tx_index": vector["tx_index"],
            "merkle_proof": vector["merkle_proof"],
            "coinbase_tx_id": vector["coinbase_tx_id"],
            "coinbase_merkle_proof": vector["coinbase_merkle_proof"]
        })).unwrap();
        let txid = crate::btc::reversed(crate::btc::hex_32(vector["txid"].as_str().unwrap()).unwrap());
        let bytes = proof_args_v2(txid, &proof, vector["confirmations"].as_u64().unwrap()).unwrap();
        assert_eq!(STANDARD.encode(bytes), vector["args_base64"].as_str().unwrap());
    }

    #[test]
    fn proof_args_v2_refuses_mismatched_branches() {
        let proof = InclusionProof { block_hash: "00".repeat(32), tx_index: 0, merkle_proof: vec!["00".repeat(32)], coinbase_tx_id: "00".repeat(32), coinbase_merkle_proof: vec![] };
        assert_eq!(proof_args_v2([0; 32], &proof, 1).unwrap_err(), "branch lengths differ");
    }

    #[test]
    fn proof_args_v2_refuses_empty_and_oversized_branches() {
        let mut proof = InclusionProof { block_hash: "00".repeat(32), tx_index: 0, merkle_proof: vec![], coinbase_tx_id: "00".repeat(32), coinbase_merkle_proof: vec![] };
        assert_eq!(proof_args_v2([0; 32], &proof, 1).unwrap_err(), "branch length out of range");
        proof.merkle_proof = vec!["00".repeat(32); MAX_BRANCH + 1];
        proof.coinbase_merkle_proof = proof.merkle_proof.clone();
        assert_eq!(proof_args_v2([0; 32], &proof, 1).unwrap_err(), "branch length out of range");
    }
}
