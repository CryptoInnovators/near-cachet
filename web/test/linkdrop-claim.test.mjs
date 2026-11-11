import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.cachetClaim = require("../claim-lib.js");
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

test("claim key is added only for a sealed note that has not been claimed", () => {
  assert.equal(linkdrop.canAddClaimKey({ state: "Sealed", claim: null }), true);
  assert.equal(linkdrop.canAddClaimKey({ state: "Sealed", claim: { key: "ab".repeat(32) } }), false);
  assert.equal(linkdrop.canAddClaimKey({ state: "Unsealed", claim: null }), false);
  assert.equal(linkdrop.canAddClaimKey(null), false);
});

test("walletless claim key is a NEAR 64-byte Ed25519 secret key and needs backup acknowledgement", async () => {
  const seed = "01".repeat(32);
  const encoded = await linkdrop.secretKeyString(seed);
  const secret = linkdrop.b58decode(encoded.replace(/^ed25519:/, ""));
  assert.equal(secret.length, 64);
  assert.equal(Buffer.from(secret.slice(0, 32)).toString("hex"), seed);
  assert.equal(Buffer.from(secret.slice(32)).toString("hex"), await cachetClaim.publicKeyHexFromSeed(seed));

  let sent = false;
  await assert.rejects(linkdrop.submitWalletlessClaim({ acknowledged: false, send: () => { sent = true; } }), /Back up/);
  assert.equal(sent, false);
  await linkdrop.submitWalletlessClaim({ acknowledged: true, send: () => { sent = true; } });
  assert.equal(sent, true);
});

test("claim broadcast uses send_tx", async () => {
  const calls = [];
  const entry = { nonce: "7", permission: { FunctionCall: { receiver_id: "cachet.testnet", method_names: ["claim"], allowance: "150000000000000000000000" } } };
  const blockHash = linkdrop.b58encode(new Uint8Array(32).fill(1));
  globalThis.cachetChain = {
    rpc: async (method, params, net) => {
      calls.push({ method, params, net });
      if (method === "query") return entry;
      if (method === "block") return { header: { hash: blockHash } };
      if (method === "send_tx") return { final_execution_status: "FINAL" };
      throw new Error(`unexpected method ${method}`);
    },
  };
  try {
    const net = { name: "testnet", rpc: "https://example.test" };
    const args = { token_id: "17", new_owner: "a".repeat(64), signature: "ab".repeat(64) };
    await linkdrop.signAndSend({ signerId: "sender.testnet", seedHex: "01".repeat(32), contract: "cachet.testnet", args, net });
  } finally {
    delete globalThis.cachetChain;
  }
  const broadcast = calls.find((c) => c.method === "send_tx" || c.method === "broadcast_tx_commit");
  assert.equal(broadcast.method, "send_tx");
  assert.equal(typeof broadcast.params.signed_tx_base64, "string");
  assert.ok(broadcast.params.signed_tx_base64.length > 0);
  assert.equal(broadcast.params.wait_until, "EXECUTED_OPTIMISTIC");
  assert.equal(calls.some((c) => c.method === "broadcast_tx_commit"), false);
});
