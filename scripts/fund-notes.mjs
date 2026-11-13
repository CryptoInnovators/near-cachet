// Testnet funding signer for the judge pool. Holds one P2WPKH key (hex, mode 0600) at $KEY_FILE.
//   KEY_FILE=~/.config/cachet/btc-fund.key node scripts/fund-notes.mjs address
//   KEY_FILE=... node scripts/fund-notes.mjs send FEE_SATS ADDR:SATS [ADDR:SATS ...]
// `address` creates the key file when missing and prints the tb1q address. `send` spends every confirmed
// UTXO of that address (BIP143, low-S), returns change to it, checks the signatures locally, then broadcasts.
// The key never enters argv or stdout. Esplora base: $ESPLORA (default blockstream testnet).
import { createECDH, createHash, createPrivateKey, createPublicKey, randomBytes, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const ESPLORA = process.env.ESPLORA ?? "https://blockstream.info/testnet/api";
const KEY_FILE = process.env.KEY_FILE ?? "";
if (!KEY_FILE) throw new Error("set KEY_FILE");
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DUST = 546;

const sha256 = (b) => createHash("sha256").update(b).digest();
const dsha = (b) => sha256(sha256(b));
const hash160 = (b) => createHash("ripemd160").update(sha256(b)).digest();
const hex = (b) => Buffer.from(b).toString("hex");

// key
if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, hex(randomBytes(32)) + "\n", { mode: 0o600 });
chmodSync(KEY_FILE, 0o600);
const d = Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "hex");
if (d.length !== 32) throw new Error("key file must hold 32 hex-encoded bytes");
const ecdh = createECDH("secp256k1");
ecdh.setPrivateKey(d);
const pub = ecdh.getPublicKey(null, "compressed");
const uncompressed = ecdh.getPublicKey(null, "uncompressed");
const privateKey = createPrivateKey({
  key: { kty: "EC", crv: "secp256k1", d: d.toString("base64url"), x: uncompressed.subarray(1, 33).toString("base64url"), y: uncompressed.subarray(33).toString("base64url") },
  format: "jwk",
});
const pkh = hash160(pub);

// bech32 (BIP173) for witness v0
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const polymod = (v) => {
  let chk = 1;
  for (const x of v) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ x;
    [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].forEach((g, i) => { if ((top >>> i) & 1) chk ^= g; });
  }
  return chk;
};
function bech32(hrp, prog) {
  const words = [0];
  let acc = 0, bits = 0;
  for (const b of prog) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); } }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...exp, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...check].map((x) => CHARSET[x]).join("");
}
function decodeBech32(addr) { // witness v0 20-byte program only
  const s = addr.toLowerCase();
  const sep = s.lastIndexOf("1");
  const hrp = s.slice(0, sep);
  const data = [...s.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1) || polymod([...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data]) !== 1) throw new Error(`bad bech32 ${addr}`);
  const words = data.slice(1, -6);
  const out = [];
  let acc = 0, bits = 0;
  for (const w of words) { acc = (acc << 5) | w; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
  if (data[0] !== 0 || out.length !== 20 || hrp !== "tb") throw new Error(`${addr} is not a testnet P2WPKH address`);
  return Buffer.from(out);
}
const myAddress = bech32("tb", pkh);

// serialization
const le = (n, len) => { const b = Buffer.alloc(len); len === 8 ? b.writeBigUInt64LE(BigInt(n)) : b.writeUInt32LE(n); return b; };
const varint = (n) => Buffer.from(n < 253 ? [n] : [253, n & 255, n >> 8]);
const wpkh = (h) => Buffer.concat([Buffer.from([0, 20]), h]);
const out = (sats, spk) => Buffer.concat([le(sats, 8), varint(spk.length), spk]);

