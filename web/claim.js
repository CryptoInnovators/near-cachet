"use strict";

const $ = (id) => document.getElementById(id);
const net = cachetChain.network();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, text, className) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text != null) item.textContent = text;
  return item;
}

function status(text, error = false) {
  const target = $("claim-status");
  target.textContent = text;
  target.className = error ? "control-status error" : "control-status";
}

function txHash(outcome) {
  return outcome?.transaction?.hash || outcome?.transaction_outcome?.id || null;
}

function transactionError(outcome) {
  return cachetOutcome.failureText(outcome) || null;
}

async function poll(read, done, timeoutMs, stepMs) {
  const until = Date.now() + timeoutMs;
  let value;
  while (Date.now() < until) {
    value = await read();
    if (done(value)) return value;
    await delay(stepMs);
  }
  return value;
}

async function viewNote(frag) {
  const result = await cachetChain.callView(frag.contract, "note", { token_id: frag.token }, net);
  return { note: result.value, height: result.blockHeight };
}

function row(list, key, value) {
  const line = el("div", null, "record-row");
  line.append(el("dt", key), el("dd", value));
  list.append(line);
}

function accountAddress(value, hrp) {
  return typeof value === "string" && new RegExp(`^${hrp}1[ac-hj-np-z02-9]{20,90}$`).test(value.toLowerCase());
}

function destinationScriptLen(value) {
  if (/1q[ac-hj-np-z02-9]{38}$/i.test(value)) return 22;
  if (/1q[ac-hj-np-z02-9]{58}$/i.test(value) || /1p[ac-hj-np-z02-9]{58}$/i.test(value)) return 34;
  return null;
}

async function readClaimState(frag) {
  const [noteRead, configRead] = await Promise.all([
    viewNote(frag),
    cachetChain.callView(frag.contract, "config", {}, net),
  ]);
  return { ...noteRead, config: configRead.value };
}

async function showClaimTarget(frag) {
  const intro = $("claim-intro");
  intro.replaceChildren(el("p", `Reading ${frag.contract}.note("${frag.token}")...`, "reading"));
  let state;
  try { state = await readClaimState(frag); }
  catch (error) { intro.replaceChildren(el("p", error.message, "state-title")); return false; }
  const note = state.note;
  if (!note) { intro.replaceChildren(el("p", `No note ${frag.token} on ${frag.contract}.`, "state-title")); return false; }
  const mine = await cachetClaim.publicKeyHexFromSeed(frag.key);
  const rows = el("dl", null, "record");
  row(rows, "Note", `${frag.contract} #${note.token_id}`);
  row(rows, "Owner", note.owner_id);
  row(rows, "State", note.state);
  row(rows, "Funding", note.utxo ? `${note.utxo.sats} sats at ${note.utxo.txid}:${note.utxo.vout}` : "not confirmed");
  if (note.utxo) row(rows, "Bitcoin block", note.utxo.block_hash);
  intro.replaceChildren(rows);
  const matches = note.claim && note.claim.key === mine;
  intro.append(el("p", matches ? "This link matches the claim key on the note." : "This link is no longer active or does not match the note.", "state-title"));
  if (note.utxo) {
    try {
      const tx = await cachetChain.mempoolJson(cachetChain.mempoolBase(state.config.hrp), `/tx/${encodeURIComponent(note.utxo.txid)}`);
      const mismatch = cachetOutcome.blockHashMismatch(note, tx);
      intro.append(el("p", mismatch || `Funding block verified at ${tx.status.block_hash}.`, mismatch ? "control-status error" : "meta"));
      const link = el("a", "Open funding transaction");
      link.href = `${cachetChain.mempoolBase(state.config.hrp)}/tx/${encodeURIComponent(note.utxo.txid)}`;
      link.rel = "noopener noreferrer";
      intro.append(link);
    } catch (error) { intro.append(el("p", error.message, "control-status error")); }
  }
  intro.append(el("p", `Read at NEAR block ${state.height}.`, "meta"));
  return Boolean(matches);
}

