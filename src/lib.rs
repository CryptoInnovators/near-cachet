//! Cachet: sealed bitcoin notes as NEP-171 NFTs.
//!
//! Each note owns a native P2WPKH address derived from the NEAR MPC network
//! (`v1.signer`, path `cachet/<token>/<slot>`). The contract holds no key and exposes no
//! method that reaches `sign` except `unseal` and `resign`, which only the note owner can
//! call on an attested, unspent slot.

pub mod btc;
pub mod light_client;
pub mod signer;

use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::{NftBurn, NftMint, NftTransfer};
use near_contract_standards::non_fungible_token::refund_approved_account_ids;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};
use std::collections::HashMap;

use signer::{ext_signer, Payload, SignArgs, SignatureResponse, DOMAIN_SIGN};

const GAS_DERIVE: Gas = Gas::from_tgas(10);
const GAS_MINT_CALLBACK: Gas = Gas::from_tgas(25);
const GAS_SIGNER: Gas = Gas::from_tgas(100);
const GAS_CALLBACK: Gas = Gas::from_tgas(30);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MIN_MINT_DEPOSIT: NearToken = NearToken::from_millinear(20);
const MAX_PROMISE_RESULT: usize = 4096;
/// Smallest funding output a note accepts: dust floor plus a 1 sat/vB sweep.
pub const MIN_NOTE_SATS: u64 = 1_000;
/// Smallest output a sweep may create (above dust for P2WPKH, P2WSH and P2TR).
pub const MIN_SWEEP_OUTPUT: u64 = 546;
/// About one hour of NEAR blocks.
pub const MIN_CLAIM_BLOCKS: u64 = 3_600;
pub const MAX_CLAIM_BLOCKS: u64 = 3_000_000;
/// The signer drops a yielded request after 200 blocks; recovery waits twice that.
pub const RECOVER_AFTER_BLOCKS: u64 = 400;
/// Bytes a note can still add after mint: the attested UTXO (76), a 34-byte destination
/// script and a 72-byte DER signature.
const LATE_GROWTH_BYTES: u64 = 76 + 34 + 72;
/// Bytes a transfer to a new owner can add: a 64-byte owner id replacing a shorter one in
/// `owner_by_id`, plus a fresh per-owner token set keyed by a 64-byte account id (measured
/// at 144 bytes for a 13-byte id).
const OWNER_CHURN_BYTES: u64 = 64 + 200;
/// Charged on top of the bytes a mint writes, so no later callback can run the contract's
/// balance below its storage stake.
pub const NOTE_STORAGE_RESERVE_BYTES: u64 = LATE_GROWTH_BYTES + OWNER_CHURN_BYTES;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    OwnerById,
    TokenMetadata,
    Enumeration,
    Approval,
    ContractMetadata,
    Notes,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    /// Address derived, no funding attested.
    Minted,
    Attesting,
    /// Funding attested, bitcoin locked by the contract.
    Sealed,
    Unsealing,
    /// Sweep signed, note frozen until the sweep is attested.
    Unsealed,
    Resigning,
    Finalizing,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Utxo {
    /// Internal (hash) byte order.
    pub txid: [u8; 32],
    pub vout: u32,
    pub sats: u64,
    pub block_hash: [u8; 32],
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Note {
    pub slot: u32,
    pub pubkey: [u8; 64],
    pub address: String,
    pub state: State,
    pub utxo: Option<Utxo>,
    pub dest_script: Vec<u8>,
    pub fee: u64,
    pub signature: Vec<u8>,
    pub pending_fee: u64,
    pub pending_sighash: [u8; 32],
    pub claim_key: Option<[u8; 32]>,
    pub claim_expiry: u64,
    pub in_transfer: bool,
    pub pending_since: u64,
}

impl Note {
    fn pubkey33(&self) -> [u8; 33] {
        btc::compress_pubkey(&self.pubkey)
    }

    fn claim_locked(&self) -> bool {
        self.claim_key.is_some() && env::block_height() < self.claim_expiry
    }

    fn sweep(&self, fee: u64) -> btc::Sweep {
        let u = self.utxo.as_ref().unwrap_or_else(|| env::panic_str("note has no attested funding"));
        btc::Sweep {
            prev_txid: u.txid,
            vout: u.vout,
            amount: u.sats,
            pubkey: self.pubkey33(),
            dest_script: self.dest_script.clone(),
            fee,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SignOp {
    Unseal,
    Resign,
}

/// Proof that `authorize_sign` approved a signature request. It has no public
/// constructor, so `request_signature` cannot be reached without passing the checks.
pub struct SignPermit(());

/// The single gate in front of `v1.signer.sign`.
pub fn authorize_sign(
    op: SignOp,
    state: State,
    caller_is_owner: bool,
    in_transfer: bool,
    claim_locked: bool,
) -> Result<SignPermit, &'static str> {
    if !caller_is_owner {
        return Err("only the note owner can request a signature");
    }
    if in_transfer {
        return Err("note is mid-transfer");
    }
    match (op, state) {
        (SignOp::Unseal, State::Sealed) if claim_locked => Err("claim link is active"),
        (SignOp::Unseal, State::Sealed) | (SignOp::Resign, State::Unsealed) => Ok(SignPermit(())),
        (SignOp::Unseal, _) => Err("note is not sealed with attested funding"),
        (SignOp::Resign, _) => Err("note is not unsealed"),
    }
}

#[near(serializers = [json])]
pub struct UtxoView {
    pub txid: String,
    pub vout: u32,
    pub sats: u64,
    pub block_hash: String,
}

#[near(serializers = [json])]
pub struct SweepView {
    pub destination_script: String,
    pub fee_sats: u64,
    pub signed_tx: Option<String>,
}

#[near(serializers = [json])]
pub struct ClaimView {
    pub key: String,
    pub expires_at_block: u64,
    pub locked: bool,
}

#[near(serializers = [json])]
pub struct NoteView {
    pub token_id: String,
    pub owner_id: AccountId,
    pub state: State,
    pub path: String,
    pub address: String,
    pub pubkey: String,
    pub utxo: Option<UtxoView>,
    pub sweep: Option<SweepView>,
    pub claim: Option<ClaimView>,
    pub in_transfer: bool,
    pub pending_since: u64,
}

#[near(serializers = [json])]
pub struct Config {
    pub signer_id: AccountId,
    pub hrp: String,
    pub confirmations: u64,
    pub btc_light_client: AccountId,
}

fn path_of(token_id: &str, slot: u32) -> String {
    format!("cachet/{token_id}/{slot}")
}

fn panic_msg(m: &str) -> ! {
    env::panic_str(m)
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Cachet {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    notes: LookupMap<TokenId, Note>,
    next_id: u64,
    signer_id: AccountId,
    btc_light_client: AccountId,
    hrp: String,
    confirmations: u64,
}

#[near]
impl Cachet {
    /// The contract has no owner and no setters: these network trust roots are final.
    #[init]
    pub fn new(signer_id: AccountId, hrp: String, confirmations: u64, btc_light_client: AccountId) -> Self {
        require!(matches!(hrp.as_str(), "bc" | "tb" | "bcrt"), "hrp must be bc, tb or bcrt");
        require!((1..=100).contains(&confirmations), "confirmations must be 1 to 100");
        let me = env::current_account_id();
        Self {
            tokens: NonFungibleToken::new(
                Key::OwnerById,
                me,
                Some(Key::TokenMetadata),
                Some(Key::Enumeration),
                Some(Key::Approval),
            ),
            metadata: LazyOption::new(
                Key::ContractMetadata,
                Some(&NFTContractMetadata {
                    spec: NFT_METADATA_SPEC.to_string(),
                    name: "Cachet".to_string(),
                    symbol: "CACHET".to_string(),
                    icon: None,
                    base_uri: None,
                    reference: None,
                    reference_hash: None,
                }),
            ),
            notes: LookupMap::new(Key::Notes),
            next_id: 1,
            signer_id,
            btc_light_client,
            hrp,
            confirmations,
        }
    }

    // ---- views ----

    pub fn config(&self) -> Config {
        Config {
            signer_id: self.signer_id.clone(),
            hrp: self.hrp.clone(),
            confirmations: self.confirmations,
            btc_light_client: self.btc_light_client.clone(),
        }
    }

    pub fn note(&self, token_id: TokenId) -> Option<NoteView> {
        let note = self.notes.get(&token_id)?;
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        Some(Self::view(&token_id, owner_id, note))
    }

    pub fn signed_sweep_tx(&self, token_id: TokenId) -> Option<String> {
        let note = self.notes.get(&token_id)?;
        Self::signed_tx_hex(note)
    }

    // ---- mint ----

    /// Derives a fresh P2WPKH address for a new note owned by the caller. The attached
    /// deposit pays storage and the remainder is refunded.
    #[payable]
    pub fn mint_note(&mut self) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_MINT_DEPOSIT, "attach at least 0.02 NEAR for storage");
        let owner = env::predecessor_account_id();
        let token_id = self.next_id.to_string();
        self.next_id += 1;
        ext_signer::ext(self.signer_id.clone())
            .with_static_gas(GAS_DERIVE)
            .derived_public_key(path_of(&token_id, 0), Some(env::current_account_id()), Some(DOMAIN_SIGN))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_MINT_CALLBACK)
                    .on_derived(token_id, owner, U128(deposit.as_yoctonear())),
            )
    }

    #[private]
    pub fn on_derived(&mut self, token_id: TokenId, owner_id: AccountId, deposit: U128) -> Option<TokenId> {
        let key = env::promise_result_checked(0, MAX_PROMISE_RESULT)
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<String>(&b).ok())
            .and_then(|s| signer::parse_secp256k1_key(&s).ok());
        let Some(pubkey) = key else {
            Self::refund(&owner_id, deposit.0);
            return None;
        };
        let address = btc::p2wpkh_address(&self.hrp, &btc::compress_pubkey(&pubkey));
        let before = env::storage_usage();
        self.tokens.internal_mint_with_refund(
            token_id.clone(),
            owner_id.clone(),
            Some(TokenMetadata {
                title: Some(format!("Cachet note #{token_id}")),
                description: Some(format!("Sealed bitcoin note at {address}")),
                media: None,
                media_hash: None,
                copies: None,
                issued_at: None,
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: None,
                reference: None,
                reference_hash: None,
            }),
            None,
        );
        self.notes.insert(
            token_id.clone(),
            Note {
                slot: 0,
                pubkey,
                address,
                state: State::Minted,
                utxo: None,
                dest_script: vec![],
                fee: 0,
                signature: vec![],
                pending_fee: 0,
                pending_sighash: [0; 32],
                claim_key: None,
                claim_expiry: 0,
                in_transfer: false,
                pending_since: 0,
            },
        );
        // `store::LookupMap` writes lazily; without the flush the note record is not in `used`.
        self.notes.flush();
        let used = env::storage_usage().saturating_sub(before) as u128 + NOTE_STORAGE_RESERVE_BYTES as u128;
        let cost = used * env::storage_byte_cost().as_yoctonear();
        if cost > deposit.0 {
            self.burn(&token_id);
            Self::refund(&owner_id, deposit.0);
            return None;
        }
        NftMint { owner_id: &owner_id, token_ids: &[token_id.as_str()], memo: None }.emit();
        Self::refund(&owner_id, deposit.0 - cost);
        Some(token_id)
    }

    // ---- attest ----

    /// Binds a Bitcoin funding output to the note. `raw_tx` is the funding transaction in
    /// hex; the contract checks that output `vout` pays this note's address, reads the
    /// amount from the bytes, and asks the Bitcoin light client to verify its inclusion.
    pub fn attest(&mut self, token_id: TokenId, raw_tx: String, vout: u32, proof: light_client::InclusionProof) -> Promise {
        let mut note = self.owned_idle(&token_id);
        require!(note.state == State::Minted, "note is not awaiting funding");
        let raw = btc::hex_decode(&raw_tx).unwrap_or_else(|e| panic_msg(e));
        let tx = btc::parse_tx(&raw).unwrap_or_else(|e| panic_msg(e));
        let out = tx.outputs.get(vout as usize).unwrap_or_else(|| panic_msg("vout out of range"));
        require!(out.script == btc::p2wpkh_script(&note.pubkey33()), "output does not pay this note");
        require!(out.value >= MIN_NOTE_SATS, "funding below 1000 sats");
        let sats = out.value;
        let args = light_client::proof_args_v2(tx.txid, &proof, self.confirmations).unwrap_or_else(|e| panic_msg(e));
        note.state = State::Attesting;
        note.pending_since = env::block_height();
        self.notes.insert(token_id.clone(), note);
        light_client::verify(self.btc_light_client.clone(), args).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_attest(
                token_id,
                btc::hex_encode(&tx.txid_display()),
                vout,
                sats,
                proof.block_hash,
            ),
        )
    }

    #[private]
    pub fn on_attest(&mut self, token_id: TokenId, txid: String, vout: u32, sats: u64, block_hash: String) -> bool {
        let Some(mut note) = self.notes.get(&token_id).cloned() else { return false };
        if note.state != State::Attesting {
            return false;
        }
        let included = light_client::included(0);
        let txid = btc::hex_32(&txid).map(btc::reversed);
        let block_hash = btc::hex_32(&block_hash).map(btc::reversed);
        match (included, txid, block_hash) {
            (true, Ok(txid), Ok(block_hash)) => {
                note.utxo = Some(Utxo { txid, vout, sats, block_hash });
                note.state = State::Sealed;
            }
            _ => note.state = State::Minted,
        }
        let sealed = note.state == State::Sealed;
        self.notes.insert(token_id, note);
        sealed
    }

    // ---- unseal ----

    /// Owner only. Signs the one-input sweep of the attested UTXO to `btc_dest` through
    /// chain signatures. The note is frozen afterwards.
    pub fn unseal(&mut self, token_id: TokenId, btc_dest: String, fee_rate: u64) -> Promise {
        let mut note = self.notes.get(&token_id).cloned().unwrap_or_else(|| panic_msg("unknown note"));
        let permit = authorize_sign(
            SignOp::Unseal,
            note.state,
            self.owner_of(&token_id) == env::predecessor_account_id(),
            note.in_transfer,
            note.claim_locked(),
        )
        .unwrap_or_else(|e| panic_msg(e));
        let dest = btc::address_to_script(&self.hrp, &btc_dest).unwrap_or_else(|e| panic_msg(e));
        let fee = btc::sweep_fee(fee_rate, dest.len()).unwrap_or_else(|e| panic_msg(e));
        let sats = note.utxo.as_ref().map(|u| u.sats).unwrap_or(0);
        require!(sats >= fee + MIN_SWEEP_OUTPUT, "fee leaves the sweep below dust");
        note.claim_key = None;
        note.dest_script = dest;
        note.pending_fee = fee;
        note.pending_sighash = note.sweep(fee).sighash();
        note.state = State::Unsealing;
        note.pending_since = env::block_height();
        let sighash = note.pending_sighash;
        let path = path_of(&token_id, note.slot);
        self.notes.insert(token_id.clone(), note);
        self.request_signature(permit, path, sighash)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_signed(token_id, false))
    }

    /// Owner only, after `unseal`. Signs the same sweep, to the same destination, at a new
    /// fee rate (replace-by-fee).
    pub fn resign(&mut self, token_id: TokenId, fee_rate: u64) -> Promise {
        let mut note = self.notes.get(&token_id).cloned().unwrap_or_else(|| panic_msg("unknown note"));
        let permit = authorize_sign(
            SignOp::Resign,
            note.state,
            self.owner_of(&token_id) == env::predecessor_account_id(),
            note.in_transfer,
            false,
        )
        .unwrap_or_else(|e| panic_msg(e));
        let fee = btc::sweep_fee(fee_rate, note.dest_script.len()).unwrap_or_else(|e| panic_msg(e));
        let sats = note.utxo.as_ref().map(|u| u.sats).unwrap_or(0);
        require!(sats >= fee + MIN_SWEEP_OUTPUT, "fee leaves the sweep below dust");
        note.pending_fee = fee;
        note.pending_sighash = note.sweep(fee).sighash();
        note.state = State::Resigning;
        note.pending_since = env::block_height();
        let sighash = note.pending_sighash;
        let path = path_of(&token_id, note.slot);
        self.notes.insert(token_id.clone(), note);
        self.request_signature(permit, path, sighash)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_signed(token_id, true))
    }

    #[private]
    pub fn on_signed(&mut self, token_id: TokenId, resign: bool) -> bool {
        let Some(mut note) = self.notes.get(&token_id).cloned() else { return false };
        let (pending, prior) = if resign { (State::Resigning, State::Unsealed) } else { (State::Unsealing, State::Sealed) };
        if note.state != pending {
            return false;
        }
        let der = env::promise_result_checked(0, MAX_PROMISE_RESULT)
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<SignatureResponse>(&b).ok())
            .and_then(|r| Self::signature_for(&note, r));
        match der {
            Some(der) => {
                note.signature = der;
                note.fee = note.pending_fee;
                note.state = State::Unsealed;
            }
            None => {
                note.state = prior;
                if !resign {
                    note.dest_script.clear();
                }
            }
        }
        let ok = note.state == State::Unsealed;
        self.notes.insert(token_id, note);
        ok
    }

    // ---- finalize ----

    /// Anyone. Proves that a confirmed Bitcoin transaction spent the note's UTXO to the
    /// unseal destination, then burns the note.
    pub fn finalize(&mut self, token_id: TokenId, sweep_raw_tx: String, proof: light_client::InclusionProof) -> Promise {
        let mut note = self.notes.get(&token_id).cloned().unwrap_or_else(|| panic_msg("unknown note"));
        require!(note.state == State::Unsealed && !note.in_transfer, "note is not unsealed");
        let raw = btc::hex_decode(&sweep_raw_tx).unwrap_or_else(|e| panic_msg(e));
        let tx = btc::parse_tx(&raw).unwrap_or_else(|e| panic_msg(e));
        let u = note.utxo.clone().unwrap_or_else(|| panic_msg("note has no attested funding"));
        require!(
            tx.inputs.iter().any(|i| i.prev_txid == u.txid && i.vout == u.vout),
            "transaction does not spend this note"
        );
        require!(tx.outputs.iter().any(|o| o.script == note.dest_script), "transaction does not pay the unseal destination");
        let args = light_client::proof_args_v2(tx.txid, &proof, self.confirmations).unwrap_or_else(|e| panic_msg(e));
        note.state = State::Finalizing;
        note.pending_since = env::block_height();
        self.notes.insert(token_id.clone(), note);
        light_client::verify(self.btc_light_client.clone(), args)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_finalized(token_id))
    }

    #[private]
    pub fn on_finalized(&mut self, token_id: TokenId) -> bool {
        let Some(mut note) = self.notes.get(&token_id).cloned() else { return false };
        if note.state != State::Finalizing {
            return false;
        }
        if light_client::included(0) {
            self.burn(&token_id);
            true
        } else {
            note.state = State::Unsealed;
            self.notes.insert(token_id, note);
            false
        }
    }

    /// Owner only. Returns a note stuck in an in-flight state once the
    /// signer's own request timeout has certainly passed: attesting goes back to Minted,
    /// signing and finalizing states go to Unsealed.
    pub fn recover(&mut self, token_id: TokenId) {
        let mut note = self.owned_idle(&token_id);
        let prior = match note.state {
            State::Attesting => State::Minted,
            // The signer may have signed even though `on_signed` never committed, and its
            // result is public in the signer's receipt. The unseal destination stays bound
            // and the note stays frozen: `resign` stores a signature, `finalize` burns it.
            State::Unsealing | State::Resigning | State::Finalizing => State::Unsealed,
            _ => panic_msg("note is not mid-request"),
        };
        require!(
            env::block_height() >= note.pending_since + RECOVER_AFTER_BLOCKS,
            "request may still be pending"
        );
        note.state = prior;
        self.notes.insert(token_id, note);
    }

    // ---- gift by link ----

    /// Owner only. Registers an ed25519 public key (32 bytes, hex). Whoever signs
    /// `cachet-claim:<contract>:<token>:<new owner>` with the matching secret can move the
    /// note. Until `expires_at_block` the owner can neither transfer, unseal nor cancel.
    pub fn create_claim(&mut self, token_id: TokenId, claim_key: String, expires_at_block: u64) {
        let mut note = self.owned_idle(&token_id);
        require!(matches!(note.state, State::Minted | State::Sealed), "note cannot be gifted in this state");
        require!(note.claim_key.is_none(), "a claim link already exists");
        let key = btc::hex_32(&claim_key).unwrap_or_else(|e| panic_msg(e));
        let now = env::block_height();
        require!(
            expires_at_block >= now + MIN_CLAIM_BLOCKS && expires_at_block <= now + MAX_CLAIM_BLOCKS,
            "expiry must be 3600 to 3000000 blocks ahead"
        );
        note.claim_key = Some(key);
        note.claim_expiry = expires_at_block;
        self.notes.insert(token_id, note);
    }

    /// Owner only, once the lock has expired.
    pub fn cancel_claim(&mut self, token_id: TokenId) {
        let mut note = self.owned_idle(&token_id);
        require!(note.claim_key.is_some(), "no claim link");
        require!(!note.claim_locked(), "claim link is still locked");
        note.claim_key = None;
        self.notes.insert(token_id, note);
    }

    /// Anyone holding a valid signature from the link secret.
    pub fn claim(&mut self, token_id: TokenId, new_owner: AccountId, signature: String) {
        let mut note = self.notes.get(&token_id).cloned().unwrap_or_else(|| panic_msg("unknown note"));
        require!(matches!(note.state, State::Minted | State::Sealed) && !note.in_transfer, "note cannot move in this state");
        let key = note.claim_key.unwrap_or_else(|| panic_msg("no claim link"));
        let sig: [u8; 64] = btc::hex_decode(&signature)
            .ok()
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| panic_msg("signature must be 64 bytes of hex"));
        let msg = format!("cachet-claim:{}:{}:{}", env::current_account_id(), token_id, new_owner);
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &key), "bad claim signature");
        let old = self.owner_of(&token_id);
        require!(old != new_owner, "note already belongs to that account");
        note.claim_key = None;
        self.notes.insert(token_id.clone(), note);
        // `internal_transfer_unguarded` leaves NEP-178 approvals in place; the old owner's
        // approved accounts must not outlive the claim.
        if let Some(approved) = self.tokens.approvals_by_id.as_mut().and_then(|a| a.remove(&token_id)) {
            refund_approved_account_ids(old.clone(), &approved).detach();
        }
        self.tokens.internal_transfer_unguarded(&token_id, &old, &new_owner);
        NftTransfer {
            old_owner_id: &old,
            new_owner_id: &new_owner,
            token_ids: &[token_id.as_str()],
            authorized_id: None,
            memo: Some("claim"),
        }
        .emit();
    }
}

