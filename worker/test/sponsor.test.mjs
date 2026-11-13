import test from "node:test";
import assert from "node:assert/strict";
import { handleSponsor, transferBytes, b58encode, b58decode, GRANT, SPONSOR_ID } from "../src/sponsor.mjs";

const SEED = "11".repeat(32);
const ACCOUNT = "ab".repeat(32);
const post = (body) => new Request("https://x/api/sponsor", { method: "POST", body: JSON.stringify(body) });
const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
const viewResult = (value) => ({ result: [...new TextEncoder().encode(JSON.stringify(value))] });

// A fake NEAR RPC: owned notes, balance, and the captured send_tx.
function fakeRpc({ owned, balance }) {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "query" && params.request_type === "call_function") return reply(viewResult(String(owned)));
    if (method === "query" && params.request_type === "view_account") return reply({ amount: String(balance) });
    if (method === "query" && params.request_type === "view_access_key") return reply({ nonce: 41 });
    if (method === "block") return reply({ header: { hash: b58encode(new Uint8Array(32).fill(7)) } });
    if (method === "send_tx") { sent.push(params.signed_tx_base64); return reply({ status: { SuccessValue: "" }, transaction: { hash: "TXHASH" } }); }
    throw new Error(`unexpected ${method}`);
  };
  return { fetchImpl, sent };
}

test("base58 round trips bytes including leading zeros", () => {
  const bytes = Uint8Array.from([0, 0, 5, 255, 1]);
  assert.deepEqual([...b58decode(b58encode(bytes))], [...bytes]);
});

test("transfer bytes carry receiver, nonce and the grant", () => {
  const pk = `ed25519:${b58encode(new Uint8Array(32).fill(3))}`;
  const bytes = transferBytes({ signerId: SPONSOR_ID, publicKey: pk, nonce: 42n, receiverId: ACCOUNT, blockHash: b58encode(new Uint8Array(32).fill(7)), deposit: GRANT });
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes(SPONSOR_ID) && text.includes(ACCOUNT));
  assert.equal(bytes.at(-17), 3, "action tag is Transfer");
  assert.equal(new DataView(bytes.buffer, bytes.length - 16).getBigUint64(0, true), GRANT & 0xffffffffffffffffn);
});

test("an account that owns a note and holds no NEAR is funded with a valid signed transfer", async () => {
  const { fetchImpl, sent } = fakeRpc({ owned: 1, balance: 0 });
  const response = await handleSponsor(post({ account: ACCOUNT }), { SPONSOR_SEED: SEED }, fetchImpl);
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.funded, true); assert.equal(sent.length, 1);
  const signed = Uint8Array.from(atob(sent[0]), (c) => c.charCodeAt(0));
  const tx = signed.slice(0, -65);
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(("302e020100300506032b657004220420" + SEED).match(/../g), (x) => parseInt(x, 16)), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const verify = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", tx));
  assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, verify, signed.slice(-64), digest), "signature verifies against the sponsor key");
  assert.ok(new TextDecoder().decode(tx).includes(ACCOUNT));
});

test("refused without a note, with funds already, with a bad id, or without a configured key", async () => {
  const none = fakeRpc({ owned: 0, balance: 0 });
  assert.equal((await handleSponsor(post({ account: ACCOUNT }), { SPONSOR_SEED: SEED }, none.fetchImpl)).status, 403);
  assert.equal(none.sent.length, 0);
  const rich = fakeRpc({ owned: 1, balance: 10n ** 24n });
  const richBody = await (await handleSponsor(post({ account: ACCOUNT }), { SPONSOR_SEED: SEED }, rich.fetchImpl)).json();
  assert.equal(richBody.funded, false); assert.equal(rich.sent.length, 0);
  assert.equal((await handleSponsor(post({ account: "alice.testnet" }), { SPONSOR_SEED: SEED }, none.fetchImpl)).status, 400);
  assert.equal((await handleSponsor(post({ account: ACCOUNT }), {}, none.fetchImpl)).status, 503);
  assert.equal((await handleSponsor(new Request("https://x/api/sponsor"), { SPONSOR_SEED: SEED }, none.fetchImpl)).status, 405);
});
