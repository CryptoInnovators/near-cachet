//! Bitcoin primitives the note contract needs: raw transaction parsing, txid, P2WPKH
//! addresses, BIP143 sighash, DER signatures and the signed sweep transaction.

use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

pub const MAX_RAW_TX_BYTES: usize = 100_000;
pub const DUST_P2WPKH: u64 = 294;
pub const SWEEP_SEQUENCE: u32 = 0xffff_fffd;
pub const SIGHASH_ALL: u32 = 1;
const MAX_FEE_RATE: u64 = 1_000;

const SECP_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
const SECP_HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

pub fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

pub fn sha256d(b: &[u8]) -> [u8; 32] {
    sha256(&sha256(b))
}

pub fn hash160(b: &[u8]) -> [u8; 20] {
    Ripemd160::digest(sha256(b)).into()
}

pub fn hex_encode(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn hex_decode(s: &str) -> Result<Vec<u8>, &'static str> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return Err("odd hex length");
    }
    fn nib(c: u8) -> Result<u8, &'static str> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err("bad hex digit"),
        }
    }
    b.chunks(2).map(|p| Ok(nib(p[0])? << 4 | nib(p[1])?)).collect()
}

pub fn hex_32(s: &str) -> Result<[u8; 32], &'static str> {
    hex_decode(s)?.try_into().map_err(|_| "expected 32 bytes")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxIn {
    /// Previous txid in internal (hash) byte order.
    pub prev_txid: [u8; 32],
    pub vout: u32,
    pub sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxOut {
    pub value: u64,
    pub script: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTx {
    /// Double SHA-256 of the witness-stripped serialization, internal byte order.
    pub txid: [u8; 32],
    pub inputs: Vec<TxIn>,
    pub outputs: Vec<TxOut>,
}

impl ParsedTx {
    /// Explorer order: the string `getrawtransaction` and mempool.space use.
    pub fn txid_display(&self) -> [u8; 32] {
        reversed(self.txid)
    }
}

pub fn reversed(mut b: [u8; 32]) -> [u8; 32] {
    b.reverse();
    b
}

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.pos.checked_add(n).ok_or("overflow")?;
        if end > self.b.len() {
            return Err("truncated transaction");
        }
        let s = &self.b[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, &'static str> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, &'static str> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn varint(&mut self) -> Result<u64, &'static str> {
        let v = match self.u8()? {
            0xfd => {
                let v = u16::from_le_bytes(self.take(2)?.try_into().unwrap()) as u64;
                if v < 0xfd {
                    return Err("non-canonical varint");
                }
                v
            }
            0xfe => {
                let v = self.u32()? as u64;
                if v <= 0xffff {
                    return Err("non-canonical varint");
                }
                v
            }
            0xff => {
                let v = self.u64()?;
                if v <= 0xffff_ffff {
                    return Err("non-canonical varint");
                }
                v
            }
            n => n as u64,
        };
        if v as usize > MAX_RAW_TX_BYTES {
            return Err("varint exceeds transaction size cap");
        }
        Ok(v)
    }
}

/// Parses a legacy or segwit serialized transaction and computes its txid from the
/// witness-stripped bytes. Rejects trailing bytes, non-canonical varints and a segwit
/// marker with no witness data.
pub fn parse_tx(raw: &[u8]) -> Result<ParsedTx, &'static str> {
    if raw.len() > MAX_RAW_TX_BYTES {
        return Err("transaction too large");
    }
    if raw.len() < 10 {
        return Err("transaction too short");
    }
    let mut r = Reader { b: raw, pos: 4 };
    let mut segwit = false;
    let body_start;
    if raw[4] == 0x00 {
        if raw[5] != 0x01 {
            return Err("bad segwit flag");
        }
        segwit = true;
        r.pos = 6;
        body_start = 6;
    } else {
        body_start = 4;
    }
    let nin = r.varint()?;
    if nin == 0 {
        return Err("transaction has no inputs");
    }
    let mut inputs = Vec::new();
    for _ in 0..nin {
        let prev_txid: [u8; 32] = r.take(32)?.try_into().unwrap();
        let vout = r.u32()?;
        let slen = r.varint()? as usize;
        r.take(slen)?;
        let sequence = r.u32()?;
        inputs.push(TxIn { prev_txid, vout, sequence });
    }
    let nout = r.varint()?;
    if nout == 0 {
        return Err("transaction has no outputs");
    }
    let mut outputs = Vec::new();
    for _ in 0..nout {
        let value = r.u64()?;
        let slen = r.varint()? as usize;
        let script = r.take(slen)?.to_vec();
        outputs.push(TxOut { value, script });
    }
    let body_end = r.pos;
    if segwit {
        let mut any = false;
        for _ in 0..nin {
            let items = r.varint()?;
            for _ in 0..items {
                let l = r.varint()? as usize;
                r.take(l)?;
                any = true;
            }
            if items > 0 {
                any = true;
            }
        }
        if !any {
            return Err("segwit marker without witness data");
        }
    }
    let locktime_start = r.pos;
    r.take(4)?;
    if r.pos != raw.len() {
        return Err("trailing bytes after transaction");
    }
    let mut stripped = Vec::with_capacity(raw.len());
    stripped.extend_from_slice(&raw[..4]);
    stripped.extend_from_slice(&raw[body_start..body_end]);
    stripped.extend_from_slice(&raw[locktime_start..]);
    if stripped.len() == 64 {
        return Err("64-byte transaction");
    }
    Ok(ParsedTx { txid: sha256d(&stripped), inputs, outputs })
}

