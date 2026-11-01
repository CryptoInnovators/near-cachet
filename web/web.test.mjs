import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
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
