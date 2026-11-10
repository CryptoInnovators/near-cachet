import test from 'node:test';
import assert from 'node:assert/strict';
import { luckySplit, buildPsbt, liveMintedNotes, liveUtxo, MAX_FEE_SATS } from '../split-envelope.mjs';

test('lucky split totals exactly, respects the floor, and is seed deterministic', () => {
  const a = luckySplit(100_003, 7, 'red-envelope-seed');
  assert.equal(a.reduce((sum, sats) => sum + sats, 0), 100_003);
  assert.ok(a.every((sats) => sats >= 1000));
  assert.deepEqual(luckySplit(100_003, 7, 'red-envelope-seed'), a);
  assert.notDeepEqual(luckySplit(100_003, 7, 'different-seed'), a);
});

test('unsigned PSBT has one exact-value output for each address from live minted notes', { skip: process.env.SPLIT_SOURCE_TXID ? false : 'needs SPLIT_SOURCE_TXID/VOUT: a funded testnet3 output' }, async () => {
  const notes = await liveMintedNotes(3);
  assert.equal(notes.length, 3);
  const input = await liveUtxo(process.env.SPLIT_SOURCE_TXID, Number(process.env.SPLIT_SOURCE_VOUT));
  const psbt = buildPsbt({ addresses: notes.map((n) => n.address), shares: [1000, 2000, 3000], input, fee: 500 });
  assert.ok(psbt.base64.startsWith('cHNidP8'));
  const raw = Buffer.from(psbt.base64, 'base64');
  const txStart = raw.indexOf(Buffer.from([1, 0]));
  assert.notEqual(txStart, -1, 'PSBT contains the unsigned transaction global key');
  const txLen = raw[txStart + 2];
  const tx = raw.subarray(txStart + 3, txStart + 3 + txLen);
  let p = 4;
  const vinCount = tx[p++];
  assert.equal(vinCount, 1);
  p += 36;
  p += 1 + tx[p] + 4;
  const voutCount = tx[p++];
  assert.equal(voutCount, notes.length + (psbt.change > 0 ? 1 : 0));
  const scripts = [];
  for (let i = 0; i < voutCount; i++) { p += 8; const len = tx[p++]; scripts.push(tx.subarray(p, p + len).toString('hex')); p += len; }
  assert.equal(scripts.length, notes.length);
  assert.equal(new Set(scripts).size, notes.length);
  assert.equal(psbt.outputs.length, notes.length);
  assert.deepEqual(psbt.outputs.map((o) => o.address), notes.map((n) => n.address));
  assert.deepEqual(scripts, psbt.outputs.map((o) => o.scriptPubKey));
});

// Real note addresses read from the cachet testnet contract on 2026-11-10 (judge notes 2 and 3); real funded input shape.
const A = ['tb1qsq98ec3mxsy9f2jhmmwwm54lsdq0sz47mx0wgd', 'tb1qdwk5fzlt9e4w280tlfmthwmc2qzpdt698fvump'];
const IN = { txid: '6462352d2eaec5924a8437e205f405ab0e1f0758fe0c2e32ad229a5260c1fc55', vout: 0, value: 50_000,
  scriptPubKey: '00146bad448beb2e6ae51debfa76bbbb78500416af45', address: 'tb1qdwk5fzlt9e4w280tlfmthwmc2qzpdt698fvump' };

test('the input beyond shares plus fee returns as change, never as fee', () => {
  const r = buildPsbt({ addresses: A, shares: [4000, 6000], input: IN, fee: 500 });
  assert.equal(r.fee, 500);
  assert.equal(r.change, 50_000 - 10_000 - 500);
  assert.equal(r.outputs.length, 3);
  assert.deepEqual(r.outputs.at(-1), { address: IN.address, sats: 39_500, change: true, scriptPubKey: IN.scriptPubKey });
  assert.equal(r.outputs.reduce((s, o) => s + o.sats, 0) + r.fee, IN.value, 'outputs plus fee equal the input exactly');
});

test('fee is explicit and capped; dust change and short inputs are refused', () => {
  assert.throws(() => buildPsbt({ addresses: A, shares: [4000, 6000], input: IN }), /fee must be/);
  assert.throws(() => buildPsbt({ addresses: A, shares: [4000, 6000], input: IN, fee: MAX_FEE_SATS + 1 }), /fee must be/);
  assert.throws(() => buildPsbt({ addresses: A, shares: [24_000, 25_800], input: IN, fee: 100 }), /below dust/);
  assert.throws(() => buildPsbt({ addresses: A, shares: [25_000, 25_000], input: IN, fee: 1 }), /cannot cover/);
  const exact = buildPsbt({ addresses: A, shares: [24_000, 25_500], input: IN, fee: 500 });
  assert.equal(exact.change, 0);
  assert.equal(exact.outputs.length, 2);
});
