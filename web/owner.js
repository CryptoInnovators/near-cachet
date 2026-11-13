"use strict";

(() => {

const ownerNet = cachetChain.network();
const { h, short } = cachetUi;
const ownerPanel = document.getElementById("owner-actions");
const ownerStatus = document.getElementById("owner-status");
const connectButton = document.getElementById("wallet-connect");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ownerButton(label, fn, className = "btn btn-primary") {
  return h("button", { type: "button", class: className, onclick: fn }, label);
}

function ownerField(form, label, id, value = "") {
  form.append(h("div", { class: "field" }, h("label", { for: id }, label), h("input", { id, value, autocomplete: "off", autocapitalize: "none", spellcheck: "false" })));
  return document.getElementById(id);
}

function tool(title, ...children) {
  return h("div", { class: "tool" }, title ? h("h3", null, title) : null, ...children);
}

function resultFailure(result) {
  const failure = cachetOutcome.failureText(result);
  if (failure) throw new Error(failure);
  return result?.transaction?.hash || result?.transaction_outcome?.id || null;
}

async function refresh(contract, tokenId, noteProvided, configProvided) {
  const account = cachetWallet.accountId;
  ownerPanel.replaceChildren();
  const note = noteProvided === undefined ? (await cachetChain.callView(contract, "note", { token_id: tokenId }, ownerNet)).value : noteProvided;
  const config = configProvided || (await cachetChain.callView(contract, "config", {}, ownerNet).catch(() => ({ value: null }))).value;
  if (!config) return ownerPanel.append(tool("No contract here", h("p", null, `${contract} is not a Cachet contract on ${ownerNet.name}, so there is nothing to manage.`)));
  if (!account) {
    ownerPanel.append(tool("Connect a NEAR wallet", h("p", null, "Connect to mint a note, or to manage one you own."), ownerButton("Connect wallet", connect)));
    return;
  }
  ownerPanel.append(tool("Mint a note", h("p", null, "0.02 NEAR derives a new Bitcoin address and prepays every byte the note can ever store."), ownerButton("Mint note", () => runMint(contract))));
  if (!note) return;
  if (account !== note.owner_id) {
    ownerPanel.append(tool(`Note ${note.token_id} belongs to ${note.owner_id}`, h("p", null, "Connect that account to manage it.")));
    return;
  }
  if (note.state === "Minted") {
    ownerPanel.append(tool("Attest the funding", h("p", null, "Fund the address on the card once with one output. When it has two confirmations, attest it and the wax goes on."), ownerButton("Attest funding", () => runAttest(contract, tokenId, note, config))));
    if (!note.claim) ownerPanel.append(tool("Make a claim link", h("p", null, "A link that moves this note to whoever opens it first."), ownerButton("Create claim link", () => runClaimLink(contract, tokenId), "btn btn-paper")));
  }
  if (note.state === "Sealed") {
    if (!note.claim) ownerPanel.append(tool("Make a claim link", h("p", null, "A link that moves this note to whoever opens it first."), ownerButton("Create claim link", () => runClaimLink(contract, tokenId))));
    if (!note.claim?.locked) await addUnsealForm(contract, tokenId, note, config);
  }
  if (note.state === "Unsealed") {
    const form = h("form", { class: "tool-form" });
    const fee = ownerField(form, "New fee rate, sat/vB", "resign-fee", "5");
    form.append(h("button", { type: "submit", class: "btn btn-paper" }, "Resign sweep"));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const rate = Number(fee.value);
      const guard = cachetOutcome.feeGuard(note.utxo.sats, rate, note.sweep.destination_script.length / 2);
      if (guard) return report(guard, true);
      await runCall(contract, "resign", { token_id: tokenId, fee_rate: rate }, 300);
    });
    ownerPanel.append(tool("Sweep", h("p", null, "The sweep is signed. Broadcast it, or sign again at a new fee."), note.sweep?.signed_tx ? h("pre", { class: "cmd-text" }, note.sweep.signed_tx) : null, note.sweep?.signed_tx ? ownerButton("Broadcast", () => runBroadcast(config, note)) : null, note.sweep?.signed_tx ? ownerButton("Copy signed sweep", async () => { await navigator.clipboard.writeText(note.sweep.signed_tx); report("Signed sweep copied."); }, "btn btn-paper") : null, form));
    ownerPanel.append(tool("Finalize", h("p", null, "Once the sweep is confirmed, finalize burns the note."), ownerButton("Finalize sweep", () => runFinalize(contract, tokenId, note, config), "btn btn-paper")));
  }
  if (["Attesting", "Unsealing", "Resigning", "Finalizing"].includes(note.state)) {
    ownerPanel.append(tool("Waiting on a cross-contract answer", h("p", null, "If no answer arrives, recover opens 400 NEAR blocks after the request."), ownerButton("Recover after timeout", () => runRecover(contract, tokenId, note), "btn btn-paper")));
  }
}

