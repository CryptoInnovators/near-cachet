"use strict";

async function inclusionProof(base, txid, get = globalThis.cachetChain.mempoolJson, text = globalThis.cachetChain.mempoolText) {
  const tx = await get(base, `/tx/${encodeURIComponent(txid)}`);
  if (!tx.status?.confirmed || !tx.status.block_hash) throw new Error("Funding transaction is not confirmed yet.");
  const proof = await get(base, `/tx/${encodeURIComponent(txid)}/merkle-proof`);
  const coinbase = await text(base, `/block/${encodeURIComponent(tx.status.block_hash)}/txid/0`);
  const coinbaseProof = await get(base, `/tx/${encodeURIComponent(coinbase)}/merkle-proof`);
  if (!Array.isArray(proof.merkle) || !Array.isArray(coinbaseProof.merkle)) throw new Error("Bitcoin explorer returned an invalid merkle proof.");
  return { block_hash: tx.status.block_hash, tx_index: proof.pos, merkle_proof: proof.merkle, coinbase_tx_id: coinbase, coinbase_merkle_proof: coinbaseProof.merkle };
}

async function fundingOf(base, address, get = globalThis.cachetChain.mempoolJson, text = globalThis.cachetChain.mempoolText) {
  const txs = await get(base, `/address/${encodeURIComponent(address)}/txs`);
  for (const tx of txs) {
    const output = (tx.vout || []).findIndex((out) => out.scriptpubkey_address === address);
    if (output < 0) continue;
    const raw_tx = await text(base, `/tx/${encodeURIComponent(tx.txid)}/hex`);
    return { txid: tx.txid, vout: output, raw_tx };
  }
  return null;
}

async function spendOf(base, txid, vout, get = globalThis.cachetChain.mempoolJson, text = globalThis.cachetChain.mempoolText) {
  const outspend = await get(base, `/tx/${encodeURIComponent(txid)}/outspend/${vout}`);
  if (!outspend.spent) return null;
  return { txid: outspend.txid, raw_tx: await text(base, `/tx/${encodeURIComponent(outspend.txid)}/hex`) };
}

const lib = { inclusionProof, fundingOf, spendOf };
if (typeof module !== "undefined" && module.exports) module.exports = lib;
if (typeof globalThis !== "undefined") globalThis.cachetBtcProof = lib;