fn put_varint(out: &mut Vec<u8>, n: u64) {
    match n {
        0..=0xfc => out.push(n as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(n as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(0xfe);
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
        _ => {
            out.push(0xff);
            out.extend_from_slice(&n.to_le_bytes());
        }
    }
}

const BECH32_CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST: u32 = 1;
const BECH32M_CONST: u32 = 0x2bc8_30a3;

fn polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
    let mut chk = 1u32;
    for v in values {
        let top = chk >> 25;
        chk = (chk & 0x01ff_ffff) << 5 ^ (*v as u32);
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let mut v: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
    v.push(0);
    v.extend(hrp.bytes().map(|c| c & 31));
    v
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let (mut acc, mut bits) = (0u32, 0u32);
    let maxv = (1u32 << to) - 1;
    let mut out = Vec::new();
    for v in data {
        if (*v as u32) >> from != 0 {
            return None;
        }
        acc = (acc << from) | *v as u32;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & maxv) as u8);
        }
        acc &= (1 << bits) - 1;
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return None;
    }
    Some(out)
}

pub fn segwit_encode(hrp: &str, version: u8, program: &[u8]) -> String {
    let mut data = vec![version];
    data.extend(convert_bits(program, 8, 5, true).expect("8 to 5 bit conversion cannot fail"));
    let k = if version == 0 { BECH32_CONST } else { BECH32M_CONST };
    let mut vals = hrp_expand(hrp);
    vals.extend_from_slice(&data);
    vals.extend_from_slice(&[0; 6]);
    let m = polymod(&vals) ^ k;
    for i in 0..6 {
        data.push(((m >> (5 * (5 - i))) & 31) as u8);
    }
    let mut s = String::from(hrp);
    s.push('1');
    s.extend(data.iter().map(|d| BECH32_CHARSET[*d as usize] as char));
    s
}