async function connect() {
  try {
    const account = await cachetWallet.connect(ownerNet.name);
    connectButton.textContent = short(account, 12, 8);
    connectButton.setAttribute("aria-label", `Connected account ${account}`);
    const supply = await cachetChain.callView(document.getElementById("contract-input").value.trim(), "nft_supply_for_owner", { account_id: account }, ownerNet).catch(() => null);
    const badge = document.getElementById("notes-count");
    if (badge && supply && Number(supply.value) > 0) { badge.textContent = String(supply.value); badge.hidden = false; }
    await refresh(document.getElementById("contract-input").value.trim(), document.getElementById("token-input").value.trim());
  } catch (error) { report(error.message, true); }
}

function report(text, error = false) {
  ownerStatus.textContent = text || "";
  ownerStatus.className = error ? "status error" : "status";
}

async function updateRead(contract, tokenId) {
  const result = await cachetChain.callView(contract, "note", { token_id: tokenId }, ownerNet);
  await refresh(contract, tokenId, result.value);
}

async function runCall(contract, method, args, tgas, yocto = "0", tokenId = document.getElementById("token-input").value.trim()) {
  try {
    report(`Waiting for ${method} transaction...`);
    const result = await cachetWallet.call(contract, method, args, { tgas, yocto });
    const hash = resultFailure(result);
    report(`${method} succeeded${hash ? `. Transaction ${hash}` : ""}.`);
    if (tokenId) await updateRead(contract, tokenId);
    return result;
  } catch (error) { report(error.message, true); throw error; }
}

async function runMint(contract) {
  try {
    const result = await runCall(contract, "mint_note", {}, 100, "20000000000000000000000", "");
    const encoded = result?.status?.SuccessValue;
    let tokenId = null;
    if (encoded) {
      try { tokenId = JSON.parse(atob(encoded)); }
      catch (error) { throw new Error(`Mint returned an unreadable token id: ${error.message}`); }
    }
    if (!tokenId) {
      const block = await cachetChain.rpc("block", { finality: "final" }, ownerNet);
      report(`Mint transaction finished, but did not return a token id. Check the contract at NEAR block ${block.header.height}.`, true);
      return;
    }
    await pollNote(contract, tokenId, (note) => note?.state === "Minted");
    document.getElementById("token-input").value = tokenId;
    document.getElementById("read-form").requestSubmit();
    report(`Note ${tokenId} is Minted. Read its funding address above.`);
  } catch (error) { report(error.message, true); }
}

function bitcoinScriptLen(address, hrp) {
  if (typeof address !== "string" || !address.toLowerCase().startsWith(`${hrp}1`)) return null;
  if (/1q[ac-hj-np-z02-9]{38}$/i.test(address)) return 22;
  if (/1q[ac-hj-np-z02-9]{58}$/i.test(address) || /1p[ac-hj-np-z02-9]{58}$/i.test(address)) return 34;
  return null;
}