// ---- private helpers ----
impl Cachet {
    fn owner_of(&self, token_id: &str) -> AccountId {
        self.tokens.owner_by_id.get(&token_id.to_string()).unwrap_or_else(|| panic_msg("unknown note"))
    }

    /// Note owned by the caller and not mid-transfer.
    fn owned_idle(&self, token_id: &TokenId) -> Note {
        let note = self.notes.get(token_id).cloned().unwrap_or_else(|| panic_msg("unknown note"));
        require!(self.owner_of(token_id) == env::predecessor_account_id(), "only the note owner can do this");
        require!(!note.in_transfer, "note is mid-transfer");
        note
    }

    fn refund(to: &AccountId, yocto: u128) {
        if yocto > 0 {
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(yocto)).detach();
        }
    }

    /// The only call site of `v1.signer.sign`; requires a permit from `authorize_sign`.
    fn request_signature(&self, _permit: SignPermit, path: String, sighash: [u8; 32]) -> Promise {
        ext_signer::ext(self.signer_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_SIGNER)
            .sign(SignArgs {
                path,
                payload_v2: Payload::Ecdsa(btc::hex_encode(&sighash)),
                domain_id: DOMAIN_SIGN,
            })
    }

    /// DER signature for the pending sighash, accepted only if it recovers to the note key.
    fn signature_for(note: &Note, resp: SignatureResponse) -> Option<Vec<u8>> {
        let SignatureResponse::Secp256k1 { big_r, s, recovery_id } = resp else { return None };
        let point = btc::hex_decode(&big_r.affine_point).ok()?;
        if point.len() != 33 {
            return None;
        }
        let r: [u8; 32] = point[1..].try_into().ok()?;
        let s: [u8; 32] = btc::hex_32(&s.scalar).ok()?;
        let (r, s, v) = btc::normalize_low_s(r, s, recovery_id).ok()?;
        let mut sig64 = [0u8; 64];
        sig64[..32].copy_from_slice(&r);
        sig64[32..].copy_from_slice(&s);
        let recovers = |v: u8| env::ecrecover(&note.pending_sighash, &sig64, v, true) == Some(note.pubkey);
        (recovers(v) || recovers(v ^ 1)).then(|| btc::der_signature(&r, &s))
    }

    fn signed_tx_hex(note: &Note) -> Option<String> {
        if note.signature.is_empty() || !matches!(note.state, State::Unsealed | State::Resigning | State::Finalizing) {
            return None;
        }
        Some(btc::hex_encode(&note.sweep(note.fee).signed_tx(&note.signature)))
    }

    /// Puts the note view in `metadata.extra` so markets read the state without a second call.
    fn with_note(&self, mut token: Token) -> Token {
        let view = self.note(token.token_id.clone());
        if let (Some(meta), Some(view)) = (token.metadata.as_mut(), view) {
            meta.extra = near_sdk::serde_json::to_string(&view).ok();
        }
        token
    }

    fn view(token_id: &str, owner_id: AccountId, note: &Note) -> NoteView {
        NoteView {
            token_id: token_id.to_string(),
            owner_id,
            state: note.state,
            path: path_of(token_id, note.slot),
            address: note.address.clone(),
            pubkey: btc::hex_encode(&note.pubkey33()),
            utxo: note.utxo.as_ref().map(|u| UtxoView {
                txid: btc::hex_encode(&btc::reversed(u.txid)),
                vout: u.vout,
                sats: u.sats,
                block_hash: btc::hex_encode(&btc::reversed(u.block_hash)),
            }),
            sweep: (!note.dest_script.is_empty()).then(|| SweepView {
                destination_script: btc::hex_encode(&note.dest_script),
                fee_sats: if note.signature.is_empty() { note.pending_fee } else { note.fee },
                signed_tx: Self::signed_tx_hex(note),
            }),
            claim: note.claim_key.map(|k| ClaimView {
                key: btc::hex_encode(&k),
                expires_at_block: note.claim_expiry,
                locked: note.claim_locked(),
            }),
            in_transfer: note.in_transfer,
            pending_since: note.pending_since,
        }
    }

    /// Removes the NEP-171 record and the note.
    fn burn(&mut self, token_id: &TokenId) {
        let owner = self.tokens.owner_by_id.get(token_id);
        self.tokens.owner_by_id.remove(token_id);
        if let Some(m) = &mut self.tokens.token_metadata_by_id {
            m.remove(token_id);
        }
        if let (Some(per_owner), Some(owner)) = (&mut self.tokens.tokens_per_owner, &owner) {
            if let Some(mut set) = per_owner.get(owner) {
                set.remove(token_id);
                if set.is_empty() {
                    per_owner.remove(owner);
                } else {
                    per_owner.insert(owner, &set);
                }
            }
        }
        if let Some(a) = &mut self.tokens.approvals_by_id {
            a.remove(token_id);
        }
        if let Some(a) = &mut self.tokens.next_approval_id_by_id {
            a.remove(token_id);
        }
        self.notes.remove(token_id);
        if let Some(owner) = owner {
            NftBurn { owner_id: &owner, token_ids: &[token_id.as_str()], authorized_id: None, memo: None }.emit();
        }
    }

    /// Gate for `nft_transfer` and `nft_transfer_call`: only an idle note with no active
    /// claim link moves, and any pending claim key dies with the transfer.
    fn before_transfer(&mut self, token_id: &TokenId, call: bool) {
        let mut note = self.notes.get(token_id).cloned().unwrap_or_else(|| panic_msg("unknown note"));
        require!(matches!(note.state, State::Minted | State::Sealed), "note cannot move in this state");
        require!(!note.in_transfer, "note is mid-transfer");
        require!(!note.claim_locked(), "claim link is active");
        note.claim_key = None;
        note.in_transfer = call;
        self.notes.insert(token_id.clone(), note);
    }
}

