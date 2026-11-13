// Telegram Mini App initData validation (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
// secret = HMAC_SHA256(key "WebAppData", message bot token); hash = hex HMAC_SHA256(secret, data-check-string).
const enc = new TextEncoder();
const hmac = async (keyBytes, message) => {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
};
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// Returns { ok: true, user, authDate } or { ok: false, reason }. Never throws on malformed input.
export async function validateInitData(initData, botToken, { maxAgeSeconds = 86400, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!botToken) return { ok: false, reason: "The bot token is not configured." };
  if (typeof initData !== "string" || !initData) return { ok: false, reason: "Missing Telegram initData." };
  const params = new URLSearchParams(initData);
  const given = params.get("hash");
  if (!/^[0-9a-f]{64}$/.test(given || "")) return { ok: false, reason: "initData has no valid hash." };
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const expected = hex(await hmac(secret, check));
  let diff = expected.length ^ given.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  if (diff !== 0) return { ok: false, reason: "initData signature does not match this bot." };
  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: "initData has no auth_date." };
  if (now - authDate > maxAgeSeconds) return { ok: false, reason: "initData is older than a day; reopen the Mini App." };
  if (authDate - now > 300) return { ok: false, reason: "initData is dated in the future." };
  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch { /* user stays null */ }
  return { ok: true, user, authDate };
}

// Borsh header of a signed NEAR transaction: signer_id, public key, nonce, receiver_id.
export function transactionHeader(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  let at = 0;
  const readString = () => { const len = view.getUint32(at, true); at += 4; const s = new TextDecoder().decode(bytes.slice(at, at + len)); at += len; return s; };
  const signerId = readString();
  at += 1 + 32;
  at += 8;
  const receiverId = readString();
  return { signerId, receiverId };
}

// POST /api/tma/send {init_data, signed_tx_base64}: the only write path the Mini App uses. A call without valid
// initData, or a transaction to any contract but the Cachet one, is refused before it reaches NEAR.
export async function handleTmaSend(request, env, { contract, rpc }) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const checked = await validateInitData(body?.init_data, env.TELEGRAM_BOT_TOKEN);
  if (!checked.ok) return json({ error: checked.reason, code: "telegram_initdata_refused" }, 401);
  let header;
  try { header = transactionHeader(String(body.signed_tx_base64 || "")); } catch { return json({ error: "Not a signed NEAR transaction." }, 400); }
  if (header.receiverId !== contract) return json({ error: `The Mini App only sends transactions to ${contract}.` }, 403);
  try { return json({ result: await rpc("send_tx", { signed_tx_base64: body.signed_tx_base64, wait_until: body.wait_until || "EXECUTED_OPTIMISTIC" }), telegram_user: checked.user?.id ?? null }); }
  catch (error) { return json({ error: error.message }, 502); }
}