async function connect(frag) {
  try {
    const account = await cachetWallet.connect(net.name);
    $("claim-connect-status").textContent = account;
    $("claim-connect").textContent = "Connected";
    $("claim-connect").disabled = true;
    if (frag) await showActions(frag);
  } catch (error) { status(error.message, true); }
}

function addButton(parent, label, action) {
  const button = el("button", label);
  button.type = "button";
  button.addEventListener("click", action);
  parent.append(button);
  return button;
}

async function claim(frag) {
  const account = cachetWallet.accountId;
  if (!account) return status("Connect a NEAR wallet first.", true);
  try {
    const signature = await cachetClaim.signClaim(frag.key, frag.contract, frag.token, account);
    status("Waiting for the claim transaction...");
    const result = await cachetWallet.call(frag.contract, "claim", { token_id: frag.token, new_owner: account, signature }, { tgas: 100 });
    const failed = transactionError(result);
    if (failed) return status(failed, true);
    const token = await poll(async () => (await cachetChain.callView(frag.contract, "nft_token", { token_id: frag.token }, net)).value, (value) => value?.owner_id === account, 10000, 1000);
    if (token?.owner_id !== account) return status("Claim transaction returned, but nft_token did not show your account within 10 seconds.", true);
    status(`You own note ${frag.token}.${txHash(result) ? ` Transaction ${txHash(result)}.` : ""}`);
    await showActions(frag);
  } catch (error) { status(error.message, true); }
}

async function feeDefault(base) {
  const rates = await cachetChain.mempoolJson(base, "/v1/fees/recommended");
  const half = Math.max(1, Math.ceil(Number(rates.halfHourFee)));
  return net.name === "testnet" ? Math.min(half, 5) : half;
}

function addField(form, label, id, value, placeholder = "") {
  const wrap = el("div", null, "field");
  const inputLabel = el("label", label);
  inputLabel.htmlFor = id;
  const input = el("input");
  input.id = id;
  input.value = value || "";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.autocapitalize = "none";
  wrap.append(inputLabel, input);
  form.append(wrap);
  return input;
}

async function unseal(frag, note, config, dest, fee) {
  const hrp = config.hrp;
  const len = destinationScriptLen(dest.value.trim());
  if (!accountAddress(dest.value.trim(), hrp) || !len) return status(`Enter a ${hrp} Bitcoin witness address.`, true);
  const rate = Number(fee.value.trim());
  const guard = cachetOutcome.feeGuard(note.utxo.sats, rate, len);
  if (guard) return status(guard, true);
  try {
    status("Waiting for the signer to release the Bitcoin sweep...");
    const result = await cachetWallet.call(frag.contract, "unseal", { token_id: frag.token, btc_dest: dest.value.trim().toLowerCase(), fee_rate: rate }, { tgas: 300 });
    const failed = transactionError(result);
    if (failed) { await showActions(frag); return status(failed, true); }
    const current = await poll(async () => (await viewNote(frag)).note, (value) => value?.state === "Unsealed", 180000, 3000);
    if (current?.state !== "Unsealed") return status(`The signer has not answered; Recover opens at NEAR block ${Number(current?.pending_since || note.pending_since) + 400}.`, true);
    const signed = (await cachetChain.callView(frag.contract, "signed_sweep_tx", { token_id: frag.token }, net)).value;
    await showActions(frag, current, config, signed);
  } catch (error) { status(error.message, true); }
}

