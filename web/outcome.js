"use strict";

(() => {

function failureText(outcome) {
  const read = (status) => {
    const failure = status?.Failure;
    if (!failure) return null;
    if (typeof failure === "string") return failure;
    return failure.ActionError?.kind?.FunctionCallError?.ExecutionError || failure.ActionError?.kind?.FunctionCallError || failure.ActionError?.kind?.ExecutionError || failure.FunctionCallError?.ExecutionError || JSON.stringify(failure);
  };
  const direct = read(outcome?.status);
  if (direct) return direct;
  for (const receipt of outcome?.receipts_outcome || []) {
    const text = read(receipt?.outcome?.status);
    if (text) return text;
  }
  return null;
}

function blockHashMismatch(note, mempoolTx) {
  const expected = note?.utxo?.block_hash;
  const actual = mempoolTx?.status?.block_hash;
  return !expected || !actual || expected.toLowerCase() === actual.toLowerCase() ? null : `Block hash mismatch: note says ${expected}, mempool.space says ${actual}.`;
}

function fundingAddressVisible(note) {
  if (!note) return false;
  return note.state === "Minted";
}

// Virtual size of the one-input sweep, the formula of `sweep_vsize` in src/btc.rs.
const sweepVsize = (destScriptLen) => Math.floor((4 * (60 + destScriptLen) + 110 + 3) / 4);

function feeGuard(sats, rate, destScriptLen) {
  if (!Number.isInteger(rate) || rate < 1 || rate > 1000) return "Fee rate must be a whole number from 1 to 1000 sat/vB.";
  if (!Number.isInteger(sats) || !Number.isInteger(destScriptLen) || destScriptLen < 1) return "Note value or destination is invalid.";
  const vsize = sweepVsize(destScriptLen);
  if (sats < rate * vsize + 546) return `The note needs at least ${rate * vsize + 546} sats for this fee and destination.`;
  return null;
}

const lib = { failureText, blockHashMismatch, fundingAddressVisible, sweepVsize, feeGuard };
if (typeof module !== "undefined" && module.exports) module.exports = lib;
if (typeof globalThis !== "undefined") globalThis.cachetOutcome = lib;

})();
