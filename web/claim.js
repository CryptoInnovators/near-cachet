"use strict";

(() => {
// The envelope screen, shared by index.html and claim.html. The pool of sealed notes is one red envelope:
// one note per share. The card shows the visitor's share, the panel claims it in one press, and the
// stations below carry the claimed share on to Bitcoin (unseal, broadcast, finalize).

const $ = (id) => document.getElementById(id);
const net = cachetChain.network();
const { h, int, short, link, btc, copyButton } = cachetUi;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FEE_FLOOR = 50000000000000000000000n; // 0.05 NEAR, enough for an unseal call from a claim account

const session = { tx: {}, keySaved: null, keyFile: null, claimed: false };
let frag = null;
let pool = []; // [{ fragment, frag }] for this contract, from judge-links.json
let shares = null; // { total, left, reads: [{ token, note }] } read from chain
let busy = false;
let lastError = null;
let slow = false;
let example = null; // { owner, tx } when every share is claimed and the last one is shown
let stationsOpen = false;
let cloudSaved = null; // account id last confirmed in Telegram CloudStorage

const tg = globalThis.Telegram?.WebApp?.initData && globalThis.Telegram.WebApp.isVersionAtLeast?.("6.9") ? globalThis.Telegram.WebApp : null;
const cloudKey = (suffix) => `cachet_${net.name}_${suffix}`;
const cloud = {
  get: (key) => new Promise((resolve, reject) => tg.CloudStorage.getItem(key, (error, value) => error ? reject(new Error(String(error))) : resolve(value || null))),
  set: (key, value) => new Promise((resolve, reject) => tg.CloudStorage.setItem(key, value, (error, ok) => error || !ok ? reject(new Error(String(error || "CloudStorage refused the key."))) : resolve())),
};
const accountKey = () => `cachet:claim-account:${net.name}`;
const savedAccount = () => {
  try { const a = JSON.parse(localStorage.getItem(accountKey()) || "null"); return a && /^[a-f0-9]{64}$/.test(a.accountId || "") && /^[a-f0-9]{64}$/.test(a.seedHex || "") ? a : null; }
  catch { return null; }
};
const you = () => cachetWallet.accountId || savedAccount()?.accountId || null;

async function restoreFromCloud() {
  if (!tg || localStorage.getItem(accountKey())) return;
  const current = await cloud.get(cloudKey("current"));
  if (!/^[a-f0-9]{64}$/.test(current || "")) return;
  const saved = JSON.parse(await cloud.get(cloudKey(current)) || "null");
  if (saved?.accountId === current && /^[a-f0-9]{64}$/.test(saved.seedHex || "") && await cachetClaim.publicKeyHexFromSeed(saved.seedHex) === current) {
    localStorage.setItem(accountKey(), JSON.stringify(saved));
    cloudSaved = current;
  }
}

async function backupToCloud(saved) {
  if (cloudSaved === saved.accountId) return true;
  const own = cloudKey(saved.accountId);
  const existing = JSON.parse(await cloud.get(own) || "null");
  if (existing && existing.seedHex !== saved.seedHex) throw new Error("Telegram cloud holds a different key for this account.");
  if (!existing) await cloud.set(own, JSON.stringify({ accountId: saved.accountId, seedHex: saved.seedHex }));
  const check = JSON.parse(await cloud.get(own) || "null");
  if (check?.seedHex !== saved.seedHex) throw new Error("Telegram cloud did not return the saved key.");
  await cloud.set(cloudKey("current"), saved.accountId);
  cloudSaved = saved.accountId;
  return true;
}

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

// The public RPCs answer 429 under load; a read retries a few times before it fails.
async function view(method, args, account = frag.contract) {
  let failure;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await cachetChain.callView(account, method, args, net); }
    catch (error) { failure = error; await delay(600 * (attempt + 1)); }
  }
  throw failure;
}

async function readFast() {
  const [noteR, nftR, configR] = await Promise.all([view("note", { token_id: frag.token }), view("nft_token", { token_id: frag.token }), view("config", {})]);
  const note = noteR.value && typeof noteR.value === "object" ? noteR.value : null;
  const config = configR.value;
  return { note, nft: nftR.value, config, height: noteR.blockHeight, base: cachetChain.mempoolBase(config.hrp), outspend: null, spend: null };
}

