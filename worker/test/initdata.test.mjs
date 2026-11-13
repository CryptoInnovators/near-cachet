import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validateInitData, handleTmaSend, transactionHeader } from "../src/initdata.mjs";

const TOKEN = "123456:TEST-bot-token-for-hmac";
const NOW = 1_800_000_000;
// Builds initData the way Telegram does, from the documented algorithm, with node:crypto (independent of the worker code).
function sign(fields, token = TOKEN) {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const fields = { auth_date: String(NOW - 60), query_id: "AAH", user: JSON.stringify({ id: 42, first_name: "Test" }) };
const tx = (receiver) => {
  const str = (s) => { const b = new TextEncoder().encode(s); const o = new Uint8Array(4 + b.length); new DataView(o.buffer).setUint32(0, b.length, true); o.set(b, 4); return o; };
  const parts = [str("signer.testnet"), new Uint8Array(33), new Uint8Array(8), str(receiver), new Uint8Array(64)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return btoa(String.fromCharCode(...out));
};
const post = (body) => new Request("https://x/api/tma/send", { method: "POST", body: JSON.stringify(body) });
const sent = [];
const deps = { contract: "heir.cachet-ops.testnet", rpc: async (method, params) => { sent.push(method); return { status: { SuccessValue: "" }, transaction: { hash: "H" } }; } };
const env = { TELEGRAM_BOT_TOKEN: TOKEN };

test("valid initData from this bot is accepted", async () => {
  const r = await validateInitData(sign(fields), TOKEN, { now: NOW });
  assert.equal(r.ok, true); assert.equal(r.user.id, 42);
});
test("tampered field, other bot's signature, missing hash, empty and stale initData are all refused", async () => {
  const good = sign(fields);
  assert.equal((await validateInitData(good.replace("Test", "Evil"), TOKEN, { now: NOW })).ok, false);
  assert.equal((await validateInitData(sign(fields, "999:other"), TOKEN, { now: NOW })).ok, false);
  assert.equal((await validateInitData(good.replace(/hash=[0-9a-f]+/, ""), TOKEN, { now: NOW })).ok, false);
  assert.equal((await validateInitData("", TOKEN, { now: NOW })).ok, false);
  assert.equal((await validateInitData(undefined, TOKEN, { now: NOW })).ok, false);
  assert.equal((await validateInitData(sign({ ...fields, auth_date: String(NOW - 90000) }), TOKEN, { now: NOW })).ok, false);
});
test("/api/tma/send relays a valid call and never reaches NEAR for an invalid one", async () => {
  sent.length = 0;
  const initData = sign({ ...fields, auth_date: String(Math.floor(Date.now() / 1000) - 5) });
  const ok = await handleTmaSend(post({ init_data: initData, signed_tx_base64: tx("heir.cachet-ops.testnet") }), env, deps);
  assert.equal(ok.status, 200); assert.deepEqual(sent, ["send_tx"]);
  sent.length = 0;
  const noData = await handleTmaSend(post({ signed_tx_base64: tx("heir.cachet-ops.testnet") }), env, deps);
  assert.equal(noData.status, 401);
  const forged = await handleTmaSend(post({ init_data: initData.replace("Test", "Evil"), signed_tx_base64: tx("heir.cachet-ops.testnet") }), env, deps);
  assert.equal(forged.status, 401);
  const wrongContract = await handleTmaSend(post({ init_data: initData, signed_tx_base64: tx("someone-else.testnet") }), env, deps);
  assert.equal(wrongContract.status, 403);
  assert.deepEqual(sent, [], "a refused call must not reach send_tx");
});
test("/api/tma/send answers 200 with an error body when every provider fails, so the page retries without a failed request in the console", async () => {
  const initData = sign({ ...fields, auth_date: String(Math.floor(Date.now() / 1000) - 5) });
  const down = await handleTmaSend(post({ init_data: initData, signed_tx_base64: tx("heir.cachet-ops.testnet") }), env, { contract: "heir.cachet-ops.testnet", rpc: async () => { throw new Error("NEAR RPC HTTP 429"); } });
  assert.equal(down.status, 200);
  const body = await down.json();
  assert.equal(body.code, "relay_unavailable"); assert.match(body.error, /429/);
});
test("transactionHeader reads signer and receiver", () => {
  assert.deepEqual(transactionHeader(tx("heir.cachet-ops.testnet")), { signerId: "signer.testnet", receiverId: "heir.cachet-ops.testnet" });
});

test("isTransientRpcError retries rate limits, timeouts and a bare Server error but not a contract refusal", async () => {
  const { isTransientRpcError } = await import("../src/initdata.mjs");
  assert.equal(isTransientRpcError({ code: -429, message: "rate limit" }), true);
  assert.equal(isTransientRpcError({ code: -32000, message: "Server error" }), true);
  assert.equal(isTransientRpcError({ code: -32000, message: "Server error", data: "Exceeded the prepaid gas" }), false);
  assert.equal(isTransientRpcError({ code: -32000, message: "Server error", data: { TxExecutionError: 1 } }), false);
  assert.equal(isTransientRpcError(null), false);
});