function derToLowS(der) { // Node returns DER; rewrite s to n - s when s > n/2
  let o = 2; // 30 len 02 rlen r 02 slen s
  const rlen = der[o + 1]; const r = der.subarray(o + 2, o + 2 + rlen); o += 2 + rlen;
  let s = BigInt("0x" + hex(der.subarray(o + 2, o + 2 + der[o + 1])));
  if (s > N / 2n) s = N - s;
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const sb = trim(Buffer.from(s.toString(16).padStart(64, "0"), "hex"));
  const rb = trim(Buffer.from(r));
  const body = Buffer.concat([Buffer.from([2, rb.length]), rb, Buffer.from([2, sb.length]), sb]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

async function api(path, init) {
  for (let i = 1; i <= 8; i++) {
    const res = await fetch(ESPLORA + path, init).catch(() => ({ ok: false, status: 599 })); // network errors retry like 5xx
    if (res.ok) return res;
    if (res.status !== 429 && res.status < 500) throw new Error(`${path} ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, i * 5000));
  }
  throw new Error(`${path} rate limited`);
}

async function send(fee, targets) {
  // REPLACE_TXID=<stuck tx> spends that tx's own inputs again at a higher fee (BIP125 replacement, inputs signal 0xfffffffd).
  const utxos = process.env.REPLACE_TXID
    ? (await (await api(`/tx/${process.env.REPLACE_TXID}`)).json()).vin.map((v) => ({ txid: v.txid, vout: v.vout, value: v.prevout.value, status: { confirmed: true } }))
    : (await (await api(`/address/${myAddress}/utxo`)).json()).filter((u) => u.status.confirmed);
  if (!utxos.length) throw new Error(`no confirmed UTXO at ${myAddress}`);
  const total = utxos.reduce((a, u) => a + u.value, 0);
  const outs = targets.map(([addr, sats]) => ({ sats, spk: wpkh(decodeBech32(addr)) }));
  const change = total - fee - outs.reduce((a, o) => a + o.sats, 0);
  if (change < 0) throw new Error(`short by ${-change} sats (have ${total})`);
  if (change >= DUST) outs.push({ sats: change, spk: wpkh(pkh) });
  const outputs = Buffer.concat([varint(outs.length), ...outs.map((o) => out(o.sats, o.spk))]);
  const ins = utxos.map((u) => ({ txid: Buffer.from(u.txid, "hex").reverse(), vout: u.vout, value: u.value }));
  const outpoint = (i) => Buffer.concat([i.txid, le(i.vout, 4)]);
  const hashPrevouts = dsha(Buffer.concat(ins.map(outpoint)));
  const hashSequence = dsha(Buffer.concat(ins.map(() => le(0xfffffffd, 4))));
  const hashOutputs = dsha(Buffer.concat(outs.map((o) => out(o.sats, o.spk))));
  const scriptCode = Buffer.concat([Buffer.from([0x19, 0x76, 0xa9, 0x14]), pkh, Buffer.from([0x88, 0xac])]);
  const sigs = ins.map((i) => {
    const preimage = Buffer.concat([le(2, 4), hashPrevouts, hashSequence, outpoint(i), scriptCode, le(i.value, 8), le(0xfffffffd, 4), hashOutputs, le(0, 4), le(1, 4)]);
    // BIP143 signs dsha(preimage); Node's "sha256" signer hashes once, so hand it sha256(preimage).
    const msg = sha256(preimage);
    const der = derToLowS(nodeSign("sha256", msg, { key: privateKey, dsaEncoding: "der" }));
    if (!nodeVerify("sha256", msg, { key: createPublicKey(privateKey), dsaEncoding: "der" }, der)) throw new Error("self-check: signature does not verify");
    return Buffer.concat([der, Buffer.from([1])]);
  });
  const wit = Buffer.concat(sigs.map((s) => Buffer.concat([Buffer.from([2]), varint(s.length), s, varint(pub.length), pub])));
  const raw = Buffer.concat([
    le(2, 4), Buffer.from([0, 1]), varint(ins.length),
    ...ins.map((i) => Buffer.concat([outpoint(i), Buffer.from([0]), le(0xfffffffd, 4)])),
    outputs, wit, le(0, 4),
  ]);
  const txid = hex(dsha(Buffer.concat([le(2, 4), varint(ins.length), ...ins.map((i) => Buffer.concat([outpoint(i), Buffer.from([0]), le(0xfffffffd, 4)])), outputs, le(0, 4)])).reverse());
  const res = await api("/tx", { method: "POST", body: hex(raw) });
  const got = (await res.text()).trim();
  if (got !== txid) throw new Error(`broadcast returned ${got}, expected ${txid}`);
  console.log(txid);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "address") console.log(myAddress);
else if (cmd === "send") {
  const [fee, ...t] = args;
  await send(Number(fee), t.map((x) => { const [a, s] = x.split(":"); return [a, Number(s)]; }));
} else { console.error("usage: address | send FEE_SATS ADDR:SATS..."); process.exit(2); }