async function bitcoinChecks(s) {
  if (!s?.note?.utxo) return { outspend: null, spend: null };
  const outspend = await cachetChain.outspendStatus(s.base, s.note.utxo.txid, s.note.utxo.vout);
  let spend = null;
  if (outspend?.spent === true) { try { spend = await cachetChain.mempoolJson(s.base, `/tx/${encodeURIComponent(s.note.utxo.txid)}/outspend/${s.note.utxo.vout}`); } catch {} }
  return { outspend, spend };
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

/* ---- the pool is the envelope ---- */
async function loadPool() {
  try {
    const list = await (await fetch("judge-links.json", { cache: "no-store" })).json();
    pool = list.map((entry) => ({ fragment: entry.fragment, frag: cachetClaim.parseFragment(entry.fragment) })).filter((e) => e.frag && e.frag.contract === net.contract);
  } catch { pool = []; }
}

async function readShares() {
  const reads = await Promise.all(pool.map(async (e) => ({ token: e.frag.token, fragment: e.fragment, note: (await view("note", { token_id: e.frag.token }, e.frag.contract)).value })));
  shares = { ...cachetClaim.tallyShares(reads), reads };
  return shares;
}

const sharesLine = () => shares ? `${shares.left} of ${shares.total} shares left` : "";

/* ---- actions ---- */
async function connect() {
  try { return await cachetWallet.connect(net.name); }
  catch (error) { lastError = error.message; return null; }
}

// Backs up the claim account key before the claim: a file plus the clipboard, or Telegram CloudStorage inside Telegram.
async function saveKey(saved) {
  if (session.keySaved === saved.accountId) return;
  const key = await cachetLinkdrop.secretKeyString(saved.seedHex);
  if (tg) {
    await backupToCloud(saved);
    session.keyFile = null;
  } else {
    const file = `cachet-${saved.accountId.slice(0, 8)}.key`;
    const url = URL.createObjectURL(new Blob([key], { type: "text/plain" }));
    const anchor = h("a", { href: url, download: file, hidden: true });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    session.keyFile = file;
  }
  try { await navigator.clipboard.writeText(key); } catch {}
  session.keySaved = saved.accountId;
}

async function claim(useWallet = false) {
  if (busy) return;
  busy = true;
  lastError = null;
  slow = false;
  const go = $("claim-go");
  if (go) { go.disabled = true; go.textContent = useWallet ? "Waiting for your wallet…" : "Saving your key…"; }
  let account = null;
  try {
    const walletless = !useWallet && !cachetWallet.accountId && Boolean(frag.sender);
    let result;
    let signer;
    if (walletless) {
      if (net.name !== "testnet" || frag.contract !== net.contract) throw new Error("Walletless claim links are testnet only.");
      const saved = await cachetLinkdrop.createImplicitAccount(localStorage, net.name);
      account = saved.accountId;
      await saveKey(saved);
      progress("Sending the claim to NEAR. The sender pays the fee.", 1, "Key saved");
      const note = (await view("note", { token_id: frag.token })).value;
      cachetLinkdrop.assertUnclaimed(note, await cachetClaim.publicKeyHexFromSeed(frag.key));
      const signature = await cachetClaim.signClaim(frag.key, frag.contract, frag.token, account);
      result = await cachetLinkdrop.submitWalletlessClaim({
        acknowledged: session.keySaved === account,
        send: () => cachetLinkdrop.signAndSend({ signerId: frag.sender, seedHex: frag.key, contract: frag.contract, args: { token_id: frag.token, new_owner: account, signature }, net }),
      });
      signer = frag.sender;
    } else {
      account = cachetWallet.accountId || await connect();
      if (!account) return;
      progress("Sending the claim to NEAR. Approve it in your wallet.", 1, "Wallet connected");
      const signature = await cachetClaim.signClaim(frag.key, frag.contract, frag.token, account);
      result = await cachetWallet.call(frag.contract, "claim", { token_id: frag.token, new_owner: account, signature }, { tgas: 100 });
      signer = account;
    }
    const failed = cachetOutcome.failureText(result);
    if (failed) throw new Error(failed);
    const claimTx = txHash(result);
    session.tx.claim = claimTx;
    if (claimTx) localStorage.setItem(`cachet:claim-tx:${frag.contract}:${frag.token}`, claimTx);
    progress("NEAR is confirming the claim.", 2, walletless ? "Key saved" : "Wallet connected");
    if (!walletless && claimTx) {
      const optimistic = await poll(() => cachetChain.rpc("EXPERIMENTAL_tx_status", [claimTx, signer], net), (v) => ["EXECUTED_OPTIMISTIC", "FINAL"].includes(v?.final_execution_status) || Boolean(cachetOutcome.failureText(v)), 60000, 1000);
      const late = cachetOutcome.failureText(optimistic);
      if (late) throw new Error(late);
    }
    const token = await poll(async () => (await view("nft_token", { token_id: frag.token })).value, (v) => v?.owner_id === account, 30000, 1000);
    if (token?.owner_id === account) session.claimed = true; else slow = true;
    if (claimTx && signer) poll(() => cachetChain.rpc("EXPERIMENTAL_tx_status", [claimTx, signer], net), (v) => v?.final_execution_status === "FINAL", 120000, 3000).catch(() => {});
  } catch (error) { lastError = error.message; }
  finally { busy = false; await render(); }
}

async function recheck() {
  if (busy) return;
  busy = true;
  try {
    const account = you();
    const token = await poll(async () => (await view("nft_token", { token_id: frag.token })).value, (v) => v?.owner_id === account, 20000, 1000);
    if (token?.owner_id === account) { session.claimed = true; slow = false; }
  } catch (error) { lastError = error.message; }
  finally { busy = false; await render(); }
}

// Runs a contract call as the visitor: through the connected wallet, or signed by the browser's own claim account.
async function callAs(method, args, tgas) {
  if (cachetWallet.accountId) return cachetWallet.call(frag.contract, method, args, { tgas });
  const saved = savedAccount();
  if (!saved) throw new Error("No claim account is saved in this browser.");
  return cachetLinkdrop.signAndSend({ signerId: saved.accountId, seedHex: saved.seedHex, contract: frag.contract, args, net, method, tgas, restricted: false });
}

async function unseal(note, config, dest, fee) {
  if (busy) return;
  const address = dest.value.trim().toLowerCase();
  const len = destinationScriptLen(address);
  if (!accountAddress(address, config.hrp) || !len) return status(`Enter a ${config.hrp} Bitcoin witness address.`, true);
  const rate = Number(fee.value.trim());
  const guard = cachetOutcome.feeGuard(note.utxo.sats, rate, len);
  if (guard) return status(guard, true);
  busy = true;
  try {
    status("Waiting for the signer to release the Bitcoin sweep.");
    const result = await callAs("unseal", { token_id: frag.token, btc_dest: address, fee_rate: rate }, 300);
    const failed = cachetOutcome.failureText(result);
    if (failed) return status(failed, true);
    session.tx.unseal = txHash(result);
    const current = await poll(async () => (await view("note", { token_id: frag.token })).value, (v) => v?.state === "Unsealed", 180000, 3000);
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
    const result = await callAs("finalize", { token_id: frag.token, sweep_raw_tx: spend.raw_tx, proof }, 150);
    const failed = cachetOutcome.failureText(result);
    if (failed) throw new Error(failed);
    session.tx.finalize = txHash(result);
    await poll(async () => (await view("note", { token_id: frag.token })).value, (v) => v === null, 120000, 3000);
    status("The note is finalized and no longer exists.");
  } catch (error) { status(error.message, true); }
  finally { busy = false; await render(); }
}

/* ---- the panel ---- */
const txUrl = (hash) => `${net.nearExplorer}/txns/${hash}`;
const setBody = (...nodes) => $("panel-body").replaceChildren(...nodes.flat().filter(Boolean));

function amountBlock(note) {
  return note?.utxo ? [h("p", { class: "panel-sats panel-amount" }, `${int(note.utxo.sats)} sats`), h("p", { class: "panel-btc panel-amount" }, btc(note.utxo.sats))] : [h("p", { class: "panel-sats" }, "No funding yet")];
}

// One square per share: wax is open, outlined is claimed, ink is the visitor's own.
function shareRow(mineToken) {
  if (!shares?.total) return null;
  const marks = shares.reads.map((r) => {
    const open = r.note?.state === "Sealed" && r.note.claim;
    const mine = mineToken && r.token === mineToken;
    return h("li", { class: "share-mark", dataset: { state: mine ? "mine" : open ? "open" : "claimed" }, title: `Share ${r.token}` });
  });
  return h("div", { class: "shares" }, h("ul", { class: "share-marks", "aria-hidden": "true" }, marks), h("p", { class: "shares-left" }, sharesLine()));
}

function stepsRow(active, first) {
  const labels = [first, "Claim sent", "NEAR confirms"];
  return h("ol", { class: "claim-steps", "aria-label": "Claim progress" }, labels.map((label, i) => {
    const state = i < active ? "done" : i === active ? "current" : "waiting";
    return h("li", { dataset: { state } }, h("span", { class: "step-word" }, { done: "Done", current: "Now", waiting: "Waiting" }[state]), label);
  }));
}

let progressNote = null;
function progress(text, active, first) {
  setBody(amountBlock(progressNote), shareRow(null), h("p", { class: "panel-say" }, text), stepsRow(active, first));
}

function actionBar(...nodes) { return h("div", { class: "panel-act" }, ...nodes); }

function idlePanel(note) {
  const go = h("button", { class: "btn btn-primary", id: "claim-go", type: "button", onclick: () => claim(false) }, "Claim my share");
  setBody(amountBlock(note), shareRow(null),
    h("p", { class: "panel-say" }, frag.sender ? "Your share goes into a new claim account in this browser. No NEAR wallet needed." : "Connect a NEAR account and sign. The contract moves your share to it, and the link stops working."),
    actionBar(go, frag.sender ? h("button", { class: "textlink panel-alt", type: "button", onclick: () => claim(true) }, "Use my NEAR wallet instead") : null),
    frag.sender ? h("p", { class: "panel-note" }, "Your key is saved as a file when you claim. Keep it to keep the share.") : null);
  if (!frag.sender) go.textContent = "Claim with my NEAR wallet";
}

function errorPanel(note, message) {
  setBody(h("div", { class: "panel-state", role: "alert" },
    h("h2", { class: "panel-title" }, "The claim did not go through."),
    h("p", { class: "panel-say" }, message),
    h("p", { class: "panel-say" }, "Your share is still sealed.")),
  actionBar(h("button", { class: "btn btn-primary", id: "claim-go", type: "button", onclick: () => claim(false) }, "Try again")));
}

function slowPanel() {
  setBody(h("div", { class: "panel-state" },
    h("h2", { class: "panel-title" }, "NEAR accepted the claim."),
    h("p", { class: "panel-say" }, "The new owner has not shown yet."),
    session.tx.claim ? h("p", { class: "panel-tx" }, link(txUrl(session.tx.claim), "Claim transaction ", "hexlink"), link(txUrl(session.tx.claim), short(session.tx.claim, 4, 6), "hexlink")) : null),
  actionBar(h("button", { class: "btn btn-primary", type: "button", onclick: recheck }, "Check again")));
}

async function nextShare() {
  await readShares();
  const open = shares.reads.find((r) => r.note?.state === "Sealed" && r.note.claim && r.token !== frag.token);
  if (!open) return location.assign("hongbao.html");
  history.replaceState(null, "", `${location.pathname}${location.search}#${open.fragment}`);
  location.reload();
}

// The claim transaction of a token never changes once found, so it is cached per token and owner.
async function findClaimTx(token, owner) {
  const key = `cachet:claimtx:${net.contract}:${token}:${owner}`;
  try { const hit = JSON.parse(localStorage.getItem(key) || "null"); if (hit?.hash) return hit; } catch {}
  const found = await cachetChain.claimTx(net.contract, token, owner, net);
  if (found) localStorage.setItem(key, JSON.stringify(found));
  return found;
}

async function claimTxOf(owner) {
  if (session.tx.claim && owner === you()) return session.tx.claim;
  const stored = owner === you() ? localStorage.getItem(`cachet:claim-tx:${frag.contract}:${frag.token}`) : null;
  if (stored) return stored;
  try { return (await findClaimTx(frag.token, owner))?.hash || null; } catch { return null; }
}

async function openedPanel(note, owner, since) {
  const hash = await claimTxOf(owner);
  setBody(h("div", { class: "panel-state" },
    h("h2", { class: "panel-title" }, "This share was already claimed."),
    h("p", { class: "panel-say" }, owner ? `Note #${frag.token} belongs to ${short(owner)}${since ? ` since NEAR block ${int(since)}` : ""}.` : `Note #${frag.token} is finalized.`),
    shareRow(null)),
  actionBar(h("button", { class: "btn btn-primary", type: "button", onclick: nextShare }, "Claim the next share"),
    hash ? h("a", { class: "textlink panel-alt", href: txUrl(hash), target: "_blank", rel: "noopener noreferrer" }, "See the claim on NEAR") : null));
}

async function examplePanel(s) {
  const owner = s.nft?.owner_id;
  setBody(amountBlock(s.note), h("p", { class: "panel-say" }, `Owner: ${short(owner || "")}`),
    example?.tx ? h("p", { class: "panel-tx" }, link(txUrl(example.tx), "Claim transaction ", "hexlink"), link(txUrl(example.tx), short(example.tx, 4, 6), "hexlink")) : null,
    actionBar(h("a", { class: "btn btn-primary", href: "hongbao.html" }, "Send an envelope")));
}

async function ownedPanel(s, account) {
  const saved = savedAccount();
  const walletless = !cachetWallet.accountId && saved?.accountId === account;
  const hash = await claimTxOf(account);
  const key = walletless ? await cachetLinkdrop.secretKeyString(saved.seedHex) : null;
  const next = [];
  if (s.note?.state === "Sealed") {
    next.push(h("button", { class: "btn btn-paper", id: "move-go", type: "button", disabled: stationsOpen, onclick: () => { stationsOpen = true; $("stations").hidden = false; $("move-go").disabled = true; $("stations").scrollIntoView({ block: "nearest", behavior: cachetUi.reducedMotion() ? "auto" : "smooth" }); } }, "Move it to a Bitcoin address"));
  }
  setBody(
    h("div", { class: "panel-state" },
      h("h2", { class: "panel-title" }, session.claimed ? "Your share is yours." : "Your share."),
      h("p", { class: "panel-say" }, session.claimed ? sharesLine() : null)),
    ...amountBlock(s.note).slice(0, 2),
    h("dl", { class: "panel-rows" },
      h("div", null, h("dt", null, "Owner"), h("dd", null, `you, claim account ${short(account, 8, 6)}`)),
      hash ? h("div", null, h("dt", null, "Claim transaction"), h("dd", null, link(txUrl(hash), short(hash, 4, 6), "hexlink"))) : null,
      walletless ? h("div", null, h("dt", null, "Key"), h("dd", null, session.keyFile || tg ? `Saved as ${session.keyFile || "your Telegram cloud backup"}.` : "Saved on this browser.", copyButton(key, "Copy key again"))) : null),
    shareRow(frag.token),
    next.length ? actionBar(...next) : null,
    h("p", { class: "panel-note" }, link("hongbao.html", "Send a red envelope like this one")));
  $("stations").hidden = !(stationsOpen || (s.note && s.note.state !== "Sealed"));
}

/* ---- the stations ---- */
function txLink(hash, label) { return hash ? h("p", { class: "station-tx" }, label, " ", link(txUrl(hash), short(hash, 10, 6), "hexlink")) : null; }

function station(title, state, ...body) {
  const word = { done: "Done", current: "Now", waiting: "Waiting" }[state];
  return h("li", { class: "station", dataset: { state } }, h("div", { class: "station-head" }, h("h3", null, title), h("p", { class: "where" }, word)), ...body);
}

async function accountFunds(account) {
  try { const r = await cachetChain.rpc("query", { request_type: "view_account", finality: "final", account_id: account }, net); return BigInt(r.amount); }
  catch (error) { if (/does not exist|unknown/i.test(error.message)) return 0n; throw error; }
}

async function stations(s) {
  const { note, config, base, outspend, spend } = s;
  const account = you();
  const owner = s.nft?.owner_id || null;
  const mine = Boolean(account && owner === account);
  const swept = outspend?.spent === true;
  const out = [];

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
    const own = !cachetWallet.accountId && savedAccount()?.accountId === account;
    const funds = own ? h("p", { class: "consequence-box", id: "claim-funds" }, "Checking the claim account balance.") : null;
    if (own) accountFunds(account).then((n) => {
      funds.textContent = n >= FEE_FLOOR ? "This claim account pays the network fee for the unseal call." : "";
      if (n < FEE_FLOOR) funds.replaceChildren(`This claim account pays its own network fee. Send about 0.05 NEAR to ${account} `, copyButton(account, "Copy account"), ", then break the seal. A NEAR wallet that imports your saved key can do the same.");
    }).catch(() => { funds.textContent = ""; });
    out.push(station("Unseal", "current", h("p", { class: "say" }, "Choose the Bitcoin address that receives the share and the fee."), funds, form));
    if (net.name === "testnet") cachetChain.defaultDestination(net).then((a) => { if (a && !dest.value) { dest.value = a; explain(); } }).catch(() => {});
    feeDefault(base).then((r) => { feeIn.value = String(r); explain(); }).catch(() => { feeIn.value = "5"; explain(); });
    explain();
  } else if (note && ["Unsealing", "Resigning"].includes(note.state)) out.push(station("Unseal", "current", h("p", { class: "say" }, "The signer is producing the sweep signature.")));
  else if (!note || note.state !== "Sealed") out.push(station("Unseal", "done", h("p", { class: "say" }, "The seal is broken and the sweep is signed."), txLink(session.tx.unseal, "Unseal transaction")));
  else out.push(station("Unseal", "waiting", h("p", { class: "say" }, "Claim the share first, then pick a Bitcoin destination.")));

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

  if (note && swept && mine) out.push(station("Finalize", "current", h("p", { class: "say" }, `Once the sweep has ${config.confirmations} confirmations, the light client checks its proof and the note is burned.`),
    h("button", { class: "btn btn-primary", type: "button", onclick: () => finalize(note, config, base) }, "Finalize")));
  else if (!note) out.push(station("Finalize", "done", h("p", { class: "say" }, "The note is finalized and no longer exists."), txLink(session.tx.finalize, "Finalize transaction")));
  else out.push(station("Finalize", "waiting", h("p", { class: "say" }, "After the sweep confirms, the light client checks its proof and the note is burned.")));
  return out;
}

