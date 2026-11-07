// Claims testnet3 coins from faucet.satloot.com (public API, once per day per IP and per address).
// Usage: node scripts/faucet-satloot.mjs <tb1 address> [sats]
import { createHash } from "node:crypto";

const BASE = "https://faucet.satloot.com";
const [address, sats = "50000"] = process.argv.slice(2);
if (!address) { console.error("usage: faucet-satloot.mjs <address> [sats]"); process.exit(2); }

const leadingZeroBits = (hex) => { let n = 0; for (const ch of hex) { const v = parseInt(ch, 16); if (v === 0) n += 4; else { n += Math.clz32(v) - 28; break; } } return n; };
const challenge = await (await fetch(`${BASE}/api/challenge`)).json();
let nonce = 0;
while (leadingZeroBits(createHash("sha256").update(`${challenge.token}:${nonce}`).digest("hex")) < challenge.bits) nonce++;

const body = new URLSearchParams({ address, token: challenge.token, sig: challenge.sig, nonce: String(nonce), lang: "en", website: "", amount_sat: sats });
const reply = await (await fetch(`${BASE}/api/claim`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })).json();
console.log(JSON.stringify(reply));
if (!reply.ok) process.exit(1);
