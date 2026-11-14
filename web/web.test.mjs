import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const chain = require("./chain.js");
globalThis.cachetChain = chain;
const outcome = require("./outcome.js");
const btc = require("./btc-proof.js");
require("./app.js");
const app = globalThis.cachetInternals;
const claim = require("./claim-lib.js");
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

test("address derivation matches every vector", () => {
  assert.ok(vectors.address.length >= 2);
  for (const v of vectors.address) {
    const d = app.pubkeyToAddress(v.signerKey, v.hrp);
    assert.equal(d.compressedHex, v.compressed, v.source);
    assert.equal(d.address, v.address, v.source);
  }
});

test("a flipped key byte changes the address", () => {
  const v = vectors.address[0];
  const at = 20;
  const bad = v.signerKey.slice(0, at) + (v.signerKey[at] === "2" ? "3" : "2") + v.signerKey.slice(at + 1);
  let moved;
  try {
    moved = app.pubkeyToAddress(bad, v.hrp).address !== v.address;
  } catch {
    moved = true;
  }
  assert.ok(moved);
});

test("claim signature reproduces the vector byte for byte", async () => {
  const c = vectors.claim;
  assert.equal(await claim.publicKeyHexFromSeed(c.seed), c.publicKey);
  assert.equal(claim.claimMessage(c.contract, c.token, c.newOwner), c.message);
  assert.equal(await claim.signClaim(c.seed, c.contract, c.token, c.newOwner), c.signature);
});

test("a signature for one receiver is not the signature for another", async () => {
  const c = vectors.claim;
  assert.notEqual(await claim.signClaim(c.seed, c.contract, c.token, "carol.test.near"), c.signature);
});

test("fragment round trip and rejection of a malformed secret", () => {
  const f = { contract: "cachet.near", token: "7", key: "ab".repeat(32) };
  assert.deepEqual(claim.parseFragment("#" + claim.buildFragment(f)), f);
  assert.equal(claim.parseFragment("#v=1&contract=cachet.near&token=7&key=zz"), null);
  assert.equal(claim.parseFragment(""), null);
});

test("a fresh link is a random 32 byte seed with a matching public key", async () => {
  const a = claim.newSeedHex();
  const b = claim.newSeedHex();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.match(await claim.publicKeyHexFromSeed(a), /^[0-9a-f]{64}$/);
});

test("vendored NEAR Connect bytes match the pinned checksum", () => {
  const source = readFileSync(new URL("./vendor/near-connect-0.12.0.mjs", import.meta.url));
  const expected = readFileSync(new URL("./vendor/SHA256SUMS", import.meta.url), "utf8").trim().split(/\s+/)[0];
  assert.equal(createHash("sha256").update(source).digest("hex"), expected);
});

test("network defaults to testnet and mainnet has no recycle destination", async () => {
  assert.equal(chain.network("").contract, "heir.cachet-ops.testnet");
  const mainnet = chain.network("?network=mainnet");
  assert.equal(mainnet.contract, "cachet.near");
  assert.equal(await chain.defaultDestination(mainnet), null);
});

test("funding address is visible only while Minted", () => {
  assert.equal(outcome.fundingAddressVisible({ state: "Minted" }), true);
  assert.equal(outcome.fundingAddressVisible({ state: "Sealed" }), false);
  assert.equal(outcome.fundingAddressVisible(null), false);
});

test("funding block comparison rejects a tampered mempool hash", () => {
  const note = { utxo: { block_hash: "ab".repeat(32) } };
  assert.equal(outcome.blockHashMismatch(note, { status: { block_hash: "ab".repeat(32) } }), null);
  assert.match(outcome.blockHashMismatch(note, { status: { block_hash: "cd".repeat(32) } }), /Block hash mismatch/);
});

test("fee guard passes the contract's minimum and rejects one sat below it", () => {
  const dust = 5 * 110 + 546;
  assert.equal(outcome.feeGuard(dust, 5, 22), null);
  assert.match(outcome.feeGuard(dust - 1, 5, 22), /at least/);
  for (const len of [22, 25, 34]) {
    assert.equal(Math.floor((4 * (60 + len) + 110 + 3) / 4), [110, 113, 122][[22, 25, 34].indexOf(len)]);
  }
});

test("recorded mempool proof maps to the reviewed live light-client vector", async () => {
  const dir = new URL("./fixtures/mempool-974135/", import.meta.url);
  const fixture = (name) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
  const fixtureText = (name) => readFileSync(new URL(name, dir), "utf8").trim();
  const vector = JSON.parse(readFileSync(new URL("../tests/vectors/lc_mainnet_974135.json", import.meta.url), "utf8"));
  const captured = {
    [`/tx/${vector.txid}`]: fixture("tx.json"),
    [`/tx/${vector.txid}/merkle-proof`]: fixture("merkle.json"),
    [`/block/${vector.block_hash}/txid/0`]: fixtureText("coinbase-txid.json"),
    [`/tx/${vector.coinbase_tx_id}/merkle-proof`]: fixture("coinbase-merkle.json"),
  };
  const get = async (_base, path) => captured[path];
  const proof = await btc.inclusionProof("https://mempool.space", vector.txid, get, get);
  assert.deepEqual(proof, { block_hash: vector.block_hash, tx_index: vector.tx_index, merkle_proof: vector.merkle_proof, coinbase_tx_id: vector.coinbase_tx_id, coinbase_merkle_proof: vector.coinbase_merkle_proof });
});

