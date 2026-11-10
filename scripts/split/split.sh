#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

usage() { echo "Usage: $0 N TOTAL_SATS equal|lucky [seed]" >&2; }
[[ $# -ge 3 && $# -le 4 ]] || { usage; exit 2; }
N=$1 TOTAL=$2 MODE=$3 SEED=${4:-${SPLIT_SEED:-}}
[[ $N =~ ^[1-9][0-9]*$ && $TOTAL =~ ^[0-9]+$ ]] || { usage; exit 2; }
[[ $MODE == equal || $MODE == lucky ]] || { usage; exit 2; }
if [[ $MODE == lucky && -z $SEED ]]; then echo 'lucky mode requires a seed argument or SPLIT_SEED' >&2; exit 2; fi
for name in SPLIT_SOURCE_TXID SPLIT_SOURCE_VOUT; do
  [[ -n ${!name:-} ]] || { echo "Missing $name: provide an unspent source wallet UTXO; no signing key is read here" >&2; exit 1; }
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for ((i=0; i<N; i++)); do scripts/ops-testnet.sh mint >>"$tmp/minted"; done
node --input-type=module - "$N" "$TOTAL" "$MODE" "$SEED" "$tmp/minted" <<'NODE'
import fs from 'node:fs';
import { buildPsbt, luckySplit, liveUtxo } from './scripts/split/split-envelope.mjs';
const [nText, totalText, mode, seed, mintedFile] = process.argv.slice(2);
const n = Number(nText), total = Number(totalText);
const minted = fs.readFileSync(mintedFile, 'utf8').trim().split('\n').map((line) => line.trim().split(/\s+/)[0]);
if (minted.length !== n) throw new Error(`mint returned ${minted.length} notes, expected ${n}`);
const notes = await Promise.all(minted.map(async (token_id) => {
  const r = await fetch(process.env.NEARRPC || 'https://rpc.testnet.near.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'cachet-split', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: process.env.CONTRACT || 'cachet.testnet', method_name: 'note', args_base64: Buffer.from(JSON.stringify({ token_id })).toString('base64') } }) });
  if (!r.ok) throw new Error(`NEAR RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return JSON.parse(Buffer.from(j.result.result).toString());
}));
if (notes.some((x) => x.state !== 'Minted' || !x.address.startsWith('tb1'))) throw new Error('minted token postcondition failed');
const shares = mode === 'equal' ? Array(n).fill(Math.floor(total / n)).map((v, i) => v + (i < total % n ? 1 : 0)) : luckySplit(total, n, seed);
if (shares.some((s) => s < 1000) || shares.reduce((a, b) => a + b, 0) !== total) throw new Error('split must total the requested amount with each output >= 1000 sats');
const input = await liveUtxo(process.env.SPLIT_SOURCE_TXID, Number(process.env.SPLIT_SOURCE_VOUT));
const fee = Number(process.env.SPLIT_FEE_SATS || 500);
const result = buildPsbt({ addresses: notes.map((x) => x.address), shares, input, fee });
console.log(`Notes: ${minted.join(', ')}`);
for (const o of result.outputs) console.log(`${o.address} ${o.sats} sats${o.change ? ' (change)' : ''}`);
console.log(`Unsigned PSBT (base64): ${result.base64}`);
console.log(`Fee: ${result.fee} sats. Change back to ${input.address}: ${result.change} sats`);
console.log('Not signed or broadcast. Sign with the owner wallet after reviewing the source and fee.');
NODE