/// Decodes a segwit address for the given network prefix into its scriptPubKey.
/// Accepts witness v0 programs of 20 or 32 bytes (bech32) and v1 programs of 32 bytes
/// (bech32m).
pub fn address_to_script(hrp: &str, addr: &str) -> Result<Vec<u8>, &'static str> {
    if addr.bytes().any(|c| c.is_ascii_uppercase()) && addr.bytes().any(|c| c.is_ascii_lowercase()) {
        return Err("mixed case address");
    }
    let addr = addr.to_ascii_lowercase();
    let sep = addr.rfind('1').ok_or("missing separator")?;
    if &addr[..sep] != hrp {
        return Err("address network prefix mismatch");
    }
    let data: Vec<u8> = addr[sep + 1..]
        .bytes()
        .map(|c| BECH32_CHARSET.iter().position(|x| *x == c).map(|p| p as u8).ok_or("bad bech32 char"))
        .collect::<Result<_, _>>()?;
    if data.len() < 7 {
        return Err("address too short");
    }
    let mut vals = hrp_expand(hrp);
    vals.extend_from_slice(&data);
    let chk = polymod(&vals);
    let version = data[0];
    let want = match version {
        0 => BECH32_CONST,
        1 => BECH32M_CONST,
        _ => return Err("unsupported witness version"),
    };
    if chk != want {
        return Err("bad address checksum");
    }
    let prog = convert_bits(&data[1..data.len() - 6], 5, 8, false).ok_or("bad address padding")?;
    match (version, prog.len()) {
        (0, 20) | (0, 32) | (1, 32) => {}
        _ => return Err("unsupported witness program length"),
    }
    let mut script = vec![if version == 0 { 0x00 } else { 0x50 + version }, prog.len() as u8];
    script.extend(prog);
    Ok(script)
}

/// scriptPubKey of a P2WPKH output paying `pubkey` (33-byte compressed).
pub fn p2wpkh_script(pubkey: &[u8; 33]) -> Vec<u8> {
    let mut s = vec![0x00, 0x14];
    s.extend_from_slice(&hash160(pubkey));
    s
}

pub fn p2wpkh_address(hrp: &str, pubkey: &[u8; 33]) -> String {
    segwit_encode(hrp, 0, &hash160(pubkey))
}

/// Compresses the 64-byte x||y NEAR secp256k1 key.
pub fn compress_pubkey(xy: &[u8; 64]) -> [u8; 33] {
    let mut out = [0u8; 33];
    out[0] = 2 + (xy[63] & 1);
    out[1..].copy_from_slice(&xy[..32]);
    out
}

/// One-input one-output sweep of a P2WPKH UTXO.
#[derive(Debug, Clone)]
pub struct Sweep {
    pub prev_txid: [u8; 32],
    pub vout: u32,
    pub amount: u64,
    pub pubkey: [u8; 33],
    pub dest_script: Vec<u8>,
    pub fee: u64,
}

impl Sweep {
    pub fn out_value(&self) -> u64 {
        self.amount - self.fee
    }

    fn outpoint(&self) -> Vec<u8> {
        let mut o = self.prev_txid.to_vec();
        o.extend_from_slice(&self.vout.to_le_bytes());
        o
    }

    fn output_bytes(&self) -> Vec<u8> {
        let mut o = self.out_value().to_le_bytes().to_vec();
        put_varint(&mut o, self.dest_script.len() as u64);
        o.extend_from_slice(&self.dest_script);
        o
    }

    /// BIP143 sighash (SIGHASH_ALL) for input 0 spending a P2WPKH output.
    pub fn sighash(&self) -> [u8; 32] {
        let mut p = Vec::with_capacity(200);
        p.extend_from_slice(&2u32.to_le_bytes());
        p.extend_from_slice(&sha256d(&self.outpoint()));
        p.extend_from_slice(&sha256d(&SWEEP_SEQUENCE.to_le_bytes()));
        p.extend_from_slice(&self.outpoint());
        p.extend_from_slice(&[0x19, 0x76, 0xa9, 0x14]);
        p.extend_from_slice(&hash160(&self.pubkey));
        p.extend_from_slice(&[0x88, 0xac]);
        p.extend_from_slice(&self.amount.to_le_bytes());
        p.extend_from_slice(&SWEEP_SEQUENCE.to_le_bytes());
        p.extend_from_slice(&sha256d(&self.output_bytes()));
        p.extend_from_slice(&0u32.to_le_bytes());
        p.extend_from_slice(&SIGHASH_ALL.to_le_bytes());
        sha256d(&p)
    }

