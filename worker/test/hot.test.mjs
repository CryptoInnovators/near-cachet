import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { issueChallenge, handleHotVerify, HOT_MESSAGE, HOT_RECIPIENT } from "../src/hot.mjs";
import { b58encode } from "../src/sponsor.mjs";

const SECRET = "123456:TEST-bot-token-for-hmac";
const NOW = 1_800_000_000_000;
// Independent NEP-413 signer written from the spec with node:crypto, not from the worker code.
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, publicKey: `ed25519:${b58encode(raw)}` };
}
function signNep413(privateKey, { message, nonceHex, recipient }) {
  const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
  const payload = Buffer.concat([tag, str(message), Buffer.from(nonceHex, "hex"), str(recipient), Buffer.from([0])]);
  return nodeSign(null, createHash("sha256").update(payload).digest(), privateKey).toString("base64");
}
const request = (body) => new Request("https://x.test/api/hot/verify", { method: "POST", body: JSON.stringify(body) });
const chain = (ok) => async () => new Response(JSON.stringify(ok ? { result: { permission: "FullAccess", nonce: 1, block_height: 190000000 } } : { error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } }));
async function setup(overrides = {}) {
  const w = wallet();
  const c = await issueChallenge(SECRET, NOW);
  const body = { account_id: "heir.near", public_key: w.publicKey, signature: signNep413(w.privateKey, { message: HOT_MESSAGE, nonceHex: c.nonce, recipient: HOT_RECIPIENT }), nonce: c.nonce, issued_at: c.issued_at, mac: c.mac, ...overrides };
  return { w, c, body };
}

test("a wallet signature over the issued challenge, from a live access key, signs the heir in", async () => {
  const { body } = await setup();
  const res = await handleHotVerify(request(body), { TELEGRAM_BOT_TOKEN: SECRET }, { fetchImpl: chain(true), now: NOW + 1000 });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.verified, true);
  assert.equal(out.account_id, "heir.near");
  assert.equal(out.network, "mainnet");
});

test("a signature over a different message is refused", async () => {
  const w = wallet();
  const c = await issueChallenge(SECRET, NOW);
  const body = { account_id: "heir.near", public_key: w.publicKey, signature: signNep413(w.privateKey, { message: "Send me your funds", nonceHex: c.nonce, recipient: HOT_RECIPIENT }), nonce: c.nonce, issued_at: c.issued_at, mac: c.mac };
  const res = await handleHotVerify(request(body), { TELEGRAM_BOT_TOKEN: SECRET }, { fetchImpl: chain(true), now: NOW + 1000 });
  assert.equal(res.status, 401);
});

test("a signature from a key the account does not hold on mainnet is refused", async () => {
  const { body } = await setup();
  const res = await handleHotVerify(request(body), { TELEGRAM_BOT_TOKEN: SECRET }, { fetchImpl: chain(false), now: NOW + 1000 });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /no such access key/);
});

test("a nonce the worker did not issue, or an expired one, is refused", async () => {
  const forged = await setup({ mac: "0".repeat(64) });
  assert.equal((await handleHotVerify(request(forged.body), { TELEGRAM_BOT_TOKEN: SECRET }, { fetchImpl: chain(true), now: NOW + 1000 })).status, 401);
  const stale = await setup();
  assert.equal((await handleHotVerify(request(stale.body), { TELEGRAM_BOT_TOKEN: SECRET }, { fetchImpl: chain(true), now: NOW + 6 * 60 * 1000 })).status, 401);
});
