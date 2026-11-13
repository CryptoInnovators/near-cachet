// Telegram webhook for the Cachet bot. Telegram posts every update to POST /api/telegram with the
// X-Telegram-Bot-Api-Secret-Token header set at setWebhook time; anything else is refused.
// Giver state (the claim links a giver registered with /link) lives in the CACHET_STATE KV namespace.
import { buttonFor, DEFAULT_CONTRACT, envelopeText, liveEnvelopeNotes, parseClaimUrl, parseCommand, statusFromNote } from "../../bot/lib.mjs";

const RPCS = ["https://archival-rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"];
const PKCS8_PREFIX = "302e020100300506032b657004220420";
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));

async function rpc(method, params) {
  let failure;
  for (const url of RPCS) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-telegram", method, params }), signal: AbortSignal.timeout(8000) });
      const payload = await response.json();
      if (payload?.error) { failure = new Error(payload.error.message || "NEAR RPC error"); if (payload.error.code === -429 || /timeout|rate limit/i.test(payload.error.message || "")) continue; throw failure; }
      if (response.ok && payload.result) return payload.result;
      failure = new Error(`NEAR RPC HTTP ${response.status}`);
    } catch (error) { failure = error; }
  }
  throw failure || new Error("No NEAR RPC answered.");
}
async function view(method, args) {
  const result = await rpc("query", { request_type: "call_function", finality: "final", account_id: DEFAULT_CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}
const blockHeight = async () => (await rpc("block", { finality: "final" })).header.height;

// The public key of a claim seed, read the way the contract stores it (64 hex characters).
export async function publicKeyHex(seedHex) {
  const key = await crypto.subtle.importKey("pkcs8", hexBytes(PKCS8_PREFIX + seedHex), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const raw = Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed: ${result.description || response.status}`);
  return result.result;
}

const stateKey = (giver) => `links:${giver}`;
const loadLinks = async (env, giver) => JSON.parse((await env.CACHET_STATE.get(stateKey(giver))) || "{}");
const saveLinks = (env, giver, links) => env.CACHET_STATE.put(stateKey(giver), JSON.stringify(links));

export async function handleMessage(env, message, origin) {
  if (!message?.text?.startsWith("/")) return null;
  const parsed = parseCommand(message.text);
  if (!parsed) return null;
  const chatId = message.chat.id;
  const reply = (text, replyMarkup) => telegram(env, "sendMessage", { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  if (parsed.command === "invalid") return reply("Try /envelope <total-sats> <shares>, /link <note id> <claim url>, or /status <note id>.");
  const giver = String(message.from.id);
  if (parsed.command === "status") return reply(statusFromNote(await view("note", { token_id: parsed.tokenId }), await blockHeight()));
  if (parsed.command === "link") {
    const { tokenId, claimUrl } = parseClaimUrl(parsed.claimUrl, origin);
    if (parsed.tokenId !== tokenId) throw new Error("The note id in the URL must match the /link note id.");
    const note = await view("note", { token_id: tokenId });
    if (!note || note.state !== "Sealed" || !note.claim) throw new Error("That note is not sealed with an active claim link.");
    const seed = new URLSearchParams(new URL(claimUrl).hash.slice(1)).get("key");
    if ((await publicKeyHex(seed)) !== note.claim.key.toLowerCase()) throw new Error("Claim URL key does not match the live note claim.");
    const links = await loadLinks(env, giver);
    links[tokenId] = { claimUrl, sats: Number(note.utxo?.sats || 0), used: false };
    await saveLinks(env, giver, links);
    return reply(`Linked sealed note ${tokenId} (${links[tokenId].sats.toLocaleString("en-US")} sats) to your Telegram account.`);
  }
  const links = await loadLinks(env, giver);
  const notes = await liveEnvelopeNotes(links, parsed.sats, parsed.shares, (tokenId) => view("note", { token_id: tokenId }), await blockHeight(), publicKeyHex);
  if (!notes.length) return reply(`Could not find ${parsed.shares} distinct live sealed notes registered to you totaling exactly ${parsed.sats.toLocaleString("en-US")} sats. No links were consumed.`);
  const me = await telegram(env, "getMe", {});
  const keyboards = notes.map(({ item }) => [buttonFor({ claimUrl: parseClaimUrl(item.claimUrl, origin).claimUrl, botUsername: me.username, appShortname: env.TELEGRAM_APP_SHORTNAME, chatType: message.chat.type })]);
  const sent = await reply(envelopeText({ sats: parsed.sats, shares: parsed.shares, giver: message.from.first_name || message.from.username || "a friend" }), { inline_keyboard: keyboards });
  for (const { item } of notes) item.used = true;
  await saveLinks(env, giver, links);
  return sent;
}

export async function handleTelegram(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  let update;
  try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
  const origin = new URL(request.url).origin;
  try { await handleMessage(env, update.message, origin); }
  catch (error) {
    if (update.message?.chat?.id) await telegram(env, "sendMessage", { chat_id: update.message.chat.id, text: `Could not complete that command: ${error.message}` }).catch(() => {});
  }
  return new Response("ok");
}
