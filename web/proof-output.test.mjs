import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { outputMismatch } = require("./outcome.js");
const tx = JSON.parse(readFileSync(new URL("./fixtures/proof-output/tx.json", import.meta.url), "utf8"));
const note = { address: "bc1qcachetnote", utxo: { vout: 0, sats: 125000 } };

test("matching transaction output has no mismatch", () => {
  assert.equal(outputMismatch(note, tx), null);
});

test("wrong output address is identified", () => {
  const wrongAddress = structuredClone(tx);
  wrongAddress.vout[0].scriptpubkey_address = "bc1qsomeoneelse";
  assert.match(outputMismatch(note, wrongAddress), /different address/);
});

test("wrong output value is identified", () => {
  const wrongValue = structuredClone(tx);
  wrongValue.vout[0].value++;
  assert.match(outputMismatch(note, wrongValue), /different value/);
});

test("missing output is identified", () => {
  assert.match(outputMismatch(note, { vout: [] }), /is missing/);
});
