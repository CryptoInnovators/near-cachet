import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const linkdrop = require("../linkdrop-claim.js");

test("link key permits exactly claim on its configured contract", () => {
  const key = { permission: { FunctionCall: { receiver_id: "cachet.testnet", method_names: ["claim"], allowance: "150000000000000000000000" } } };
  assert.equal(linkdrop.assertClaimKey(key, "cachet.testnet"), true);
  assert.throws(() => linkdrop.assertClaimKey(key, "other.testnet"), /not restricted/);
  assert.throws(() => linkdrop.assertClaimKey({ permission: { FunctionCall: { receiver_id: "cachet.testnet", method_names: ["claim", "unseal"] } } }, "cachet.testnet"), /not restricted/);
  assert.throws(() => linkdrop.assertClaimKey({ permission: { FunctionCall: { receiver_id: "cachet.testnet", method_names: [] } } }, "cachet.testnet"), /not restricted/);
  assert.throws(() => linkdrop.assertClaimKey({ permission: { FunctionCall: { receiver_id: "cachet.testnet", method_names: ["claim"], allowance: "50000000000000000000000" } } }, "cachet.testnet"), /not restricted/);
});

test("claim transaction serializes one zero-deposit claim call to the named contract", () => {
  const args = { token_id: "17", new_owner: "a".repeat(64), signature: "ab".repeat(64) };
  const bytes = linkdrop.transactionBytes({
    signerId: "sender.testnet", publicKey: "1".repeat(32), nonce: 9,
    receiverId: "cachet.testnet", blockHash: "1".repeat(32), args,
  });
  let at = 0;
  const u32 = () => { const n = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true); at += 4; return n; };
  const str = () => { const size = u32(); const value = new TextDecoder().decode(bytes.slice(at, at + size)); at += size; return value; };
  const vec = () => { const size = u32(); const value = bytes.slice(at, at + size); at += size; return value; };
  assert.equal(str(), "sender.testnet");
  assert.equal(bytes[at++], 0, "public key is Ed25519");
  assert.equal(bytes.slice(at, at + 32).length, 32); at += 32;
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0, true), 9n); at += 8;
  assert.equal(str(), "cachet.testnet");
  assert.equal(bytes.slice(at, at + 32).length, 32); at += 32;
  assert.equal(u32(), 1, "one action");
  assert.equal(bytes[at++], 2, "FunctionCall action");
  assert.equal(str(), "claim");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(vec())), args);
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0, true), 100_000_000_000_000n); at += 8;
  assert.deepEqual([...bytes.slice(at)], Array(16).fill(0), "zero attached deposit");
  at += 16;
  assert.equal(at, bytes.length);
});

test("already-claimed or mismatched shares are refused before signing", () => {
  const open = { state: "Sealed", claim: { key: "ab".repeat(32) } };
  assert.equal(linkdrop.assertUnclaimed(open, "ab".repeat(32)), true);
  assert.throws(() => linkdrop.assertUnclaimed({ ...open, claim: null }, "ab".repeat(32)), /already been claimed/);
  assert.throws(() => linkdrop.assertUnclaimed(open, "cd".repeat(32)), /already been claimed/);
  assert.throws(() => linkdrop.assertUnclaimed({ ...open, state: "Minted" }, "ab".repeat(32)), /not sealed/);
});
