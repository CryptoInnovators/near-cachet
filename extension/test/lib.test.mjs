import test from "node:test";
import assert from "node:assert/strict";
import CachetExtension from "../lib.js";
const { handleFromX, claimLink, formatState } = CachetExtension;

test("extracts profile handles only from X profile routes", () => {
  assert.equal(handleFromX("https://x.com/Alice/status/12"), "Alice");
  assert.equal(handleFromX("/Bob"), "Bob");
  assert.equal(handleFromX("https://twitter.com/@Carol"), "Carol");
  assert.equal(handleFromX("@Dave"), "Dave");
  assert.equal(handleFromX("https://x.com/messages"), null);
  assert.equal(handleFromX("https://example.com/Alice"), null);
});

test("recognizes only same-site claim URLs with numeric note ids", () => {
  assert.deepEqual(claimLink("https://near-cachet.nearlive.workers.dev/claim?note=42"), {
    id: "42", shareUrl: "https://near-cachet.nearlive.workers.dev/e/42"
  });
  assert.equal(claimLink("https://near-cachet.nearlive.workers.dev/claim?note=x"), null);
  assert.equal(claimLink("https://evil.example/claim?note=42"), null);
});

test("formats a real note state and sats without inventing a value", () => {
  assert.equal(formatState({ state: "Sealed", utxo: { sats: 50000 } }), "Sealed · 50,000 sats");
  assert.equal(formatState({ state: "Minted" }), "Minted");
  assert.equal(formatState(null), "Unavailable");
});