// ---- NEP-171, 177, 178, 181 ----

#[near]
impl NonFungibleTokenCore for Cachet {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.before_transfer(&token_id, false);
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.before_transfer(&token_id, true);
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id).map(|t| self.with_note(t))
    }
}

/// NEP-199 payout map: account to the amount it receives.
#[near(serializers = [json])]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

#[near]
impl Cachet {
    /// NEP-199 `nft_payout`: the whole `balance` goes to the current owner of the note.
    pub fn nft_payout(&self, token_id: TokenId, balance: U128, max_len_payout: Option<u32>) -> Payout {
        let owner = self.owner_of(&token_id);
        require!(max_len_payout.map_or(true, |m| m >= 1), "max_len_payout is below the payout length");
        let mut payout = HashMap::new();
        payout.insert(owner, balance);
        Payout { payout }
    }
}


#[near]
impl NonFungibleTokenResolver for Cachet {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let reverted = self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id.clone(), approved_account_ids);
        if let Some(mut note) = self.notes.get(&token_id).cloned() {
            note.in_transfer = false;
            self.notes.insert(token_id, note);
        }
        reverted
    }
}

#[near]
impl NonFungibleTokenApproval for Cachet {
    #[payable]
    fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id)
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id)
    }

    fn nft_is_approved(&self, token_id: TokenId, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        self.tokens.nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Cachet {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit).into_iter().map(|t| self.with_note(t)).collect()
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit).into_iter().map(|t| self.with_note(t)).collect()
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Cachet {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATES: [State; 7] = [
        State::Minted,
        State::Attesting,
        State::Sealed,
        State::Unsealing,
        State::Unsealed,
        State::Resigning,
        State::Finalizing,
    ];

    /// Enumerates every (op, state, owner, in_transfer, claim_locked) and prints which
    /// combinations may sign.
    fn allowed() -> Vec<(SignOp, State, bool, bool, bool)> {
        let mut v = vec![];
        for op in [SignOp::Unseal, SignOp::Resign] {
            for st in STATES {
                for owner in [false, true] {
                    for xfer in [false, true] {
                        for locked in [false, true] {
                            if authorize_sign(op, st, owner, xfer, locked).is_ok() {
                                v.push((op, st, owner, xfer, locked));
                            }
                        }
                    }
                }
            }
        }
        v
    }

    #[test]
    fn signing_is_reachable_from_exactly_three_configurations_in_two_states() {
        let a = allowed();
        assert_eq!(
            a,
            vec![
                (SignOp::Unseal, State::Sealed, true, false, false),
                (SignOp::Resign, State::Unsealed, true, false, false),
                (SignOp::Resign, State::Unsealed, true, false, true),
            ],
            "{a:?}"
        );
    }

    #[test]
    fn source_has_one_signer_sign_call_site_behind_a_permit() {
        let src = include_str!("lib.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        assert_eq!(body.matches(".sign(SignArgs").count(), 1);
        assert_eq!(body.matches("self.request_signature(permit").count(), 2);
        assert_eq!(body.matches("fn request_signature(&self, _permit: SignPermit").count(), 1);
        assert_eq!(body.matches("SignPermit(())").count(), 2);
    }
}
