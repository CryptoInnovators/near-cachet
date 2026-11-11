"use strict";

function splitSats(total, count) {
  if (!Number.isSafeInteger(total) || total < 2 || !Number.isSafeInteger(count) || count < 2 || count > 8 || total < count) throw new Error("Enter at least one satoshi per share, with 2 to 8 shares.");
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => base + (i < total % count ? 1 : 0));
}

if (typeof document === "undefined") {
  if (typeof module !== "undefined" && module.exports) module.exports = { splitSats };
} else {
(() => {
const $ = (id) => document.getElementById(id);
const net = cachetChain.network("?network=testnet");
const notes = [];
const fmt = (n) => Number(n).toLocaleString("en-US");
const status = (message, error = false) => { $("hongbao-status").textContent = message; $("hongbao-status").className = error ? "gift-status error" : "gift-status"; };

function renderPreview() {
  try {
    const shares = splitSats(Number($("hongbao-sats").value), Number($("hongbao-count").value));
    $("hongbao-preview").textContent = `${shares.map((sats, i) => `Share ${i + 1}: ${fmt(sats)} sats`).join(" · ")} · ${fmt(shares.reduce((a, b) => a + b, 0))} sats total`;
    return shares;
  } catch (error) { $("hongbao-preview").textContent = error.message; return null; }
}

function txHash(result) {
  const failure = cachetOutcome.failureText(result);
  if (failure) throw new Error(failure);
  return result?.transaction?.hash || result?.transaction_outcome?.id || "";
}

async function poll(read, done, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("The chain did not reach the expected state before the 120-second timeout.");
}

async function createNotes(shares) {
  if (!cachetWallet.accountId) await cachetWallet.connect("testnet");
  notes.length = 0;
  for (let i = 0; i < shares.length; i++) {
    status(`Creating note ${i + 1} of ${shares.length}...`);
    const result = await cachetWallet.call(net.contract, "mint_note", {}, { tgas: 100, yocto: "20000000000000000000000" });
    const encoded = result?.status?.SuccessValue;
    if (!encoded) throw new Error("Mint finished without returning a note ID.");
    const token = JSON.parse(atob(encoded));
    const note = await poll(async () => (await cachetChain.callView(net.contract, "note", { token_id: token }, net)).value, (value) => value?.state === "Minted");
    notes.push({ token: String(token), sats: shares[i], address: note.address });
  }
  $("hongbao-seal").disabled = false;
  renderNotes();
  status("Notes are ready. Fund every address in one Bitcoin testnet transaction.");
}

function renderNotes() {
  $("hongbao-notes").replaceChildren(...notes.map((note, i) => {
    const row = document.createElement("li");
    row.innerHTML = `<strong>Share ${i + 1}</strong><span>${fmt(note.sats)} sats</span><code></code>`;
    row.querySelector("code").textContent = note.address || `Note ${note.token} is waiting for its live address read.`;
    if (note.link) {
      const link = document.createElement("a"); link.href = note.link; link.textContent = "Open claim link"; row.append(link);
      const share = document.createElement("a"); share.href = `https://t.me/share/url?url=${encodeURIComponent(note.link)}&text=${encodeURIComponent("A Bitcoin gift is waiting for you")}`; share.textContent = "Share in Telegram"; row.append(share);
    }
    return row;
  }));
}

async function sealNotes() {
  const txid = $("hongbao-txid").value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("Enter a 64-character Bitcoin testnet transaction ID.");
  const config = (await cachetChain.callView(net.contract, "config", {}, net)).value;
  const base = cachetChain.mempoolBase(config.hrp);
  const tx = await cachetChain.mempoolJson(base, `/tx/${txid}`);
  if (tx.txid !== txid || !tx.status?.confirmed) throw new Error("The Bitcoin funding transaction is missing or unconfirmed.");
  const blockHeight = Number(await cachetChain.mempoolText(base, "/blocks/tip/height"));
  const confirmations = blockHeight - Number(tx.status.block_height) + 1;
  if (confirmations < Number(config.confirmations)) throw new Error(`Funding has ${confirmations} confirmations; ${config.confirmations} are required.`);
  const proof = await cachetBtcProof.inclusionProof(base, txid);
  const usedVouts = new Set();
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const funding = await cachetBtcProof.fundingOf(base, note.address);
    if (!funding || funding.txid !== txid || usedVouts.has(funding.vout)) throw new Error(`The transaction does not pay a distinct output to note ${note.token}.`);
    usedVouts.add(funding.vout);
    const output = tx.vout[funding.vout];
    if (output?.scriptpubkey_address !== note.address || Number(output.value) !== note.sats) throw new Error(`Output ${funding.vout} does not match note ${note.token} and its ${note.sats} satoshi share.`);
    status(`Attesting share ${i + 1} of ${notes.length}...`);
    txHash(await cachetWallet.call(net.contract, "attest", { token_id: note.token, raw_tx: funding.raw_tx, vout: funding.vout, proof }, { tgas: 150 }));
    const sealed = await poll(async () => (await cachetChain.callView(net.contract, "note", { token_id: note.token }, net)).value, (value) => value?.state !== "Attesting");
    if (sealed?.state !== "Sealed") throw new Error(`Note ${note.token} did not seal after its inclusion proof.`);
    const seed = cachetClaim.newSeedHex();
    const key = await cachetClaim.publicKeyHexFromSeed(seed);
    const block = await cachetChain.rpc("block", { finality: "final" }, net);
    const expiry = block.header.height + 86400;
    txHash(await cachetWallet.call(net.contract, "create_claim", { token_id: note.token, claim_key: key, expires_at_block: expiry }, { tgas: 100 }));
    const live = (await cachetChain.callView(net.contract, "note", { token_id: note.token }, net)).value;
    if (live?.state !== "Sealed" || live.claim?.key?.toLowerCase() !== key.toLowerCase()) throw new Error(`The live claim key for note ${note.token} did not verify.`);
    const link = new URL("claim.html", location.href);
    link.searchParams.set("network", "testnet");
    link.hash = cachetClaim.buildFragment({ contract: net.contract, token: note.token, key: seed });
    note.link = link.href;
  }
  renderNotes();
  status("Every share is sealed and its claim key matches the live contract.");
}

$("hongbao-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const shares = renderPreview();
  if (!shares) return;
  try { await createNotes(shares); } catch (error) { status(error.message, true); }
});
$("hongbao-sats").addEventListener("input", renderPreview);
$("hongbao-count").addEventListener("input", renderPreview);
$("hongbao-seal").addEventListener("click", async () => {
  $("hongbao-seal").disabled = true;
  try { await sealNotes(); } catch (error) { status(error.message, true); }
  finally { $("hongbao-seal").disabled = notes.length === 0; }
});
$("hongbao-connect").addEventListener("click", async () => {
  try { const account = await cachetWallet.connect("testnet"); $("hongbao-connect").textContent = account; }
  catch (error) { status(error.message, true); }
});
renderPreview();

const api = { splitSats };
if (typeof module !== "undefined" && module.exports) module.exports = api;
globalThis.cachetHongbao = api;
})();
}
