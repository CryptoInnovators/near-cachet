// Network-fee sponsor for a holder's claim account. A claim account is an implicit account that has never held NEAR,
// so it cannot pay for passing its note on. POST /api/sponsor {account} sends it a small transfer from the sponsor
// account, and only when the account owns a note on the contract and holds almost no NEAR.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PKCS8_PREFIX = "302e020100300506032b657004220420";
const RPCS = ["https://archival-rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"];
export const SPONSOR_ID = "cachet-sponsor.testnet";
export const CONTRACT = "heir.cachet-ops.testnet";
export const GRANT = 400_000_000_000_000_000_000_000n; // 0.4 NEAR: an unseal prepays 300 Tgas (0.3 NEAR at the current gas price), the unused part comes back
export const LOW_WATER = 350_000_000_000_000_000_000_000n; // under 0.35 NEAR cannot prepay an unseal

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const u32 = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n, true); return a; };
const u64 = (n) => { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(n), true); return a; };
const u128 = (n) => { const a = new Uint8Array(16); const v = new DataView(a.buffer); v.setBigUint64(0, BigInt(n) & 0xffffffffffffffffn, true); v.setBigUint64(8, BigInt(n) >> 64n, true); return a; };
const str = (s) => { const b = new TextEncoder().encode(s); return concat(u32(b.length), b); };

export function b58decode(value) {
  let n = 0n;
  for (const ch of value) { const i = ALPHABET.indexOf(ch); if (i < 0) throw new Error("Invalid base58."); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = `0${hex}`;
  const body = n === 0n ? new Uint8Array() : hexBytes(hex);
  const zeros = value.match(/^1*/)[0].length;
  return concat(new Uint8Array(zeros), body);
}
export function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = ""; while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(bytes.findIndex((b) => b !== 0) < 0 ? bytes.length : bytes.findIndex((b) => b !== 0)) + out;
}

// Borsh bytes of a one-action Transfer transaction.
export function transferBytes({ signerId, publicKey, nonce, receiverId, blockHash, deposit }) {
  const pk = b58decode(publicKey.replace(/^ed25519:/, ""));
  const hash = b58decode(blockHash);
  if (pk.length !== 32 || hash.length !== 32) throw new Error("Invalid access key or block hash.");
  return concat(str(signerId), Uint8Array.of(0), pk, u64(nonce), str(receiverId), hash, u32(1), Uint8Array.of(3), u128(deposit));
}

const ROUNDS = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Tries every provider, and when all of them are rate limited at once waits and goes around again: the Cloudflare egress IP is shared, so a burst can empty every provider's allowance for a second or two.
async function rpc(fetchImpl, method, params, pause = sleep) {
  let failure;
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round > 0) await pause(700 * round);
    for (const url of RPCS) {
      try {
        const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-sponsor", method, params }), signal: AbortSignal.timeout(12000) });
        const payload = await response.json().catch(() => null);
        if (!payload || payload.error?.code === -429 || [408, 429, 502, 503, 504].includes(response.status) || /timeout|rate limit/i.test(payload.error?.message || "")) { failure = new Error(`${new URL(url).host} is unavailable (HTTP ${response.status}).`); continue; }
        if (payload.error) { const e = new Error((typeof payload.error.data === "string" ? payload.error.data : [payload.error.message, payload.error.cause?.name, payload.error.cause?.info?.error_message].filter(Boolean).join(": ")) || "RPC error"); e.rpc = payload.error; throw e; }
        return payload.result;
      } catch (error) { if (error.rpc) throw error; failure = error; }
    }
  }
  throw failure || new Error("No NEAR RPC answered.");
}

async function view(fetchImpl, method, args) {
  const result = await rpc(fetchImpl, "query", { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

async function balanceOf(fetchImpl, account) {
  try { return BigInt((await rpc(fetchImpl, "query", { request_type: "view_account", finality: "final", account_id: account })).amount); }
  catch (error) { if (/does not exist|unknown/i.test(`${error.message} ${error.rpc?.cause?.name || ""}`)) return 0n; throw error; }
}

async function sendTransfer(fetchImpl, seedHex, receiverId) {
  const key = await crypto.subtle.importKey("pkcs8", hexBytes(PKCS8_PREFIX + seedHex), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const publicRaw = Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const publicKey = `ed25519:${b58encode(publicRaw)}`;
  const access = await rpc(fetchImpl, "query", { request_type: "view_access_key", finality: "final", account_id: SPONSOR_ID, public_key: publicKey });
  const block = await rpc(fetchImpl, "block", { finality: "final" });
  const tx = transferBytes({ signerId: SPONSOR_ID, publicKey, nonce: BigInt(access.nonce) + 1n, receiverId, blockHash: block.header.hash, deposit: GRANT });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new Uint8Array(await crypto.subtle.digest("SHA-256", tx))));
  const signed = concat(tx, Uint8Array.of(0), signature);
  const result = await rpc(fetchImpl, "send_tx", { signed_tx_base64: btoa(String.fromCharCode(...signed)), wait_until: "EXECUTED_OPTIMISTIC" });
  if (result.status?.Failure) throw new Error(`The transfer failed: ${JSON.stringify(result.status.Failure).slice(0, 200)}`);
  return result.transaction?.hash || result.transaction_outcome?.id;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleSponsor(request, env, fetchImpl = fetch) {
  if (request.method !== "POST") return json({ error: "POST an account id." }, 405);
  let account;
  try { account = String((await request.json()).account || ""); } catch { return json({ error: "Send JSON with an account." }, 400); }
  if (!/^[a-f0-9]{64}$/.test(account)) return json({ error: "The account must be a 64 character implicit account id." }, 400);
  if (!/^[a-f0-9]{64}$/.test(env.SPONSOR_SEED || "")) return json({ error: "Sponsored fees are not configured." }, 503);
  try {
    const owned = BigInt((await view(fetchImpl, "nft_supply_for_owner", { account_id: account })) || 0);
    if (owned < 1n) return json({ error: "This account holds no Cachet note, so there is nothing to sponsor." }, 403);
    const balance = await balanceOf(fetchImpl, account);
    if (balance >= LOW_WATER) return json({ funded: false, balance: balance.toString(), reason: "The account already has NEAR for network fees." });
    const tx = await sendTransfer(fetchImpl, env.SPONSOR_SEED, account);
    return json({ funded: true, tx, grant: GRANT.toString() });
  } catch (error) { return json({ error: `The sponsor could not send the fee: ${error.message}` }, 502); }
}