/* ---- draw ---- */
let rendering = Promise.resolve();
function render() { rendering = rendering.then(draw, draw); return rendering; }

function heading(title, sub) {
  $("gift-title").textContent = title;
  $("gift-sub").textContent = sub;
}

async function draw() {
  const [s] = await Promise.all([readFast(), readShares()]);
  const account = you();
  const owner = s.nft?.owner_id || null;
  const mine = Boolean(account && owner === account);
  const open = Boolean(s.note?.claim && frag.key && s.note.claim.key === await cachetClaim.publicKeyHexFromSeed(frag.key));
  const sender = frag.sender || pool[0]?.frag.sender || net.poolOwner || owner;
  const slot = $("gift-card");
  if (!s.note) cachetCard.none(slot, frag.token, frag.contract);
  else cachetCard.render(slot, s.note, { net, hrp: s.config.hrp, contract: frag.contract, you: account, proofHref: "index.html#record" });
  progressNote = s.note;
  if (example) {
    heading("Every share is claimed.", example.block ? `Here is the last one, claimed at NEAR block ${int(example.block)}.` : "Here is the last one.");
    await examplePanel(s);
  } else if (mine) {
    heading(session.claimed ? "The envelope is yours to keep." : "Your Bitcoin share.", `Test envelope on Bitcoin testnet, sent by ${sender}. ${sharesLine()}.`);
    if (slow && !session.claimed) slowPanel(); else await ownedPanel(s, account);
  } else if (open) {
    heading("A Bitcoin red envelope is waiting.", `Test envelope on Bitcoin testnet, sent by ${sender}. ${sharesLine()}.`);
    if (slow) slowPanel();
    else if (lastError) errorPanel(s.note, lastError);
    else idlePanel(s.note);
  } else {
    heading("A Bitcoin red envelope.", `Test envelope on Bitcoin testnet, sent by ${sender}. ${sharesLine()}.`);
    await openedPanel(s.note, owner, null);
  }
  $("stations").replaceChildren(...(mine && !example ? (await stations(s)) : []));
  if (mine && !example) $("stations").hidden = !(stationsOpen || (s.note && s.note.state !== "Sealed"));
  else $("stations").hidden = true;
  cachetUi.provenance($("foot-facts"), { net, contract: frag.contract, config: s.config, block: s.height });
  strip(frag.contract, s.height);
  document.body.dataset.ready = "1";
  if (s.note?.utxo && mine) {
    bitcoinChecks(s).then(async (checks) => {
      s.outspend = checks.outspend; s.spend = checks.spend;
      if ($("stations").hidden && !stationsOpen) return;
      $("stations").replaceChildren(...await stations(s));
    }).catch(() => {});
  }
  recent();
}