    /// Fully signed segwit serialization, ready for `sendrawtransaction`.
    pub fn signed_tx(&self, der_sig: &[u8]) -> Vec<u8> {
        let mut tx = Vec::new();
        tx.extend_from_slice(&2u32.to_le_bytes());
        tx.extend_from_slice(&[0x00, 0x01, 0x01]);
        tx.extend_from_slice(&self.outpoint());
        tx.push(0x00);
        tx.extend_from_slice(&SWEEP_SEQUENCE.to_le_bytes());
        tx.push(0x01);
        tx.extend_from_slice(&self.output_bytes());
        tx.push(0x02);
        put_varint(&mut tx, der_sig.len() as u64 + 1);
        tx.extend_from_slice(der_sig);
        tx.push(SIGHASH_ALL as u8);
        tx.push(33);
        tx.extend_from_slice(&self.pubkey);
        tx.extend_from_slice(&0u32.to_le_bytes());
        tx
    }
}

/// Virtual size of the sweep with a worst-case 72-byte signature element.
pub fn sweep_vsize(dest_script_len: usize) -> u64 {
    let base = 4 + 1 + 41 + 1 + (8 + 1 + dest_script_len as u64) + 4;
    let witness = 2 + 1 + (1 + 72) + (1 + 33);
    (base * 4 + witness + 3) / 4
}

/// Fee in satoshi for `rate` sat/vB, rejecting rates outside 1..=1000.
pub fn sweep_fee(rate: u64, dest_script_len: usize) -> Result<u64, &'static str> {
    if rate == 0 || rate > MAX_FEE_RATE {
        return Err("fee rate must be 1 to 1000 sat/vB");
    }
    Ok(rate * sweep_vsize(dest_script_len))
}

fn be_ge(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a >= b
}

fn be_sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        if d < 0 {
            d += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[i] = d as u8;
    }
    out
}

/// Returns `(r, s_low, recovery_id)` with `s` folded into the lower half of the curve
/// order (Bitcoin relay policy) and the recovery id adjusted to match.
pub fn normalize_low_s(r: [u8; 32], s: [u8; 32], recovery_id: u8) -> Result<([u8; 32], [u8; 32], u8), &'static str> {
    if recovery_id > 1 {
        return Err("unsupported recovery id");
    }
    let zero = [0u8; 32];
    if r == zero || s == zero || be_ge(&r, &SECP_N) || be_ge(&s, &SECP_N) {
        return Err("signature scalar out of range");
    }
    if s > SECP_HALF_N {
        Ok((r, be_sub(&SECP_N, &s), recovery_id ^ 1))
    } else {
        Ok((r, s, recovery_id))
    }
}

fn der_int(out: &mut Vec<u8>, x: &[u8; 32]) {
    let mut i = 0;
    while i < 31 && x[i] == 0 {
        i += 1;
    }
    let v = &x[i..];
    out.push(0x02);
    if v[0] & 0x80 != 0 {
        out.push(v.len() as u8 + 1);
        out.push(0);
    } else {
        out.push(v.len() as u8);
    }
    out.extend_from_slice(v);
}

