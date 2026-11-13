// Connect HOT: the named heir signs in with the wallet Telegram users already hold (HOT, through NEAR Connect on
// mainnet). The Mini App asks /api/hot/challenge for a nonce, the wallet signs a NEP-413 message over it, and
// /api/hot/verify checks the Ed25519 signature and that the signing key is a live access key of the account on
// NEAR mainnet. Nothing is signed or sent on mainnet: this is a sign-in message, not a transaction.
import { b58decode } from "./sponsor.mjs";

export const HOT_RECIPIENT = "near-cachet.earn-shield-alerts.workers.dev";
export const HOT_MESSAGE = "Connect HOT to Cachet";
const MAINNET_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://free.rpc.fastnear.com"];
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const NEP413_TAG = 2147484061; // 2^31 + 413

const enc = new TextEncoder();
const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function mac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hexOf(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text))));
}

// Stateless challenge: a random 32 byte nonce plus a timestamp, bound by an HMAC under the bot token, so a nonce the worker did not issue is refused.
export async function issueChallenge(secret, now = Date.now()) {
  const nonce = hexOf(crypto.getRandomValues(new Uint8Array(32)));
  return { nonce, issued_at: now, mac: await mac(secret, `hot:${nonce}:${now}`), message: HOT_MESSAGE, recipient: HOT_RECIPIENT };
}

const borshString = (s) => { const b = enc.encode(s); const out = new Uint8Array(4 + b.length); new DataView(out.buffer).setUint32(0, b.length, true); out.set(b, 4); return out; };

// The bytes a NEP-413 wallet signs: sha256(u32le(2^31+413) ++ borsh({message, nonce[32], recipient, callbackUrl: None})).
export async function nep413Hash({ message, nonce, recipient }) {
  const tag = new Uint8Array(4); new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const parts = [tag, borshString(message), nonce, borshString(recipient), Uint8Array.of(0)];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function decodeSignature(value) {
  const text = String(value || "");
  if (text.startsWith("ed25519:")) return b58decode(text.slice(8));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifySignedMessage({ publicKey, signature, nonce, message = HOT_MESSAGE, recipient = HOT_RECIPIENT }) {
  const pub = b58decode(String(publicKey || "").replace(/^ed25519:/, ""));
  if (pub.length !== 32) return false;
  const sig = decodeSignature(signature);
  if (sig.length !== 64) return false;
  const hash = await nep413Hash({ message, nonce: fromHex(nonce), recipient });
  const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, sig, hash);
}

async function mainnetAccessKey(fetchImpl, accountId, publicKey) {
  let failure;
  for (const url of MAINNET_RPCS) {
    try {
      const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-hot", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }), signal: AbortSignal.timeout(10000) });
      const payload = await response.json();
      if (payload?.result?.permission) return payload.result;
      if (payload?.error?.cause?.name === "UNKNOWN_ACCESS_KEY" || payload?.error?.cause?.name === "UNKNOWN_ACCOUNT") return null;
      failure = new Error(payload?.error?.message || `NEAR mainnet RPC HTTP ${response.status}`);
    } catch (error) { failure = error; }
  }
  throw failure || new Error("No NEAR mainnet RPC answered.");
}

// POST /api/hot/verify {account_id, public_key, signature, nonce, issued_at, mac}
export async function handleHotVerify(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const accountId = String(body.account_id || "");
  const nonce = String(body.nonce || "");
  if (!/^[a-f0-9]{64}$/.test(nonce) || !Number.isFinite(Number(body.issued_at))) return json({ error: "The challenge is malformed." }, 400);
  if (now - Number(body.issued_at) > CHALLENGE_TTL_MS || Number(body.issued_at) > now + 60000) return json({ error: "The challenge expired. Connect again." }, 401);
  if (body.mac !== await mac(env.TELEGRAM_BOT_TOKEN, `hot:${nonce}:${body.issued_at}`)) return json({ error: "The challenge was not issued by this worker." }, 401);
  let ok = false;
  try { ok = await verifySignedMessage({ publicKey: body.public_key, signature: body.signature, nonce }); } catch { ok = false; }
  if (!ok) return json({ error: "The signature does not match the message." }, 401);
  let key;
  try { key = await mainnetAccessKey(fetchImpl, accountId, String(body.public_key)); } catch (error) { return json({ error: `NEAR mainnet could not be read: ${error.message}` }, 502); }
  if (!key) return json({ error: `${accountId} has no such access key on NEAR mainnet.` }, 401);
  return json({ verified: true, account_id: accountId, public_key: body.public_key, network: "mainnet", block_height: key.block_height, permission: typeof key.permission === "string" ? key.permission : "FunctionCall" });
}

export async function handleHotChallenge(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Sign-in is not configured." }, 503);
  return json(await issueChallenge(env.TELEGRAM_BOT_TOKEN));
}
