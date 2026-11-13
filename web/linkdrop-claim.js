"use strict";

(() => {
const PREFIX = "302e020100300506032b657004220420";
const MIN_ALLOWANCE = 150000000000000000000000n;
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(value) {
  let n = 0n;
  for (const c of value) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) throw new Error("Invalid NEAR base58 value.");
    n = n * 58n + BigInt(digit);
  }
  const out = [];
  while (n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of value) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out || "1";
}

async function secretKeyString(seedHex) {
  const seed = hexBytes(seedHex);
  if (seed.length !== 32) throw new Error("Invalid Ed25519 seed.");
  const publicKey = hexBytes(await cachetClaim.publicKeyHexFromSeed(seedHex));
  return `ed25519:${b58encode(concat(seed, publicKey))}`;
}

async function submitWalletlessClaim({ acknowledged, send }) {
  if (!acknowledged) throw new Error("Back up your claim account key before opening this gift.");
  return send();
}

function hexBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("Invalid hex value.");
  return Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));
}

function bytesHex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }

function keyPermission(entry) {
  const permission = entry?.permission;
  return permission?.FunctionCall || permission?.functionCall || null;
}

function assertClaimKey(entry, contract) {
  const p = keyPermission(entry);
  const receiver = p?.receiver_id ?? p?.receiverId;
  const methods = p?.method_names ?? p?.methodNames;
  if (receiver !== contract || !Array.isArray(methods) || methods.length !== 1 || methods[0] !== "claim" || !p.allowance || BigInt(p.allowance) < MIN_ALLOWANCE) {
    throw new Error("The link key is not restricted to claim on this contract.");
  }
  return true;
}

function assertUnclaimed(note, keyHex) {
  if (!note?.claim || note.claim.key?.toLowerCase() !== keyHex.toLowerCase()) throw new Error("This share has already been claimed or its link is no longer active.");
  if (note.state !== "Sealed") throw new Error("This share is not sealed.");
  return true;
}

function canAddClaimKey(note) { return note?.state === "Sealed" && !note.claim; }

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function u32(value) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, value, true); return a; }
function u64(value) { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(value), true); return a; }
function string(value) { const b = new TextEncoder().encode(value); return concat(u32(b.length), b); }
function byteVec(value) { return concat(u32(value.length), value); }

function transactionBytes({ signerId, publicKey, nonce, receiverId, blockHash, args, method = "claim", gas = 100_000_000_000_000n }) {
  const pk = typeof publicKey === "string" ? b58decode(publicKey.replace(/^ed25519:/, "")) : publicKey;
  const hash = typeof blockHash === "string" ? b58decode(blockHash) : blockHash;
  if (pk.length !== 32 || hash.length !== 32) throw new Error("Invalid access key or block hash.");
  const json = new TextEncoder().encode(JSON.stringify(args));
  return concat(string(signerId), Uint8Array.of(0), pk, u64(nonce), string(receiverId), hash,
    u32(1), Uint8Array.of(2), string(method), byteVec(json), u64(gas), new Uint8Array(16));
}

// restricted: the signer is a sender-funded claim-only key. Otherwise the signer is a full-access claim account signing its own call.
async function signAndSend({ signerId, seedHex, contract, args, net, method = "claim", tgas = 100, restricted = true }) {
  if (net.name !== "testnet" || !net.rpc) throw new Error("Walletless claims are available on testnet only.");
  const publicRaw = await cachetClaim.publicKeyHexFromSeed(seedHex);
  const publicKey = `ed25519:${b58encode(hexBytes(publicRaw))}`;
  const entry = await cachetChain.rpc("query", { request_type: "view_access_key", finality: "final", account_id: signerId, public_key: publicKey }, net).catch((error) => {
    if (!restricted && /does not exist|unknown/i.test(error.message)) throw new Error("This claim account holds no NEAR yet, so it cannot pay a network fee.");
    throw error;
  });
  if (restricted) assertClaimKey(entry, contract);
  const block = await cachetChain.rpc("block", { finality: "final" }, net);
  const tx = transactionBytes({ signerId, publicKey, nonce: BigInt(entry.nonce) + 1n, receiverId: contract, blockHash: block.header.hash, args, method, gas: BigInt(tgas) * 1_000_000_000_000n });
  const privateKey = await crypto.subtle.importKey("pkcs8", hexBytes(PREFIX + seedHex), { name: "Ed25519" }, false, ["sign"]);
  const txHash = new Uint8Array(await crypto.subtle.digest("SHA-256", tx));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, txHash));
  const signed = concat(tx, Uint8Array.of(0), signature);
  const binary = Array.from(signed, (b) => String.fromCharCode(b)).join("");
  const result = await cachetChain.rpc("send_tx", { signed_tx_base64: btoa(binary), wait_until: "EXECUTED_OPTIMISTIC" }, net);
  return result;
}

async function createImplicitAccount(storage, netName) {
  const key = `cachet:claim-account:${netName}`;
  let account = JSON.parse(storage.getItem(key) || "null");
  if (account && /^[a-f0-9]{64}$/i.test(account.seedHex || "") && /^[a-f0-9]{64}$/i.test(account.accountId || "")) return account;
  const seedHex = cachetClaim.newSeedHex();
  const accountId = await cachetClaim.publicKeyHexFromSeed(seedHex);
  account = { accountId, seedHex };
  storage.setItem(key, JSON.stringify(account));
  return account;
}

const api = { b58decode, b58encode, secretKeyString, submitWalletlessClaim, assertClaimKey, assertUnclaimed, canAddClaimKey, transactionBytes, signAndSend, createImplicitAccount };
if (typeof module !== "undefined" && module.exports) module.exports = api;
globalThis.cachetLinkdrop = api;
})();