pub fn der_signature(r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
    let mut body = Vec::with_capacity(70);
    der_int(&mut body, r);
    der_int(&mut body, s);
    let mut out = vec![0x30, body.len() as u8];
    out.extend(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::consensus::{deserialize, serialize};
    use bitcoin::hashes::Hash;
    use bitcoin::{Address, Network, PublicKey, Transaction};
    use proptest::prelude::*;

    const SEGWIT_TX: &str = include_str!("../tests/vectors/mainnet_da221dbb84a92a4c0d283ab33bb5880a09b81c1ff18428260fd2798ba200a6e7.hex");
    const SEGWIT_TX_ID: &str = "da221dbb84a92a4c0d283ab33bb5880a09b81c1ff18428260fd2798ba200a6e7";
    const LEGACY_TX: &str = include_str!("../tests/vectors/legacy_f4184f.hex");
    const LEGACY_TX_ID: &str = "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16";

    fn sample_pubkey() -> [u8; 33] {
        let mut k = [0u8; 33];
        k[0] = 2;
        k[1..].copy_from_slice(&[7u8; 32]);
        k
    }

    #[test]
    fn bip173_vector_address() {
        let pk = hex_decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798").unwrap();
        let pk: [u8; 33] = pk.try_into().unwrap();
        assert_eq!(p2wpkh_address("bc", &pk), "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
        assert_eq!(p2wpkh_address("tb", &pk), "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
    }

    #[test]
    fn address_roundtrip_against_bitcoin_crate() {
        for hrp in ["bc", "tb"] {
            let a = p2wpkh_address(hrp, &sample_pubkey());
            let script = address_to_script(hrp, &a).unwrap();
            assert_eq!(script, p2wpkh_script(&sample_pubkey()));
            let net = if hrp == "bc" { Network::Bitcoin } else { Network::Testnet };
            let pk = PublicKey::from_slice(&sample_pubkey()).unwrap();
            let ours = Address::p2wpkh(&pk.try_into().unwrap(), net).to_string();
            assert_eq!(ours, a);
        }
    }

    #[test]
    fn address_decode_rejects_bad_input() {
        let good = p2wpkh_address("bc", &sample_pubkey());
        assert!(address_to_script("tb", &good).is_err());
        let mut bad = good.clone();
        bad.replace_range(good.len() - 1.., if good.ends_with('q') { "p" } else { "q" });
        assert_eq!(address_to_script("bc", &bad), Err("bad address checksum"));
        assert!(address_to_script("bc", &good.to_uppercase()).is_ok());
        let mixed = format!("{}{}", &good[..5].to_uppercase(), &good[5..]);
        assert_eq!(address_to_script("bc", &mixed), Err("mixed case address"));
        let taproot = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
        assert_eq!(address_to_script("bc", taproot).unwrap().len(), 34);
    }

    #[test]
    fn parses_real_mainnet_txs_to_their_published_txid() {
        for (hex, id) in [(SEGWIT_TX, SEGWIT_TX_ID), (LEGACY_TX, LEGACY_TX_ID)] {
            let raw = hex_decode(hex.trim()).unwrap();
            let p = parse_tx(&raw).unwrap();
            assert_eq!(hex_encode(&p.txid_display()), id);
            let tx: Transaction = deserialize(&raw).unwrap();
            assert_eq!(p.txid, tx.compute_txid().to_byte_array());
            assert_eq!(p.outputs.len(), tx.output.len());
            assert_eq!(p.inputs.len(), tx.input.len());
        }
        let p = parse_tx(&hex_decode(SEGWIT_TX.trim()).unwrap()).unwrap();
        assert_eq!(p.outputs[0].value, 0x653a);
        assert_eq!(p.outputs[1].value, 0x025c);
    }

    #[test]
    fn segwit_and_stripped_serializations_share_a_txid() {
        let raw = hex_decode(SEGWIT_TX.trim()).unwrap();
        let tx: Transaction = deserialize(&raw).unwrap();
        let mut stripped = tx.clone();
        for i in &mut stripped.input {
            i.witness.clear();
        }
        let l = serialize(&stripped);
        assert_ne!(l, raw);
        assert_eq!(parse_tx(&l).unwrap().txid, parse_tx(&raw).unwrap().txid);
    }

    /// Paper 1 (WTSC25): a 64-byte Merkle inner node parses as a 64-byte transaction.
    #[test]
    fn rejects_a_64_byte_witness_stripped_transaction() {
        let mut raw = vec![1, 0, 0, 0, 1];
        raw.extend_from_slice(&[7u8; 32]);
        raw.extend_from_slice(&0u32.to_le_bytes());
        raw.push(0);
        raw.extend_from_slice(&u32::MAX.to_le_bytes());
        raw.push(1);
        raw.extend_from_slice(&5000u64.to_le_bytes());
        raw.extend_from_slice(&[4, 0xaa, 0xbb, 0xcc, 0xdd]);
        raw.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(raw.len(), 64);
        assert_eq!(parse_tx(&raw), Err("64-byte transaction"));
        let script_len_at = 4 + 1 + 32 + 4 + 1 + 4 + 1 + 8;
        let mut other = raw.clone();
        other[script_len_at] = 5;
        other.insert(script_len_at + 1, 0xee);
        assert_eq!(other.len(), 65);
        assert!(parse_tx(&other).is_ok(), "65-byte neighbour must still parse");
    }

    #[test]
    fn rejects_malformed_transactions() {
        let raw = hex_decode(SEGWIT_TX.trim()).unwrap();
        let mut trailing = raw.clone();
        trailing.push(0);
        assert_eq!(parse_tx(&trailing), Err("trailing bytes after transaction"));
        assert!(parse_tx(&raw[..raw.len() - 1]).is_err());
        assert!(parse_tx(&raw[..8]).is_err());
        let mut flag = raw.clone();
        flag[5] = 0x02;
        assert_eq!(parse_tx(&flag), Err("bad segwit flag"));
        let tx: Transaction = deserialize(&raw).unwrap();
        let mut empty_wit = tx.clone();
        for i in &mut empty_wit.input {
            i.witness.clear();
        }
        let mut forced = serialize(&empty_wit);
        forced.splice(4..4, [0x00u8, 0x01]);
        let n = forced.len();
        forced.splice(n - 4..n - 4, [0x00u8, 0x00u8]);
        assert_eq!(parse_tx(&forced), Err("segwit marker without witness data"));
        assert!(parse_tx(&[]).is_err());
        let mut huge = vec![0u8; MAX_RAW_TX_BYTES + 1];
        huge[4] = 1;
        assert_eq!(parse_tx(&huge), Err("transaction too large"));
    }

    fn sweep() -> Sweep {
        Sweep {
            prev_txid: [9u8; 32],
            vout: 1,
            amount: 50_000,
            pubkey: {
                let sk = bitcoin::secp256k1::SecretKey::from_slice(&[0x11; 32]).unwrap();
                bitcoin::secp256k1::PublicKey::from_secret_key(&bitcoin::secp256k1::Secp256k1::new(), &sk).serialize()
            },
            dest_script: p2wpkh_script(&sample_pubkey()),
            fee: 1_100,
        }
    }

    #[test]
    fn sighash_matches_bitcoin_crate_bip143() {
        use bitcoin::sighash::{EcdsaSighashType, SighashCache};
        use bitcoin::{absolute::LockTime, transaction::Version, Amount, OutPoint, ScriptBuf, Sequence, TxIn as BTxIn, TxOut as BTxOut, Txid, Witness};
        let s = sweep();
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![BTxIn {
                previous_output: OutPoint { txid: Txid::from_byte_array(s.prev_txid), vout: s.vout },
                script_sig: ScriptBuf::new(),
                sequence: Sequence(SWEEP_SEQUENCE),
                witness: Witness::new(),
            }],
            output: vec![BTxOut { value: Amount::from_sat(s.out_value()), script_pubkey: ScriptBuf::from_bytes(s.dest_script.clone()) }],
        };
        let spk = ScriptBuf::from_bytes(p2wpkh_script(&s.pubkey));
        let mut cache = SighashCache::new(&tx);
        let want = cache
            .p2wpkh_signature_hash(0, &spk, Amount::from_sat(s.amount), EcdsaSighashType::All)
            .unwrap();
        assert_eq!(s.sighash(), want.to_byte_array());
    }

    #[test]
    fn signed_tx_is_valid_segwit_with_correct_txid_and_signature() {
        use bitcoin::secp256k1::{ecdsa::Signature, Message, Secp256k1, SecretKey};
        let secp = Secp256k1::new();
        let sk = SecretKey::from_slice(&[0x11; 32]).unwrap();
        let s = sweep();
        let sig = secp.sign_ecdsa(&Message::from_digest(s.sighash()), &sk);
        let compact = sig.serialize_compact();
        let (r, ss) = (<[u8; 32]>::try_from(&compact[..32]).unwrap(), <[u8; 32]>::try_from(&compact[32..]).unwrap());
        let der = der_signature(&r, &ss);
        assert_eq!(der, sig.serialize_der().to_vec());
        let raw = s.signed_tx(&der);
        let tx: Transaction = deserialize(&raw).unwrap();
        assert_eq!(serialize(&tx), raw);
        assert_eq!(tx.input[0].witness.len(), 2);
        let parsed = parse_tx(&raw).unwrap();
        assert_eq!(parsed.txid, tx.compute_txid().to_byte_array());
        let est = sweep_vsize(s.dest_script.len());
        assert!(est >= tx.vsize() as u64 && est <= tx.vsize() as u64 + 1, "estimate {est} vs vsize {}", tx.vsize());
        let w = tx.input[0].witness.to_vec();
        let parsed_sig = Signature::from_der(&w[0][..w[0].len() - 1]).unwrap();
        let pk = bitcoin::secp256k1::PublicKey::from_secret_key(&secp, &sk);
        secp.verify_ecdsa(&Message::from_digest(s.sighash()), &parsed_sig, &pk).unwrap();
    }

    #[test]
    fn vsize_estimate_is_an_upper_bound_within_one_vbyte() {
        assert_eq!(sweep_vsize(22), 110);
        assert_eq!(sweep_vsize(34), 122);
        assert_eq!(sweep_fee(10, 22).unwrap(), 1100);
        assert!(sweep_fee(0, 22).is_err());
        assert!(sweep_fee(1001, 22).is_err());
    }

    #[test]
    fn low_s_normalization_flips_recovery_and_matches_secp256k1() {
        let mut high = SECP_HALF_N;
        high[31] += 1;
        let (_, s, v) = normalize_low_s([1; 32], high, 0).unwrap();
        assert_eq!(v, 1);
        assert!(s <= SECP_HALF_N);
        assert_eq!(be_sub(&SECP_N, &s), high);
        let (_, s2, v2) = normalize_low_s([1; 32], SECP_HALF_N, 1).unwrap();
        assert_eq!((s2, v2), (SECP_HALF_N, 1));
        assert!(normalize_low_s([0; 32], high, 0).is_err());
        assert!(normalize_low_s([1; 32], SECP_N, 0).is_err());
        assert!(normalize_low_s([1; 32], high, 2).is_err());
    }

    proptest! {
        #[test]
        fn der_matches_secp256k1_for_any_scalars(r in proptest::array::uniform32(any::<u8>()), s in proptest::array::uniform32(any::<u8>())) {
            let mut c = [0u8; 64];
            c[..32].copy_from_slice(&r);
            c[32..].copy_from_slice(&s);
            if let Ok(sig) = bitcoin::secp256k1::ecdsa::Signature::from_compact(&c) {
                prop_assert_eq!(der_signature(&r, &s), sig.serialize_der().to_vec());
            }
        }

        #[test]
        fn parser_txid_matches_bitcoin_core_for_random_txs(
            ins in 1usize..4, outs in 1usize..4, seed in any::<u64>(), witness in any::<bool>()
        ) {
            use bitcoin::{absolute::LockTime, transaction::Version, Amount, OutPoint, ScriptBuf, Sequence, TxIn as BTxIn, TxOut as BTxOut, Txid, Witness};
            let b = |i: u64, n: usize| -> Vec<u8> { (0..n).map(|k| (seed.wrapping_mul(i + 1).wrapping_add(k as u64) % 251) as u8).collect() };
            let tx = Transaction {
                version: Version::TWO,
                lock_time: LockTime::from_consensus((seed % 1000) as u32),
                input: (0..ins).map(|i| BTxIn {
                    previous_output: OutPoint { txid: Txid::from_byte_array(b(i as u64, 32).try_into().unwrap()), vout: i as u32 },
                    script_sig: ScriptBuf::from_bytes(b(i as u64 + 50, i * 3)),
                    sequence: Sequence(0xffff_fffd),
                    witness: if witness { Witness::from_slice(&[b(i as u64 + 9, 70), b(i as u64 + 3, 33)]) } else { Witness::new() },
                }).collect(),
                output: (0..outs).map(|i| BTxOut { value: Amount::from_sat(1000 + i as u64 + seed % 5000), script_pubkey: ScriptBuf::from_bytes(b(i as u64 + 20, 22 + i)) }).collect(),
            };
            let raw = serialize(&tx);
            let p = parse_tx(&raw).unwrap();
            prop_assert_eq!(p.txid, tx.compute_txid().to_byte_array());
            prop_assert_eq!(p.inputs.len(), ins);
            prop_assert_eq!(p.outputs.len(), outs);
            prop_assert_eq!(p.outputs[0].value, tx.output[0].value.to_sat());
        }
    }
}
