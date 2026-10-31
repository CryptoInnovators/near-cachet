//! NFT receiver with three behaviours chosen by the `msg` of `nft_transfer_call`:
//! `keep` holds the note, `return` hands it back, `unseal:<btc address>` tries to unseal it
//! from inside `nft_on_transfer` and then keeps it. `release` moves a held note onward.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseOrValue};

#[near(contract_state)]
#[derive(Default)]
pub struct Market {}

#[near]
impl Market {
    pub fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> PromiseOrValue<bool> {
        let _ = (sender_id, previous_owner_id);
        if msg == "return" {
            return PromiseOrValue::Value(true);
        }
        if let Some(dest) = msg.strip_prefix("unseal:") {
            let args = format!(r#"{{"token_id":"{token_id}","btc_dest":"{dest}","fee_rate":10}}"#);
            return PromiseOrValue::Promise(
                Promise::new(env::predecessor_account_id())
                    .function_call("unseal".to_string(), args.into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(150))
                    .then(Promise::new(env::current_account_id()).function_call("keep".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(0), Gas::from_tgas(5))),
            );
        }
        PromiseOrValue::Value(false)
    }

    #[private]
    pub fn keep(&self) -> bool {
        false
    }

    #[payable]
    pub fn release(&mut self, nft: AccountId, token_id: String, to: AccountId) -> Promise {
        Promise::new(nft).function_call(
            "nft_transfer".to_string(),
            format!(r#"{{"receiver_id":"{to}","token_id":"{token_id}"}}"#).into_bytes(),
            NearToken::from_yoctonear(1),
            Gas::from_tgas(30),
        )
    }

    pub fn ping(&self) -> U128 {
        U128(1)
    }
}