test("rpc moves to the next provider on a 429, remembers it, and does not retry a contract error", async () => {
  const real = globalThis.fetch;
  const net = { name: "fallback-test", rpc: "https://a.example", rpcs: ["https://a.example", "https://b.example"] };
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://a.example")) return reply(429, { error: { code: -429, message: "Rate limits exceeded" } });
    return reply(200, { result: { ok: true } });
  };
  try {
    assert.deepEqual(await chain.rpc("status", [], net), { ok: true });
    assert.deepEqual(calls, ["https://a.example", "https://b.example"]);
    calls.length = 0;
    await chain.rpc("status", [], net);
    assert.deepEqual(calls, ["https://b.example"], "the provider that answered last goes first");
    globalThis.fetch = async (url) => { calls.push(String(url)); return reply(200, { error: { name: "HANDLER_ERROR", message: "contract panicked" } }); };
    calls.length = 0;
    await assert.rejects(chain.rpc("query", {}, net), /contract panicked/);
    assert.equal(calls.length, 1, "a contract error is final, not a reason to try another provider");
  } finally { globalThis.fetch = real; }
});

test("rpc override parameter replaces the provider list and must be https", () => {
  assert.deepEqual(chain.network("?network=testnet&rpc=https://near-testnet.drpc.org").rpcs, ["https://near-testnet.drpc.org"]);
  assert.deepEqual(chain.network("?rpc=http://evil.example").rpcs, chain.NETWORKS.testnet.rpcs);
});

test("affordableRate keeps the default fee payable from the note and never rises above the wanted rate", () => {
  assert.equal(outcome.affordableRate(1000, 22, 5), 4);
  assert.equal(outcome.affordableRate(1100, 22, 5), 5);
  assert.equal(outcome.affordableRate(50000, 22, 5), 5);
  assert.equal(outcome.affordableRate(600, 22, 5), 1);
  assert.equal(outcome.feeGuard(1000, outcome.affordableRate(1000, 22, 5), 22), null);
});

test("sweepVsize matches the contract formula for each script length", () => {
  assert.deepEqual([22, 25, 34].map(outcome.sweepVsize), [110, 113, 122]);
});

test("pickJudgeFragment skips spent and foreign notes and returns the first sealed one with a claim", async () => {
  const frag = (token, contract = "cachet.testnet") => ({ fragment: claim.buildFragment({ contract, token, key: "ab".repeat(32) }) });
  const notes = { 1: { state: "Unsealed", claim: null }, 2: { state: "Sealed", claim: null }, 3: { state: "Sealed", claim: { key: "k" } }, 4: { state: "Sealed", claim: { key: "k" } } };
  const read = async (f) => notes[f.token];
  const net = { contract: "cachet.testnet" };
  assert.equal(await claim.pickJudgeFragment(net, read, [frag("1"), frag("2"), frag("9", "other.testnet"), frag("3"), frag("4")]), frag("3").fragment);
  assert.equal(await claim.pickJudgeFragment(net, read, [frag("1"), frag("2")]), null);
});

test("signAndSend waits for a just-funded account whose key the RPC reports as an error result or a Server error", async () => {
  globalThis.cachetClaim = claim;
  const linkdrop = require("./linkdrop-claim.js");
  const seed = "11".repeat(32);
  const pub = await claim.publicKeyHexFromSeed(seed);
  const calls = [];
  const net = { name: "testnet", rpc: "https://rpc.invalid" };
  const real = chain.rpc;
  chain.rpc = async (method, params) => {
    calls.push(method === "query" ? params.request_type : method);
    if (method === "query" && calls.filter((m) => m === "view_access_key").length === 2) { const e = new Error("Server error"); e.rpc = { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } }; throw e; }
    if (method === "query") return calls.filter((m) => m === "view_access_key").length < 4 ? { error: "access key does not exist while viewing", block_height: 1 } : { nonce: 7, permission: "FullAccess" };
    if (method === "block") return { header: { hash: linkdrop.b58encode(new Uint8Array(32).fill(5)) } };
    if (method === "send_tx") return { transaction: { hash: "txhash" }, status: { SuccessValue: "" } };
    throw new Error(method);
  };
  try {
    const result = await linkdrop.signAndSend({ signerId: pub, seedHex: seed, contract: "cachet.testnet", args: { receiver_id: "a", token_id: "1" }, net, method: "nft_transfer", tgas: 30, restricted: false, deposit: 1n, waitForAccountMs: 8000 });
    assert.equal(result.transaction.hash, "txhash");
    assert.equal(calls.filter((m) => m === "view_access_key").length, 4);
  } finally { chain.rpc = real; }
});

test("rpc tries the next provider on a bare Server error but keeps a Server error that names its cause", async () => {
  const real = globalThis.fetch;
  const net = { name: "server-error-test", rpc: "https://a.example", rpcs: ["https://a.example", "https://b.example"] };
  const calls = [];
  const reply = (body) => new Response(JSON.stringify(body), { status: 200 });
  try {
    globalThis.fetch = async (url) => { calls.push(String(url)); return String(url).startsWith("https://a.example") ? reply({ error: { code: -32000, message: "Server error" } }) : reply({ result: { ok: true } }); };
    assert.deepEqual(await chain.rpc("query", {}, net), { ok: true });
    assert.deepEqual(calls, ["https://a.example", "https://b.example"]);
    calls.length = 0;
    globalThis.fetch = async (url) => { calls.push(String(url)); return reply({ error: { code: -32000, message: "Server error", cause: { name: "UNKNOWN_ACCOUNT" } } }); };
    await assert.rejects(chain.rpc("query", {}, { ...net, name: "server-error-test-2" }), (error) => error.rpc?.cause?.name === "UNKNOWN_ACCOUNT");
    assert.equal(calls.length, 1, "an answer that names its cause is final");
  } finally { globalThis.fetch = real; }
});