let stripBusy = false;
async function strip(contract, block) {
  if (stripBusy) return;
  stripBusy = true;
  try {
    const latest = await cachetChain.latestTx(contract, net);
    $("gift-strip").replaceChildren(...[
      link(`${net.nearExplorer}/address/${encodeURIComponent(contract)}`, contract), " · read at NEAR block ", int(block),
      ...(latest ? [" · latest tx ", link(txUrl(latest.hash), short(latest.hash, 4, 6), "hexlink")] : [])]);
  } catch { $("gift-strip").replaceChildren(link(`${net.nearExplorer}/address/${encodeURIComponent(contract)}`, contract), " · read at NEAR block ", int(block)); }
  finally { stripBusy = false; }
}

// Below the fold on index: the last five claimed shares, each with its claim transaction, read from the chain.
let recentDone = false;
async function recent() {
  const list = $("recent-list");
  if (!list || recentDone || !shares) return;
  recentDone = true;
  const claimed = shares.reads.filter((r) => !(r.note?.state === "Sealed" && r.note.claim)).slice(-5);
  const found = [];
  for (const r of claimed) {
    try {
      const owner = (await view("nft_token", { token_id: r.token })).value?.owner_id;
      const t = owner ? await findClaimTx(r.token, owner) : null;
      if (t) found.push({ token: r.token, owner, ...t });
    } catch {}
  }
  const rows = found.sort((a, b) => b.blockHeight - a.blockHeight);
  if (!rows.length) { recentDone = false; return; }
  list.replaceChildren(...rows.map((r) => h("li", { class: "recent-row" },
    h("span", { class: "recent-note" }, `Share #${r.token}`), h("span", null, short(r.owner, 8, 6)),
    h("span", null, `NEAR block ${int(r.blockHeight)}`), link(txUrl(r.hash), short(r.hash, 4, 6), "hexlink"))));
  $("recent").hidden = false;
}

