import { createHash } from 'node:crypto';

export function luckySplit(total, count, seed, minimum = 1000) {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(count) || count < 1 || total < count * minimum || !seed) throw new Error('total, count, or seed is invalid');
  const remaining = total - count * minimum;
  const weights = Array.from({ length: count }, (_, i) => createHash('sha256').update(`${seed}:${i}`).digest().readUInt32BE(0) + 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => minimum + Math.floor(remaining * w / sum));
  let left = total - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; left; i = (i + 1) % count, left--) shares[i]++;
  return shares;
}

const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function decodeAddress(address) {
  const s = address.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (address !== s && address !== address.toUpperCase() || pos < 1 || s.slice(0, pos) !== 'tb') throw new Error(`not a Bitcoin testnet address: ${address}`);
  const data = [...s.slice(pos + 1)].map((c) => alphabet.indexOf(c));
  if (data.some((n) => n < 0) || data[0] !== 0 || data.length < 7) throw new Error(`unsupported witness address: ${address}`);
  const polymod = (values) => {
    const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const value of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ value; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]; }
    return chk >>> 0;
  };
  const hrp = s.slice(0, pos);
  const expanded = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31), data);
  if (polymod(expanded) !== 1) throw new Error(`invalid bech32 checksum: ${address}`);
  const words = data.slice(1, -6);
  let acc = 0, bits = 0;
  const bytes = [];
  for (const word of words) { acc = (acc << 5) | word; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 255) !== 0 || ![20, 32].includes(bytes.length)) throw new Error(`invalid witness program: ${address}`);
  return Buffer.concat([Buffer.from([0, bytes.length]), Buffer.from(bytes)]);
}
const compact = (n) => n < 253 ? Buffer.from([n]) : n <= 65535 ? Buffer.from([253, n & 255, n >> 8]) : Buffer.from([254, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]);
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const varbytes = (b) => Buffer.concat([compact(b.length), b]);

export const MAX_FEE_SATS = 5000;
export const DUST_SATS = 294;
export function buildPsbt({ addresses, shares, input, fee, changeAddress }) {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length !== shares.length) throw new Error('one share is required per address');
  if (new Set(addresses).size !== addresses.length || shares.some((s) => !Number.isSafeInteger(s) || s < 1000)) throw new Error('addresses must be unique and each share must be at least 1000 sats');
  if (!input || !/^[0-9a-f]{64}$/i.test(input.txid ?? '') || !Number.isSafeInteger(input.vout) || input.vout < 0 || !Number.isSafeInteger(input.value) || input.value < shares.reduce((a, b) => a + b, 0) || !/^(?:[0-9a-f]{2})+$/i.test(input.scriptPubKey ?? '')) throw new Error('a real source UTXO (txid, vout, value, scriptPubKey) is required and must cover all outputs');
  // Change returns to the input's own address; the fee is explicit and capped, never "whatever is left".
  const total = shares.reduce((x, y) => x + y, 0);
  if (!Number.isSafeInteger(fee) || fee < 1 || fee > MAX_FEE_SATS) throw new Error(`fee must be 1 to ${MAX_FEE_SATS} sats`);
  const change = input.value - total - fee;
  if (change < 0) throw new Error(`input ${input.value} sats cannot cover shares ${total} plus fee ${fee}`);
  if (change > 0 && change < DUST_SATS) throw new Error(`change ${change} sats is below dust; raise the fee by ${change} or lower a share`);
  const changeTo = changeAddress ?? input.address;
  if (change > 0 && !changeTo) throw new Error('change address is required when the input exceeds shares plus fee');
  const paid = change > 0 ? [...addresses, changeTo] : addresses;
  const amounts = change > 0 ? [...shares, change] : shares;
  const outputs = paid.map((address, i) => Buffer.concat([le64(amounts[i]), varbytes(decodeAddress(address))]));
  const tx = Buffer.concat([le32(2), compact(1), Buffer.from(input.txid, 'hex').reverse(), le32(input.vout), Buffer.from([0]), le32(0xfffffffd), compact(outputs.length), ...outputs, le32(0)]);
  const witnessUtxo = Buffer.concat([le64(input.value), varbytes(Buffer.from(input.scriptPubKey, 'hex'))]);
  const psbt = Buffer.concat([Buffer.from('70736274ff', 'hex'), Buffer.from([1, 0, ...compact(tx.length), ...tx, 0, 1, 1, ...compact(witnessUtxo.length), ...witnessUtxo, 0, ...Buffer.alloc(paid.length)])]);
  return { base64: psbt.toString('base64'), txHex: tx.toString('hex'), fee, change, outputs: paid.map((address, i) => ({ address, sats: amounts[i], change: i >= addresses.length, scriptPubKey: decodeAddress(address).toString('hex') })) };
}

export async function liveMintedNotes(count, rpc = process.env.NEARRPC || 'https://rpc.testnet.near.org', contract = process.env.CONTRACT || 'cachet.testnet') {
  const call = async (method, args) => {
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'cachet-split', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
    if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`NEAR RPC: ${body.error.message}`);
    return JSON.parse(Buffer.from(body.result.result).toString());
  };
  const tokens = await call('nft_tokens_for_owner', { account_id: process.env.OWNER || 'cachet-ops.testnet', from_index: null, limit: 100 });
  const notes = tokens.map((t) => { try { return JSON.parse(t.metadata.extra); } catch { return null; } });
  const found = notes.filter((n) => n?.state === 'Minted' && /^tb1/.test(n.address)).slice(0, count);
  if (found.length !== count) throw new Error(`live contract has ${found.length} usable Minted notes; need ${count}`);
  return found;
}

export async function liveUtxo(txid, vout, esplora = process.env.ESPLORA || 'https://blockstream.info/testnet/api') {
  if (!/^[0-9a-f]{64}$/i.test(txid ?? '') || !Number.isSafeInteger(vout) || vout < 0) throw new Error('SPLIT_SOURCE_TXID and SPLIT_SOURCE_VOUT must identify a real testnet3 output');
  const response = await fetch(`${esplora}/tx/${txid}`);
  if (!response.ok) throw new Error(`Esplora HTTP ${response.status}`);
  const tx = await response.json();
  if (!tx.status?.confirmed) throw new Error('source transaction is not confirmed on testnet3');
  const out = tx.vout?.[vout];
  if (!out?.scriptpubkey || !out.scriptpubkey_address || !Number.isSafeInteger(out.value)) throw new Error('source output is missing in Esplora');
  const utxosResponse = await fetch(`${esplora}/address/${out.scriptpubkey_address}/utxo`);
  if (!utxosResponse.ok) throw new Error(`Esplora UTXO HTTP ${utxosResponse.status}`);
  const utxos = await utxosResponse.json();
  if (!utxos.some((u) => u.txid === txid && u.vout === vout && u.value === out.value)) throw new Error('source output is already spent or absent from testnet3 UTXO set');
  return { txid, vout, value: out.value, scriptPubKey: out.scriptpubkey, address: out.scriptpubkey_address };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('Use split.sh to mint notes and assemble a PSBT; required source UTXO fields are documented in split.sh.');
  process.exit(2);
}