async function broadcast(frag, note, signed) {
  if (!signed) return status("The contract has no signed sweep to broadcast.", true);
  const base = cachetChain.mempoolBase((await readClaimState(frag)).config.hrp);
  let txid;
  let errors = [];
  const fallback = net.name === "testnet" ? "https://blockstream.info/testnet/api/tx" : "https://blockstream.info/api/tx";
  for (const url of [`${base}/api/tx`, fallback]) {
    try {
      const response = await cachetChain.fetchWithTimeout(url, { method: "POST", headers: { "content-type": "text/plain" }, body: signed });
      const text = (await response.text()).trim();
      if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
      txid = text;
      break;
    } catch (error) { errors.push(error.message); }
  }
  if (!txid) return status(errors.join("; "), true);
  try {
    const tx = await cachetChain.mempoolJson(base, `/tx/${encodeURIComponent(txid)}`);
    if (tx.vin?.[0]?.txid !== note.utxo.txid || tx.vin?.[0]?.vout !== note.utxo.vout) return status("Broadcast tx input does not match this note's funding output.", true);
  } catch (error) { return status(`Broadcast returned ${txid}, but the transaction could not be read back: ${error.message}`, true); }
  const link = el("a", txid, "mono");
  link.href = `${base}/tx/${encodeURIComponent(txid)}`;
  link.rel = "noopener noreferrer";
  $("claim-out").append(el("p", "Bitcoin transaction accepted:"), link);
  status("Sweep broadcast and read back from mempool.space.");
}

async function showActions(frag, noteOverride, configOverride, signedOverride) {
  const box = $("claim-actions");
  box.replaceChildren();
  const state = noteOverride && configOverride ? { note: noteOverride, config: configOverride } : await readClaimState(frag);
  const { note, config } = state;
  const account = cachetWallet.accountId;
  const claimButton = addButton(box, "Claim", () => claim(frag));
  const expectedKey = await cachetClaim.publicKeyHexFromSeed(frag.key);
  claimButton.disabled = note.claim ? note.claim.key !== expectedKey : !(account && note.owner_id === account);
  if (account && note.owner_id === account && note.state === "Sealed" && note.utxo) {
    const form = el("form", null, "tool-form");
    form.noValidate = true;
    const base = cachetChain.mempoolBase(config.hrp);
    let defaultDest = "";
    let fee = 5;
    if (net.name === "testnet") {
      try { defaultDest = await cachetChain.defaultDestination(net) || ""; } catch (error) { status(`Could not read a reusable pool address: ${error.message}`, true); }
    }
    try { fee = await feeDefault(base); } catch (error) { status(`Fee estimate unavailable: ${error.message}`, true); }
    const dest = addField(form, "Bitcoin destination", "claim-destination", defaultDest, `${config.hrp}1...`);
    const feeInput = addField(form, "Fee rate, sat/vB", "claim-fee", String(fee));
    const button = el("button", "Unseal");
    button.type = "submit";
    form.append(button);
    form.addEventListener("submit", (event) => { event.preventDefault(); unseal(frag, note, config, dest, feeInput); });
    box.append(form);
  }
  if (account && note.owner_id === account && note.state === "Unsealed") {
    const signed = signedOverride || note.sweep?.signed_tx || (await cachetChain.callView(frag.contract, "signed_sweep_tx", { token_id: frag.token }, net)).value;
    const pre = el("pre", signed || "Signed sweep unavailable", "cmd-text");
    box.append(pre);
    addButton(box, "Copy signed sweep", async () => { await navigator.clipboard.writeText(signed); status("Signed sweep copied."); });
    addButton(box, "Broadcast", () => broadcast(frag, note, signed));
  }
}

async function getJudgeNote() {
  try {
    const response = await fetch("judge-links.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`judge-links.json returned HTTP ${response.status}`);
    const entries = await response.json();
    for (const entry of entries) {
      const fragment = cachetClaim.parseFragment(entry.fragment);
      if (!fragment) continue;
      const { note } = await viewNote(fragment);
      if (note?.state === "Sealed" && note.claim) { location.hash = `#${entry.fragment}`; location.reload(); return; }
    }
    status("No sealed judge note with an active claim link is available.", true);
  } catch (error) { status(error.message, true); }
}

async function init() {
  $("judge-note").addEventListener("click", getJudgeNote);
  const frag = cachetClaim.parseFragment(location.hash);
  if (!frag) return;
  $("claim-connect").addEventListener("click", () => connect(frag));
  const valid = await showClaimTarget(frag);
  if (!valid) return;
  $("claim-connect").hidden = false;
  $("claim-connect").addEventListener("click", () => connect(frag));
}

init();