async function addUnsealForm(contract, tokenId, note, config) {
  const form = h("form", { class: "tool-form" });
  const base = cachetChain.mempoolBase(config.hrp);
  let destination = "";
  let rate = ownerNet.name === "testnet" ? 5 : 1;
  if (ownerNet.name === "testnet") {
    try { destination = await cachetChain.defaultDestination(ownerNet) || ""; }
    catch (error) { report(`Could not read a reusable pool address: ${error.message}`, true); }
  }
  try {
    const fees = await cachetChain.feeRates(base);
    rate = Math.max(1, Math.ceil(Number(fees.halfHourFee)));
    if (ownerNet.name === "testnet") rate = Math.min(rate, 5);
  } catch (error) { report(`Fee estimate unavailable: ${error.message}`, true); }
  const destinationInput = ownerField(form, "Bitcoin destination", "owner-destination", destination);
  const feeInput = ownerField(form, "Fee rate, sat/vB", "owner-fee", String(rate));
  form.append(h("button", { type: "submit", class: "btn btn-primary" }, "Break the seal"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const scriptLen = bitcoinScriptLen(destinationInput.value.trim(), config.hrp);
    if (!scriptLen) return report(`Enter a ${config.hrp} Bitcoin witness address.`, true);
    const guard = cachetOutcome.feeGuard(note.utxo.sats, Number(feeInput.value.trim()), scriptLen);
    if (guard) return report(guard, true);
    try {
      await runCall(contract, "unseal", { token_id: tokenId, btc_dest: destinationInput.value.trim().toLowerCase(), fee_rate: Number(feeInput.value.trim()) }, 300, "0", tokenId);
      const unsealed = await waitForUnsealed(contract, tokenId);
      await refresh(contract, tokenId, unsealed, config);
      report(`Note ${tokenId} is Unsealed. Its signed sweep is ready.`);
    } catch (error) { report(error.message, true); }
  });
  ownerPanel.append(tool("Break the seal", h("p", null, "Signs a Bitcoin sweep of the whole note to the address you name. The seal cannot be restored."), form));
}

async function runAttest(contract, tokenId, note, config) {
  try {
    report("Finding the confirmed Bitcoin output and its inclusion proof...");
    const base = cachetChain.mempoolBase(config.hrp);
    const funding = await cachetBtcProof.fundingOf(base, note.address);
    if (!funding) throw new Error("No transaction pays this note address yet.");
    const proof = await cachetBtcProof.inclusionProof(base, funding.txid);
    await runCall(contract, "attest", { token_id: tokenId, raw_tx: funding.raw_tx, vout: funding.vout, proof }, 150, "0", tokenId);
    const updated = await pollNote(contract, tokenId, (value) => value?.state !== "Attesting");
    report(updated?.state === "Sealed" ? `Note ${tokenId} is Sealed in Bitcoin block ${proof.block_hash}.` : "Bitcoin inclusion was not accepted. The note remains Minted.", updated?.state !== "Sealed");
  } catch (error) { report(error.message, true); }
}

async function runClaimLink(contract, tokenId) {
  try {
    const seed = cachetClaim.newSeedHex();
    const key = await cachetClaim.publicKeyHexFromSeed(seed);
    const block = await cachetChain.rpc("block", { finality: "final" }, ownerNet);
    const expiry = block.header.height + 86400;
    await runCall(contract, "create_claim", { token_id: tokenId, claim_key: key, expires_at_block: expiry }, 100, "0", tokenId);
    const link = new URL("claim.html", location.href);
    link.searchParams.set("network", ownerNet.name);
    link.hash = cachetClaim.buildFragment({ contract, token: tokenId, key: seed });
    const anchor = h("a", { href: link.href, rel: "noopener noreferrer", class: "link-out" }, link.href);
    const copy = ownerButton("Copy claim link", async () => { await navigator.clipboard.writeText(link.href); report("Claim link copied."); });
    ownerPanel.append(tool("Your claim link", h("p", null, "Anyone who opens it can take the note once. Send it over a channel you trust."), anchor, copy));
  } catch (error) { report(error.message, true); }
}