/* ---- start ---- */
async function lastClaimed() {
  for (const r of [...shares.reads].reverse()) {
    if (r.note?.state === "Sealed" && r.note.claim) continue;
    const owner = (await view("nft_token", { token_id: r.token }, frag?.contract || net.contract)).value?.owner_id;
    if (!owner) continue;
    const t = await findClaimTx(r.token, owner).catch(() => null);
    return { token: r.token, fragment: r.fragment, owner, tx: t?.hash || null, block: t?.blockHeight || null };
  }
  return null;
}

async function choose() {
  const saved = savedAccount();
  if (!frag && saved) {
    const owned = (await view("nft_tokens_for_owner", { account_id: saved.accountId, from_index: null, limit: 20 }, net.contract)).value;
    const token = Array.isArray(owned) ? owned.find((t) => pool.some((e) => e.frag.token === t.token_id)) : null;
    if (token) { frag = { contract: net.contract, token: token.token_id, sender: pool[0]?.frag.sender }; return; }
  }
  if (frag) return;
  const fragment = await cachetClaim.pickJudgeFragment(net, (f) => view("note", { token_id: f.token }, f.contract).then((r) => r.value), pool.map((e) => ({ fragment: e.fragment })));
  if (fragment) {
    history.replaceState(null, "", `${location.pathname}${location.search}#${fragment}`);
    frag = cachetClaim.parseFragment(fragment);
    return;
  }
  await readShares();
  const last = await lastClaimed();
  if (!last) throw new Error(`${net.contract} holds no envelope to show.`);
  frag = cachetClaim.parseFragment(last.fragment);
  example = last;
}

async function init() {
  cachetUi.reveal(document);
  if (tg) {
    tg.ready();
    tg.expand();
    document.documentElement.classList.add("in-telegram");
    try { await restoreFromCloud(); } catch (error) { status(`Telegram cloud read failed: ${error.message}`, true); }
  }
  frag = cachetClaim.parseFragment(location.hash);
  if (!frag) {
    const fragment = cachetClaim.parseMiniAppStartParam(new URLSearchParams(location.search).get("tgWebAppStartParam"));
    if (fragment) {
      history.replaceState(null, "", `${location.pathname}${location.search}#${fragment}`);
      frag = cachetClaim.parseFragment(location.hash);
    }
  }
  cachetCard.loading($("gift-card"), frag?.token || "");
  try {
    await loadPool();
    await choose();
    session.tx.claim = localStorage.getItem(`cachet:claim-tx:${frag.contract}:${frag.token}`) || null;
    await render();
  } catch (error) {
    heading("A Bitcoin red envelope.", error.message);
    status(error.message, true);
    document.body.dataset.ready = "1";
  }
}

init();

})();
