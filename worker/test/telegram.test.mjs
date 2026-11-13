import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { handleTelegram, publicKeyHex } from "../src/telegram.mjs";

const require = createRequire(import.meta.url);
const claim = require("../../web/claim-lib.js");
const SEED = "ab".repeat(32);
const kv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), m }; };
const env = () => ({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "s3cret", TELEGRAM_APP_SHORTNAME: "claim", CACHET_STATE: kv() });
const post = (body, secret = "s3cret") => new Request("https://near-cachet.example/api/telegram", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: JSON.stringify(body) });
const msg = (text) => ({ update_id: 1, message: { text, chat: { id: 9, type: "group" }, from: { id: 42, first_name: "Kamal" } } });

function chain(notes, sent) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).startsWith("https://api.telegram.org/")) { sent.push({ method: String(url).split("/").pop(), body }); return Response.json({ ok: true, result: { username: "cachet_bot" } }); }
    if (body.method === "block") return Response.json({ result: { header: { height: 1000 } } });
    const args = JSON.parse(atob(body.params.args_base64));
    return Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify(notes[args.token_id] ?? null))] } });
  };
}
const note = async (id, sats) => ({ token_id: id, owner_id: "cachet-ops.testnet", state: "Sealed", utxo: { txid: "ff", vout: 0, sats }, claim: { key: await claim.publicKeyHexFromSeed(SEED), expires_at_block: 5000 } });
const link = (id) => `v=2&contract=heir.cachet-ops.testnet&token=${id}&key=${SEED}&sender=cachet-ops.testnet`;

test("a request without the webhook secret is refused", async () => {
  const sent = []; chain({}, sent);
  assert.equal((await handleTelegram(post(msg("/status 1"), null), env())).status, 403);
  assert.equal((await handleTelegram(post(msg("/status 1"), "wrong"), env())).status, 403);
  assert.equal(sent.length, 0);
});

test("publicKeyHex equals the page's claim key derivation", async () => {
  assert.equal(await publicKeyHex(SEED), await claim.publicKeyHexFromSeed(SEED));
});

test("/link registers a live sealed note, /envelope answers with one Mini App button per share", async () => {
  const sent = []; const e = env();
  chain({ 12: await note("12", 1700), 13: await note("13", 1700) }, sent);
  for (const id of ["12", "13"]) assert.equal((await handleTelegram(post(msg(`/link ${id} ${link(id)}`)), e)).status, 200);
  assert.match(sent.at(-1).body.text, /Linked sealed note 13 \(1,700 sats\)/);
  await handleTelegram(post(msg("/envelope 3400 2")), e);
  const out = sent.at(-1);
  assert.equal(out.method, "sendMessage");
  assert.match(out.body.text, /3,400 sats/);
  const buttons = out.body.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 2);
  for (const b of buttons) { assert.match(b.url, /^https:\/\/t\.me\/cachet_bot\/claim\?startapp=/); assert.equal(claim.parseFragment(claim.parseMiniAppStartParam(new URL(b.url).searchParams.get("startapp"))).sender, "cachet-ops.testnet"); }
  assert.ok(Object.values(JSON.parse(e.CACHET_STATE.m.get("links:42"))).every((i) => i.used));
  await handleTelegram(post(msg("/envelope 3400 2")), e);
  assert.match(sent.at(-1).body.text, /Could not find 2 distinct live sealed notes/);
});

test("/link refuses a claim URL whose key is not the note's claim key", async () => {
  const sent = []; const e = env();
  chain({ 12: { ...(await note("12", 1700)), claim: { key: "00".repeat(32), expires_at_block: 5000 } } }, sent);
  await handleTelegram(post(msg(`/link 12 ${link("12")}`)), e);
  assert.match(sent.at(-1).body.text, /does not match the live note claim/);
  assert.equal(e.CACHET_STATE.m.size, 0);
});
