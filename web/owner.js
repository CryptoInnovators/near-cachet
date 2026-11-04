"use strict";

(() => {

const ownerNet = cachetChain.network();
const ownerPanel = document.getElementById("owner-actions");
const ownerStatus = document.getElementById("owner-status");
const ownerAccount = document.getElementById("wallet-account");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ownerElement(tag, text, className) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function ownerButton(label, fn) {
  const button = ownerElement("button", label);
  button.type = "button";
  button.addEventListener("click", fn);
  return button;
}

function ownerField(form, label, id, value = "") {
  const wrap = ownerElement("div", null, "field");
  const caption = ownerElement("label", label);
  caption.htmlFor = id;
  const input = ownerElement("input");
  input.id = id;
  input.value = value;
  input.autocomplete = "off";
  input.autocapitalize = "none";
  wrap.append(caption, input);
  form.append(wrap);
  return input;
}

function resultFailure(result) {
  const failure = cachetOutcome.failureText(result);
  if (failure) throw new Error(failure);
  return result?.transaction?.hash || result?.transaction_outcome?.id || null;
}

async function refresh(contract, tokenId, noteProvided, configProvided) {
  const account = cachetWallet.accountId;
  const [noteRead, configRead] = await Promise.all([
    noteProvided ? Promise.resolve({ value: noteProvided }) : cachetChain.callView(contract, "note", { token_id: tokenId }, ownerNet),
    configProvided ? Promise.resolve({ value: configProvided }) : cachetChain.callView(contract, "config", {}, ownerNet),
  ]);
  const note = noteRead.value;
  const config = configRead.value;
  ownerPanel.replaceChildren();
  if (config) await trust(config);
  if (!account) {
    ownerPanel.append(ownerElement("p", "Connect a NEAR wallet to see actions for your account."));
    return;
  }
  const mint = ownerButton("Mint note · 0.02 NEAR", () => runMint(contract));
  ownerPanel.append(mint);
  if (!note) return;
  if (account !== note.owner_id) {
    ownerPanel.append(ownerElement("p", `This note belongs to ${note.owner_id}. Connect that account to manage it.`, "fine"));
    return;
  }
  const actions = ownerElement("div", null, "owner-actions");
  ownerPanel.append(actions);
  if (note.state === "Minted") {
    actions.append(ownerElement("p", "Fund once with one output. The funding address appears in the note record while it is Minted."));
    actions.append(ownerButton("Attest funding", () => runAttest(contract, tokenId, note, config)));
    if (!note.claim) actions.append(ownerButton("Create claim link", () => runClaimLink(contract, tokenId)));
  }
  if (note.state === "Sealed") {
    if (!note.claim) actions.append(ownerButton("Create claim link", () => runClaimLink(contract, tokenId)));
    if (!note.claim?.locked) await addUnsealForm(actions, contract, tokenId, note, config);
  }
  if (note.state === "Unsealed") {
    const form = ownerElement("form", null, "tool-form");
    const fee = ownerField(form, "New fee rate, sat/vB", "resign-fee", "5");
    const submit = ownerElement("button", "Resign sweep");
    submit.type = "submit";
    form.append(submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const rate = Number(fee.value);
      const guard = cachetOutcome.feeGuard(note.utxo.sats, rate, note.sweep.destination_script.length / 2);
      if (guard) return report(guard, true);
      await runCall(contract, "resign", { token_id: tokenId, fee_rate: rate }, 300);
    });
    actions.append(form);
    if (note.sweep?.signed_tx) {
      actions.append(ownerElement("pre", note.sweep.signed_tx, "cmd-text"));
      actions.append(ownerButton("Copy signed sweep", async () => { await navigator.clipboard.writeText(note.sweep.signed_tx); report("Signed sweep copied."); }));
      actions.append(ownerButton("Broadcast", () => runBroadcast(config, note)));
    }
    actions.append(ownerButton("Finalize sweep", () => runFinalize(contract, tokenId, note, config)));
  }
  if (["Attesting", "Unsealing", "Resigning", "Finalizing"].includes(note.state)) {
    actions.append(ownerButton("Recover after timeout", () => runRecover(contract, tokenId, note)));
  }
}

function report(text, error = false) {
  ownerStatus.textContent = text || "";
  ownerStatus.className = error ? "control-status error" : "control-status";
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

async function addUnsealForm(parent, contract, tokenId, note, config) {
  const form = ownerElement("form", null, "tool-form");
  const base = cachetChain.mempoolBase(config.hrp);
  let destination = "";
  let rate = ownerNet.name === "testnet" ? 5 : 1;
  if (ownerNet.name === "testnet") {
    try { destination = await cachetChain.defaultDestination(ownerNet) || ""; }
    catch (error) { report(`Could not read a reusable pool address: ${error.message}`, true); }
  }
  try {
    const fees = await cachetChain.mempoolJson(base, "/v1/fees/recommended");
    rate = Math.max(1, Math.ceil(Number(fees.halfHourFee)));
    if (ownerNet.name === "testnet") rate = Math.min(rate, 5);
  } catch (error) { report(`Fee estimate unavailable: ${error.message}`, true); }
  const destinationInput = ownerField(form, "Bitcoin destination", "owner-destination", destination);
  const feeInput = ownerField(form, "Fee rate, sat/vB", "owner-fee", String(rate));
  const submit = ownerElement("button", "Unseal");
  submit.type = "submit";
  form.append(submit);
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
      report(`Note ${tokenId} is Unsealed. Its signed sweep is ready below.`);
    } catch (error) { report(error.message, true); }
  });
  parent.append(form);
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
    const anchor = ownerElement("a", link.href, "mono wrap");
    anchor.href = link.href;
    anchor.rel = "noopener noreferrer";
    const copy = ownerButton("Copy claim link", async () => { await navigator.clipboard.writeText(link.href); report("Claim link copied."); });
    ownerPanel.append(anchor, copy);
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

async function trust(config) {
  const target = document.getElementById("trust-body");
  if (!target) return;
  target.replaceChildren();
  const list = ownerElement("dl", null, "record");
  const add = (label, value) => { const row = ownerElement("div", null, "record-row"); row.append(ownerElement("dt", label), ownerElement("dd", String(value))); list.append(row); };
  add("Signer", config.signer_id);
  add("Bitcoin light client", config.btc_light_client);
  try {
    const header = await cachetChain.callView(config.btc_light_client, "get_last_block_header", {}, ownerNet);
    add("Light-client height", header.value?.block_height);
  } catch (error) { add("Light-client read", error.message); }
  try {
    const height = await cachetChain.mempoolText(cachetChain.mempoolBase(config.hrp), "/blocks/tip/height");
    add("Bitcoin tip", height.trim());
  } catch (error) { add("Bitcoin tip read", error.message); }
  target.append(list);
}

document.getElementById("wallet-connect").addEventListener("click", async () => {
  try {
    const account = await cachetWallet.connect(ownerNet.name);
    ownerAccount.textContent = account;
    ownerAccount.setAttribute("aria-label", `Connected account ${account}`);
    await refresh(document.getElementById("contract-input").value.trim(), document.getElementById("token-input").value.trim());
  } catch (error) { report(error.message, true); }
});

globalThis.cachetOwner = { refresh };

})();
