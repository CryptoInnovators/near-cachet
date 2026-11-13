"use strict";

(() => {
// Pure claim-link logic. No DOM. Loaded by claim.html and by the Node tests.

const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64UrlToBytes(value) {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function privateKeyFromSeed(seedHex) {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error("the link secret must be 64 hex characters");
  const pkcs8 = hexToBytes(PKCS8_ED25519_PREFIX + seedHex.toLowerCase());
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
}

async function publicKeyHexFromSeed(seedHex) {
  const key = await privateKeyFromSeed(seedHex);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return bytesToHex(base64UrlToBytes(jwk.x));
}

function newSeedHex() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// The exact string `Cachet::claim` verifies: format!("cachet-claim:{}:{}:{}", current_account_id, token_id, new_owner).
function claimMessage(contract, tokenId, newOwner) {
  return `cachet-claim:${contract}:${tokenId}:${newOwner}`;
}

async function signClaim(seedHex, contract, tokenId, newOwner) {
  const key = await privateKeyFromSeed(seedHex);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(claimMessage(contract, tokenId, newOwner)));
  return bytesToHex(new Uint8Array(sig));
}

function buildFragment({ contract, token, key, sender }) {
  return new URLSearchParams({ v: sender ? "2" : "1", contract, token, key, ...(sender ? { sender } : {}) }).toString();
}

function parseFragment(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ""));
  const contract = p.get("contract");
  const token = p.get("token");
  const key = p.get("key");
  const sender = p.get("sender");
  const version = p.get("v");
  if (!(["1", "2"].includes(version)) || !contract || !token || !/^[0-9a-f]{64}$/i.test(key || "")) return null;
  if (version === "2" && (!sender || !/^(?:[a-z0-9]+[._-])*[a-z0-9]+$/.test(sender) || sender.length > 64)) return null;
  return { contract, token, key: key.toLowerCase(), ...(version === "2" ? { sender } : {}) };
}

// Telegram start_param allows only [A-Za-z0-9_-]{1,512}, so a claim fragment travels base64url-encoded.
function encodeStartParam(fragment) {
  return btoa(String(fragment).replace(/^#/, "")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseMiniAppStartParam(value) {
  if (!value) return null;
  let candidate = String(value);
  if (/^[A-Za-z0-9_-]+$/.test(candidate)) {
    try {
      const decoded = parseFragment(atob(candidate.replace(/-/g, "+").replace(/_/g, "/")));
      if (decoded) return buildFragment(decoded);
    } catch {}
  }
  try {
    const url = new URL(candidate, "https://cachet.invalid/");
    candidate = url.hash || (url.searchParams.has("v") ? url.search.slice(1) : candidate);
  } catch {}
  const parsed = parseFragment(candidate);
  return parsed ? buildFragment(parsed) : null;
}

// The first judge-pool fragment for this network whose note is still Sealed with an open claim link, or null.
async function pickJudgeFragment(net, readNote, entries) {
  const list = entries || await (await fetch("judge-links.json", { cache: "no-store" })).json();
  for (const entry of list) {
    const fragment = parseFragment(entry.fragment);
    if (!fragment || fragment.contract !== net.contract) continue;
    const note = await readNote(fragment);
    if (note?.state === "Sealed" && note.claim) return entry.fragment;
  }
  return null;
}

const lib = { pickJudgeFragment, PKCS8_ED25519_PREFIX, bytesToHex, hexToBytes, publicKeyHexFromSeed, newSeedHex, claimMessage, signClaim, buildFragment, parseFragment, parseMiniAppStartParam, encodeStartParam };
if (typeof module !== "undefined" && module.exports) module.exports = lib;
if (typeof globalThis !== "undefined") globalThis.cachetClaim = lib;

})();