async function runFinalize(contract, tokenId, note, config) {
  try {
    report("Finding the signed sweep and its confirmed Bitcoin proof...");
    const base = cachetChain.mempoolBase(config.hrp);
    const spend = await cachetBtcProof.spendOf(base, note.utxo.txid, note.utxo.vout);
    if (!spend) throw new Error("The signed sweep is not confirmed yet.");
    const tx = await cachetChain.mempoolJson(base, `/tx/${encodeURIComponent(spend.txid)}`);
    const confirmations = Number(tx.status?.confirmed ? await cachetChain.mempoolText(base, "/blocks/tip/height") : 0) - Number(tx.status?.block_height || 0) + 1;
    if (confirmations < Number(config.confirmations)) throw new Error(`Sweep has ${confirmations} confirmations; ${config.confirmations} are required.`);
    const proof = await cachetBtcProof.inclusionProof(base, spend.txid);
    await runCall(contract, "finalize", { token_id: tokenId, sweep_raw_tx: spend.raw_tx, proof }, 150, "0", tokenId);
    await pollNote(contract, tokenId, (value) => value === null);
    report(`Note ${tokenId} is Finalized and no longer exists.`);
  } catch (error) { report(error.message, true); }
}

async function runBroadcast(config, note) {
  const signed = note.sweep?.signed_tx;
  if (!signed) return report("The contract has no signed sweep to broadcast.", true);
  const base = cachetChain.mempoolBase(config.hrp);
  const fallback = config.hrp === "tb" ? "https://blockstream.info/testnet/api/tx" : "https://blockstream.info/api/tx";
  const errors = [];
  let txid;
  for (const url of [`${base}/api/tx`, fallback]) {
    try {
      const response = await cachetChain.fetchWithTimeout(url, { method: "POST", headers: { "content-type": "text/plain" }, body: signed });
      const text = (await response.text()).trim();
      if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
      txid = text;
      break;
    } catch (error) { errors.push(error.message); }
  }
  if (!txid) return report(errors.join("; "), true);
  try {
    const tx = await cachetChain.mempoolJson(base, `/tx/${encodeURIComponent(txid)}`);
    if (tx.vin?.[0]?.txid !== note.utxo.txid || tx.vin?.[0]?.vout !== note.utxo.vout) return report("Broadcast tx input does not match this note's funding output.", true);
    report(`Sweep ${txid} was read back from mempool.space.`);
  } catch (error) { report(`Broadcast returned ${txid}, but it could not be read back: ${error.message}`, true); }
}

async function runRecover(contract, tokenId, note) {
  try {
    const block = await cachetChain.rpc("block", { finality: "final" }, ownerNet);
    if (block.header.height < Number(note.pending_since) + 400) throw new Error(`Recover opens at NEAR block ${Number(note.pending_since) + 400}. Current final block is ${block.header.height}.`);
    await runCall(contract, "recover", { token_id: tokenId }, 100, "0", tokenId);
  } catch (error) { report(error.message, true); }
}

async function pollNote(contract, tokenId, done, timeout = 180000, interval = 3000) {
  const until = Date.now() + timeout;
  let note;
  do {
    note = (await cachetChain.callView(contract, "note", { token_id: tokenId }, ownerNet)).value;
    if (done(note)) return note;
    await wait(interval);
  } while (Date.now() < until);
  throw new Error(`NEAR note ${tokenId} did not reach the expected state before timeout.`);
}

async function waitForUnsealed(contract, tokenId) {
  const until = Date.now() + 180000;
  let sawPending = false;
  while (Date.now() < until) {
    const note = (await cachetChain.callView(contract, "note", { token_id: tokenId }, ownerNet)).value;
    if (note?.state === "Unsealed") return note;
    if (note?.state === "Unsealing") sawPending = true;
    if (note?.state === "Sealed" && sawPending) throw new Error("The signer request failed. The note remains Sealed and can be tried again.");
    await wait(3000);
  }
  const note = (await cachetChain.callView(contract, "note", { token_id: tokenId }, ownerNet)).value;
  throw new Error(`The signer has not answered; Recover opens at NEAR block ${Number(note?.pending_since || 0) + 400}.`);
}

connectButton.addEventListener("click", connect);

globalThis.cachetOwner = { refresh };

})();
