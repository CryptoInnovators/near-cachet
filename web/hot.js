// Connect HOT: signs the heir in with the HOT wallet through NEAR Connect on mainnet. The wallet signs a NEP-413
// message over a nonce the worker issued, and the worker verifies it against the account's mainnet access keys.
// A sign-in message only: no mainnet transaction is built or sent from this page.
import { NearConnector } from "./vendor/near-connect-0.12.0.mjs";

const STORE = "cachet:hot-signin";
let connector;

function remembered() {
  try { const v = JSON.parse(localStorage.getItem(STORE) || "null"); return v?.verified ? v : null; } catch { return null; }
}

async function connect() {
  const challenge = await (await fetch("/api/hot/challenge", { cache: "no-store" })).json();
  if (!challenge.nonce) throw new Error(challenge.error || "The worker issued no challenge.");
  if (!connector) connector = new NearConnector({ network: "mainnet", features: { signMessage: true } });
  const wallet = await connector.connect({ walletId: "hot-wallet" });
  const nonce = Uint8Array.from(challenge.nonce.match(/../g), (h) => parseInt(h, 16));
  const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce, network: "mainnet" });
  const response = await fetch("/api/hot/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: challenge.nonce, issued_at: challenge.issued_at, mac: challenge.mac }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.verified) throw new Error(body.error || `HOT sign-in was refused (HTTP ${response.status}).`);
  localStorage.setItem(STORE, JSON.stringify(body));
  return body;
}

function disconnect() { try { localStorage.removeItem(STORE); connector?.disconnect?.(); } catch {} }

globalThis.cachetHot = { connect, disconnect, remembered };
