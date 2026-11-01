//! Throwaway spike: forwards raw calls to a chain-signatures contract with this contract
//! as the predecessor, so the testnet probe measures what a contract caller sees.
use near_sdk::{near, AccountId, Gas, NearToken, Promise};

#[near(contract_state)]
#[derive(Default)]
pub struct Probe {}

#[near]
impl Probe {
    pub fn derive(&self, signer: AccountId, path: String) -> Promise {
        let args = format!(r#"{{"path":"{path}","predecessor":"{}","domain_id":0}}"#, near_sdk::env::current_account_id());
        Promise::new(signer).function_call("derived_public_key", args.into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10))
    }

    #[payable]
    pub fn sign(&mut self, signer: AccountId, path: String, payload_hex: String) -> Promise {
        let args = format!(r#"{{"request":{{"path":"{path}","payload_v2":{{"Ecdsa":"{payload_hex}"}},"domain_id":0}}}}"#);
        Promise::new(signer).function_call("sign", args.into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(250))
    }

    #[payable]
    pub fn verify(&mut self, signer: AccountId, request_json: String) -> Promise {
        let args = format!(r#"{{"request":{request_json}}}"#);
        Promise::new(signer).function_call("verify_foreign_transaction", args.into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(250))
    }

    pub fn lc_verify(&self, light_client: AccountId, args: Vec<u8>) -> Promise {
        Promise::new(light_client).function_call("verify_transaction_inclusion_v2", args, NearToken::from_yoctonear(0), Gas::from_tgas(30))
    }
}
