import { test } from "node:test";
import assert from "node:assert/strict";
import sealLib from "./seal.js";

const hash = "0000000000f98b9ac91fb4e1b9b3e86b4b9409409d06e5e38edc43d629790b2b";
const txid = "35784fb7705de7a4da2d6d98fb808c28cae0d334f89e08b5dcd0fe0f8e2f3885";
const sealed = (blockHash = hash, id = txid) => sealLib.seal({ blockHash, txid: id, state: "Sealed", token: "42" });

test("renders deterministic proof ticks and wax", () => {
  assert.equal(sealLib.leadingZeros(hash), 10);
  const svg = sealed();
  assert.doesNotMatch(svg, /data-i="[0-9]"/);
  assert.match(svg, /data-i="10" data-n="15"/);
  assert.equal((svg.match(/class="seal-tick"/g) || []).length, 64 - sealLib.nibbles(hash).filter((n) => n === 0).length);
  assert.equal(sealed(), svg);
  assert.notEqual(sealed(hash.replace("f", "e")), svg);
  assert.notEqual(sealed(hash, txid.replace("3", "2")), svg);
  assert.equal(sealLib.rim(txid).length, 48);
  assert.ok(sealLib.rim(txid).every((r) => r >= 104 && r <= 116));
});

test("renders Minted and split Unsealed states", () => {
  const minted = sealLib.seal({ state: "Minted", token: "42" });
  assert.doesNotMatch(minted, /class="seal-tick"/);
  assert.match(minted, /seal-die/);
  const broken = sealLib.seal({ blockHash: hash, txid, state: "Unsealed", token: "42" });
  assert.match(broken, /seal-half-a/);
  assert.match(broken, /seal-half-b/);
  assert.match(broken, /id="seal-clip-a35784fb7"/);
  assert.match(broken, /id="seal-clip-b35784fb7"/);
  assert.doesNotMatch(sealed(), /seal-half|clipPath/);
});

test("validates input and emits no effects", () => {
  assert.throws(() => sealLib.nibbles("bad"), { message: "blockHash must be 64 hex characters" });
  assert.throws(() => sealLib.seal({ state: "Other" }), /unknown state: Other/);
  assert.doesNotMatch(sealed(), /gradient|filter|shadow/);
});
