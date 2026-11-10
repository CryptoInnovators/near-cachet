"use strict";

(() => {
// The gift page. A claim link names one note. The card shows that note's live state and satoshi amount
// from the chain, and four stations carry it through claim, unseal, broadcast and finalize.

const $ = (id) => document.getElementById(id);
const net = cachetChain.network();
const { h, int, short, link, groupHex } = cachetUi;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mempool = () => cachetChain.mempoolBase(net.name === "mainnet" ? "bc" : "tb");

const session = { tx: {} }; // transaction hashes this tab sent, keyed by station
let frag = null;
let busy = false;

function status(text, error = false) {
  const target = $("claim-status");
  target.textContent = text || "";
  target.className = error ? "gift-status error" : "gift-status";
}

const txHash = (outcome) => outcome?.transaction?.hash || outcome?.transaction_outcome?.id || null;

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

const view = (method, args, account = frag.contract) => cachetChain.callView(account, method, args, net);

async function readAll() {
  const [noteR, nftR, configR] = await Promise.all([view("note", { token_id: frag.token }), view("nft_token", { token_id: frag.token }), view("config", {})]);
  const note = noteR.value && typeof noteR.value === "object" ? noteR.value : null;
  const config = configR.value;
  const base = cachetChain.mempoolBase(config.hrp);
  const outspend = note?.utxo ? await cachetChain.outspendStatus(base, note.utxo.txid, note.utxo.vout) : null;
  let spend = null;
  if (outspend?.spent === true) { try { spend = await cachetChain.mempoolJson(base, `/tx/${encodeURIComponent(note.utxo.txid)}/outspend/${note.utxo.vout}`); } catch {} }
  return { note, nft: nftR.value, config, height: noteR.blockHeight, base, outspend, spend };
}

function accountAddress(value, hrp) {
  return typeof value === "string" && new RegExp(`^${hrp}1[ac-hj-np-z02-9]{20,90}$`).test(value.toLowerCase());
}

function destinationScriptLen(value) {
  if (/1q[ac-hj-np-z02-9]{38}$/i.test(value)) return 22;
  if (/1q[ac-hj-np-z02-9]{58}$/i.test(value) || /1p[ac-hj-np-z02-9]{58}$/i.test(value)) return 34;
  return null;
}

async function feeDefault(base) {
  const rates = await cachetChain.mempoolJson(base, "/v1/fees/recommended");
  const half = Math.max(1, Math.ceil(Number(rates.halfHourFee)));
  return net.name === "testnet" ? Math.min(half, 5) : half;
}

/* ---- actions ---- */
async function connect() {
  try {
    const account = await cachetWallet.connect(net.name);
    $("claim-connect-status").textContent = short(account, 14, 8);
    $("claim-connect").textContent = "Connected";
    $("claim-connect").disabled = true;
    return account;
  } catch (error) { status(error.message, true); return null; }
}

async function claim() {
  if (busy) return;
  busy = true;
  try {
    const account = cachetWallet.accountId || await connect();
    if (!account) return;
    const signature = await cachetClaim.signClaim(frag.key, frag.contract, frag.token, account);
    status("Waiting for the claim transaction.");
    const result = await cachetWallet.call(frag.contract, "claim", { token_id: frag.token, new_owner: account, signature }, { tgas: 100 });
    const failed = cachetOutcome.failureText(result);
    if (failed) return status(failed, true);
    session.tx.claim = txHash(result);
    const token = await poll(async () => (await view("nft_token", { token_id: frag.token })).value, (value) => value?.owner_id === account, 20000, 1000);
    if (token?.owner_id !== account) return status("The claim transaction returned, but nft_token did not show your account within 20 seconds.", true);
    status(`You own note ${frag.token}.`);
  } catch (error) { status(error.message, true); }
  finally { busy = false; await render(); }
}

async function unseal(note, config, dest, fee) {
  if (busy) return;
  const hrp = config.hrp;
  const address = dest.value.trim().toLowerCase();
  const len = destinationScriptLen(address);
  if (!accountAddress(address, hrp) || !len) return status(`Enter a ${hrp} Bitcoin witness address.`, true);
  const rate = Number(fee.value.trim());
  const guard = cachetOutcome.feeGuard(note.utxo.sats, rate, len);
  if (guard) return status(guard, true);
  busy = true;
  try {
    status("Waiting for the signer to release the Bitcoin sweep.");
    const result = await cachetWallet.call(frag.contract, "unseal", { token_id: frag.token, btc_dest: address, fee_rate: rate }, { tgas: 300 });
    const failed = cachetOutcome.failureText(result);
    if (failed) return status(failed, true);
    session.tx.unseal = txHash(result);
    const current = await poll(async () => (await view("note", { token_id: frag.token })).value, (value) => value?.state === "Unsealed", 180000, 3000);
    if (current?.state !== "Unsealed") return status(`The signer has not answered. Recover opens at NEAR block ${Number(current?.pending_since || note.pending_since) + 400}.`, true);
    status("The seal is broken. The signed sweep is ready to broadcast.");
  } catch (error) { status(error.message, true); }
  finally { busy = false; await render(); }
}

async function broadcast(note, signed, base) {
  if (busy) return;
  busy = true;
  try {
    if (!signed) return status("The contract has no signed sweep to broadcast.", true);
    const fallback = net.name === "testnet" ? "https://blockstream.info/testnet/api/tx" : "https://blockstream.info/api/tx";
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
    if (!txid) return status(errors.join("; "), true);
    const tx = await cachetChain.mempoolJson(base, `/tx/${encodeURIComponent(txid)}`);
    if (tx.vin?.[0]?.txid !== note.utxo.txid || tx.vin?.[0]?.vout !== note.utxo.vout) return status("The broadcast transaction does not spend this note's funding output.", true);
    session.tx.broadcast = txid;
    status("The sweep is in the Bitcoin mempool and spends the sealed output.");
  } catch (error) { status(error.message, true); }
  finally { busy = false; await render(); }
}

async function finalize(note, config, base) {
  if (busy) return;
  busy = true;
  try {
    status("Finding the sweep and its Bitcoin inclusion proof.");
    const spend = await cachetBtcProof.spendOf(base, note.utxo.txid, note.utxo.vout);
    if (!spend) throw new Error("The sweep is not in a Bitcoin block yet.");
    const tx = await cachetChain.mempoolJson(base, `/tx/${encodeURIComponent(spend.txid)}`);
    const tip = Number((await cachetChain.mempoolText(base, "/blocks/tip/height")).trim());
    const depth = tx.status?.confirmed ? tip - Number(tx.status.block_height) + 1 : 0;
    if (depth < Number(config.confirmations)) throw new Error(`The sweep has ${depth} confirmations. ${config.confirmations} are required.`);
    const proof = await cachetBtcProof.inclusionProof(base, spend.txid);
    const result = await cachetWallet.call(frag.contract, "finalize", { token_id: frag.token, sweep_raw_tx: spend.raw_tx, proof }, { tgas: 150 });
    const failed = cachetOutcome.failureText(result);
    if (failed) throw new Error(failed);
    session.tx.finalize = txHash(result);
    await poll(async () => (await view("note", { token_id: frag.token })).value, (value) => value === null, 120000, 3000);
    status("The note is finalized and no longer exists.");
  } catch (error) { status(error.message, true); }
  finally { busy = false; await render(); }
}

/* ---- the four stations ---- */
function txLink(hash, label) { return hash ? h("p", { class: "station-tx" }, label, " ", link(`${net.nearExplorer}/txns/${hash}`, short(hash, 10, 6), "hexlink")) : null; }

function station(title, state, ...body) {
  const word = { done: "Done", current: "Now", waiting: "Waiting" }[state];
  return h("li", { class: "station", dataset: { state } }, h("div", { class: "station-head" }, h("h3", null, title), h("p", { class: "where" }, word)), ...body);
}

async function stations(s, matches) {
  const { note, nft, config, base, outspend, spend } = s;
  const account = cachetWallet.accountId;
  const owner = nft?.owner_id || null;
  const mine = Boolean(account && owner === account);
  const swept = outspend?.spent === true;
  const out = [];

  // 1 Claim
  if (!note) out.push(station("Claim", "done", h("p", { class: "say" }, `Note ${frag.token} is finalized. Its Bitcoin left to the address the owner chose.`)));
  else if (note.claim) {
    const claimBtn = h("button", { class: "btn btn-primary", id: "claim-go", type: "button", disabled: !matches, onclick: claim }, "Claim this gift");
    out.push(station("Claim", "current",
      h("p", { class: "say" }, matches ? `Connect a NEAR account and sign. The contract moves note ${frag.token} to it, and the link stops working.` : "This link no longer matches the claim key on the note."),
      claimBtn));
  } else out.push(station("Claim", "done", h("p", { class: "say" }, `nft_token(${frag.token}).owner_id reads ${owner}.`), txLink(session.tx.claim, "Claim transaction")));

  // 2 Unseal
  const sealed = note && !note.claim && note.state === "Sealed";
  if (sealed && mine) {
    const dest = h("input", { id: "claim-destination", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: `${config.hrp}1...` });
    const feeIn = h("input", { id: "claim-fee", autocomplete: "off", inputmode: "numeric" });
    const consequence = h("p", { class: "consequence-box", id: "claim-consequence", "aria-live": "polite" });
    const go = h("button", { class: "btn btn-primary", type: "submit", disabled: outspend?.spent !== false }, "Break the seal");
    const form = h("form", { class: "tool-form", novalidate: true },
      h("div", { class: "field" }, h("label", { for: "claim-destination" }, "Bitcoin destination"), dest),
      h("div", { class: "field" }, h("label", { for: "claim-fee" }, "Fee rate, sat/vB"), feeIn),
      consequence, go);
    const explain = () => {
      const len = destinationScriptLen(dest.value.trim());
      const rate = Number(feeIn.value.trim());
      if (!len || !accountAddress(dest.value.trim().toLowerCase(), config.hrp) || !Number.isInteger(rate) || rate < 1) return consequence.replaceChildren("Name a Bitcoin address and a fee rate to see the sweep before you sign.");
      const fee = rate * cachetOutcome.sweepVsize(len);
      const guard = cachetOutcome.feeGuard(note.utxo.sats, rate, len);
      consequence.replaceChildren(guard || `Breaking the seal signs a Bitcoin transaction that sends ${int(note.utxo.sats - fee)} sats to ${short(dest.value.trim(), 12, 8)}, fee ${int(fee)} sats at ${rate} sat/vB. The seal cannot be restored.`);
    };
    dest.addEventListener("input", explain); feeIn.addEventListener("input", explain);
    form.addEventListener("submit", (event) => { event.preventDefault(); unseal(note, config, dest, feeIn); });
    out.push(station("Unseal", "current", h("p", { class: "say" }, "Choose where the Bitcoin goes and at what fee."), form));
    if (net.name === "testnet") cachetChain.defaultDestination(net).then((a) => { if (a && !dest.value) { dest.value = a; explain(); } }).catch(() => {});
    feeDefault(base).then((r) => { feeIn.value = String(r); explain(); }).catch(() => { feeIn.value = "5"; explain(); });
    explain();
  } else if (note && ["Unsealing", "Resigning"].includes(note.state)) out.push(station("Unseal", "current", h("p", { class: "say" }, "The signer is producing the sweep signature.")));
  else if (!note || note.state !== "Sealed") out.push(station("Unseal", "done", h("p", { class: "say" }, "The seal is broken and the sweep is signed."), txLink(session.tx.unseal, "Unseal transaction")));
  else out.push(station("Unseal", "waiting", h("p", { class: "say" }, note.claim ? "After the claim, the owner picks a Bitcoin destination and breaks the seal." : "Connect the owner account to choose a Bitcoin destination.")));

  // 3 Broadcast
  const signed = note?.state === "Unsealed" ? (note.sweep?.signed_tx || (await view("signed_sweep_tx", { token_id: frag.token })).value) : null;
  if (signed && !swept && mine) {
    out.push(station("Broadcast", "current", h("p", { class: "say" }, "The signed sweep spends the sealed output to your destination. Broadcast it to Bitcoin."),
      h("div", { class: "actions" },
        h("button", { class: "btn btn-primary", type: "button", onclick: () => broadcast(note, signed, base) }, "Broadcast the sweep"),
        h("button", { class: "btn btn-paper", type: "button", onclick: async () => { await navigator.clipboard.writeText(signed); status("Signed sweep copied."); } }, "Copy signed sweep"))));
  } else if (swept || !note) {
    const txid = spend?.txid || session.tx.broadcast;
    out.push(station("Broadcast", "done", h("p", { class: "say" }, "The output is spent on Bitcoin."), txid ? h("p", { class: "station-tx" }, "Sweep ", link(`${base}/tx/${txid}`, short(txid, 10, 6), "hexlink")) : null));
  } else out.push(station("Broadcast", "waiting", h("p", { class: "say" }, "The signed sweep goes to Bitcoin once the seal is broken.")));

  // 4 Finalize
  if (note && swept && mine) out.push(station("Finalize", "current", h("p", { class: "say" }, `Once the sweep has ${config.confirmations} confirmations, the light client checks its proof and the note is burned.`),
    h("button", { class: "btn btn-primary", type: "button", onclick: () => finalize(note, config, base) }, "Finalize")));
  else if (!note) out.push(station("Finalize", "done", h("p", { class: "say" }, `note(${frag.token}) and nft_token(${frag.token}) read null.`), txLink(session.tx.finalize, "Finalize transaction")));
  else out.push(station("Finalize", "waiting", h("p", { class: "say" }, "After the sweep confirms, the light client checks its proof and the note is burned.")));
  return out;
}

let rendering = Promise.resolve();
function render() { rendering = rendering.then(draw, draw); return rendering; }

async function draw() {
  const s = await readAll();
  const matches = Boolean(s.note?.claim && s.note.claim.key === await cachetClaim.publicKeyHexFromSeed(frag.key));
  const slot = $("card-slot");
  if (!s.note) cachetCard.none(slot, frag.token, frag.contract);
  else cachetCard.render(slot, s.note, { net, hrp: s.config.hrp, contract: frag.contract });
  $("stations").replaceChildren(...await stations(s, matches));
  cachetUi.provenance($("foot-facts"), { net, contract: frag.contract, config: s.config, block: s.height });
  $("gift-sub").textContent = s.note ? (s.note.claim ? `A sealed Bitcoin note, ${int(s.note.utxo?.sats || 0)} sats, read live from ${frag.contract}. Connect a NEAR account to take it.` : `Note ${frag.token} belongs to ${s.nft?.owner_id}. Read live from ${frag.contract}.`) : `Note ${frag.token} is finalized on ${frag.contract}.`;
  document.body.dataset.ready = "1";
}

async function openGift() {
  $("gift-title").textContent = "Claim a Bitcoin gift.";
  $("gift-sub").textContent = `Opening the gift pool on ${net.contract}.`;
  try {
    const fragment = await cachetClaim.pickJudgeFragment(net, (f) => cachetChain.callView(f.contract, "note", { token_id: f.token }, net).then((r) => r.value));
    if (!fragment) { $("gift-sub").textContent = "No sealed gift with an open claim link is in the pool right now."; return; }
    location.hash = `#${fragment}`;
    location.reload();
  } catch (error) { $("gift-sub").textContent = error.message; }
}

async function init() {
  $("claim-connect").addEventListener("click", async () => { if (await connect()) await render(); });
  frag = cachetClaim.parseFragment(location.hash);
  if (!frag) return openGift();
  cachetCard.loading($("card-slot"), frag.token);
  try { await render(); }
  catch (error) { $("gift-sub").textContent = error.message; status(error.message, true); document.body.dataset.ready = "1"; }
}

init();

})();
