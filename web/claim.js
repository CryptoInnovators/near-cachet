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
const FEE_LOW = 350000000000000000000000n; // 0.35 NEAR: an unseal prepays 300 Tgas, which costs 0.3 NEAR before the refund

const isSwept = (s) => Boolean(s?.outspend?.spent === true || session.tx.broadcast);
const CLAIM_ACTION = "Take the note";
// The person a heir note is bound to: a name the giver registered with /heir in the bot, else a plain role word.
let heirName = null;
const who = () => heirName || "the named heir";
async function loadHeirName(address) {
  if (!address || heirName !== null) return;
  try { heirName = (await (await fetch(`/api/heir-name?addr=${encodeURIComponent(address)}`)).json()).name || ""; } catch { heirName = ""; }
}
const session = { tx: {}, keySaved: null, keyFile: null, claimed: false, steal: null };
// The thief's address in the "Steal this link" attempt: any valid witness address that is not the bound heir.
const THIEF_ADDRESS = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
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
const CLOUD_WAIT_MS = 6000; // a Telegram host that never answers must not hold the envelope on its loading screen
const cloudWait = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Telegram did not answer in time.")), CLOUD_WAIT_MS))]);
const cloud = {
  get: (key) => cloudWait(new Promise((resolve, reject) => tg.CloudStorage.getItem(key, (error, value) => error ? reject(new Error(String(error))) : resolve(value || null)))),
  set: (key, value) => cloudWait(new Promise((resolve, reject) => tg.CloudStorage.setItem(key, value, (error, ok) => error || !ok ? reject(new Error(String(error || "CloudStorage refused the key."))) : resolve()))),
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
  const rates = await cachetChain.feeRates(base);
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

const sharesLine = () => shares ? `${shares.left} of ${shares.total} envelopes left` : "";

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
  // A page without focus never settles a clipboard write; the key is already safe in Telegram, so the copy never gates the claim.
  try { await Promise.race([navigator.clipboard.writeText(key), delay(1500)]); } catch {}
  session.keySaved = saved.accountId;
}

async function claim(useWallet = false) {
  if (busy) return;
  busy = true;
  lastError = null;
  slow = false;
  const go = $("claim-go");
  if (go) { go.disabled = true; go.textContent = useWallet ? "Waiting for your wallet…" : "Saving your key…"; }
  nativeMain({ text: useWallet ? "Waiting for your wallet…" : "Saving your key…", busy: true });
  let account = null;
  let walletless = false;
  try {
    walletless = !useWallet && !cachetWallet.accountId && Boolean(frag.sender);
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
    if (token?.owner_id === account) { session.claimed = true; T()?.haptic("success"); } else slow = true;
    if (claimTx && signer) poll(() => cachetChain.rpc("EXPERIMENTAL_tx_status", [claimTx, signer], net), (v) => v?.final_execution_status === "FINAL", 120000, 3000).catch(() => {});
  } catch (error) {
    // A submit that timed out or was rate limited may still have landed: the chain decides.
    const landed = account ? await poll(async () => (await view("nft_token", { token_id: frag.token })).value, (v) => v?.owner_id === account, 12000, 1500).catch(() => null) : null;
    if (landed?.owner_id === account) session.claimed = true; else lastError = error.message;
  }
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
  return cachetLinkdrop.signAndSend({ signerId: saved.accountId, seedHex: saved.seedHex, contract: frag.contract, args, net, method, tgas, restricted: false, waitForAccountMs: 45000 });
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
    await ensureFee();
    status("Waiting for the signer to release the Bitcoin sweep.");
    let transport = null;
    try {
      const result = await callAs("unseal", { token_id: frag.token, btc_dest: address, fee_rate: rate }, 300);
      const failed = cachetOutcome.failureText(result);
      if (failed) return status(failed, true);
      session.tx.unseal = txHash(result);
    } catch (error) { transport = error; status("Waiting for the signer to release the Bitcoin sweep."); }
    // The signer answers a few blocks after the call; a relay timeout or a 502 does not mean the call failed, the chain decides.
    const current = await poll(async () => (await view("note", { token_id: frag.token })).value, (v) => v?.state === "Unsealed", transport ? 120000 : 180000, 3000);
    if (transport && current?.state !== "Unsealed") return status(transport.message, true);
    if (current?.state !== "Unsealed") return status(`The signer has not answered. Recover opens at NEAR block ${Number(current?.pending_since || note.pending_since) + 400}.`, true);
    status("The note is unlocked. The signed sweep is ready to broadcast.");
  } catch (error) { status(error.message, true); }
  finally { busy = false; await render(); }
}

// A claim account with no NEAR asks the fee sponsor once; the sponsor only pays accounts that hold a note.
async function ensureFee() {
  const account = you();
  if (!account || cachetWallet.accountId) return;
  if (await accountFunds(account) < FEE_LOW) { status("Asking the sponsor for the network fee."); await sponsor(account); }
}

// The visitor holds the link, so they are the thief: they send the sweep to an address that is not the heir
// and the contract decides. A refusal is the product working; an acceptance is shown as such.
async function steal(note, feeIn) {
  if (busy) return;
  busy = true;
  session.steal = { pending: true };
  await render();
  try {
    try { await ensureFee(); } catch (error) { throw new Error(`The network fee could not be arranged: ${error.message}`); }
    const rate = Number(feeIn.value.trim()) || 5;
    const result = await callAs("unseal", { token_id: frag.token, btc_dest: THIEF_ADDRESS, fee_rate: rate }, 300);
    const failed = cachetOutcome.failureText(result);
    session.steal = { hash: txHash(result), refused: Boolean(failed), reason: failed ? String(failed).replace(/^Smart contract panicked: /, "") : null };
  } catch (error) { session.steal = { error: error.message }; }
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
    for (const url of [fallback, `${base}/api/tx`]) {
      try {
        const response = await cachetChain.fetchWithTimeout(url, { method: "POST", headers: { "content-type": "text/plain" }, body: signed });
        const text = (await response.text()).trim();
        if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
        txid = text;
        break;
      } catch (error) { errors.push(error.message); }
    }
    if (!txid) return status(errors.join("; "), true);
    // A node that just accepted the transaction can answer 404 for a few seconds while the explorers catch up.
    let tx = null;
    for (let attempt = 0; attempt < 6 && !tx; attempt += 1) {
      try { tx = await cachetChain.mempoolJson(base, `/tx/${encodeURIComponent(txid)}`); }
      catch (error) { if (attempt === 5) break; await new Promise((resolve) => setTimeout(resolve, 2500)); }
    }
    if (tx && (tx.vin?.[0]?.txid !== note.utxo.txid || tx.vin?.[0]?.vout !== note.utxo.vout)) return status("The broadcast transaction does not spend this note's funding output.", true);
    session.tx.broadcast = txid;
    status("The sweep is in the Bitcoin mempool and spends the locked output.");
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
const T = () => (globalThis.cachetTma?.inTelegram() ? globalThis.cachetTma : null);
// The Telegram MainButton carries the primary action; the in-page button is hidden while it is shown.
function nativeMain(config) {
  const t = T();
  if (!t) return false;
  const ok = t.main(config);
  document.documentElement.classList.toggle("has-main", Boolean(config) && ok);
  return ok;
}
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

function stepsRow(active, first, second = "Claim sent") {
  const labels = [first, second, "NEAR confirms"];
  return h("ol", { class: "claim-steps", "aria-label": "Claim progress" }, labels.map((label, i) => {
    const state = i < active ? "done" : i === active ? "current" : "waiting";
    return h("li", { dataset: { state } }, h("span", { class: "step-word" }, { done: "Done", current: "Now", waiting: "Waiting" }[state]), label);
  }));
}

let progressNote = null;
function progress(text, active, first, second) {
  nativeMain({ text: ["Saving your key…", "Claiming…", "Confirming…"][active] || "Working…", busy: true });
  setBody(amountBlock(progressNote), shareRow(null), h("p", { class: "panel-say" }, text), stepsRow(active, first, second));
}

function actionBar(...nodes) { return h("div", { class: "panel-act" }, ...nodes); }

function idlePanel(note) {
  const inTelegram = Boolean(tg || globalThis.Telegram?.WebApp?.initData);
  const go = !inTelegram && frag.sender
    ? h("a", { class: "btn btn-primary", id: "open-telegram", href: `https://t.me/cachet_envelope_bot/envelope?startapp=${btoa(location.hash.slice(1)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}` }, "Open in Telegram")
    : h("button", { class: "btn btn-primary", id: "claim-go", type: "button", onclick: () => claim(false) }, CLAIM_ACTION);
  setBody(amountBlock(note), shareRow(null),
    note?.heir && !inTelegram ? h("p", { class: "panel-lock" }, "Only ", h("strong", null, short(note.heir, 12, 8)), " can open this") : null,
    h("p", { class: "panel-say" }, frag.sender ? (inTelegram ? "The note goes into a claim account saved in your Telegram. A stolen link can only pay the address above." : "This envelope is claimed inside Telegram. No NEAR wallet needed.") : "Connect a NEAR account and sign. The contract moves your share to it, and the link stops working."),
    actionBar(go, frag.sender ? h("button", { class: "textlink panel-alt", type: "button", onclick: () => claim(true) }, "Use my NEAR wallet instead") : null),
    frag.sender ? h("p", { class: "panel-note" }, (inTelegram ? "Your key is backed up in your Telegram cloud when you claim." : "Your key is saved as a file when you claim. Keep it to keep the share.")) : null);
  if (!frag.sender) go.textContent = "Claim with my NEAR wallet";
  if (inTelegram && go.id === "claim-go") nativeMain({ text: CLAIM_ACTION, onClick: () => claim(false) });
}

function errorPanel(note, message, retry = () => claim(false), still = "The note is still waiting for you.") {
  T()?.haptic("error");
  nativeMain({ text: "Try again", onClick: retry });
  T()?.back(() => { lastError = null; slow = false; render(); });
  setBody(h("div", { class: "panel-state", role: "alert" },
    h("h2", { class: "panel-title" }, "The claim did not go through."),
    h("p", { class: "panel-say" }, message),
    h("p", { class: "panel-say" }, still)),
  actionBar(h("button", { class: "btn btn-primary", id: "claim-go", type: "button", onclick: retry }, "Try again")));
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
  let found = null;
  for (let attempt = 0; attempt < 3 && !found; attempt++) {
    try { found = await cachetChain.claimTx(net.contract, token, owner, net); } catch { await delay(800 * (attempt + 1)); }
  }
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
  if (s.note?.state === "Sealed" && !s.note.claim && !s.note.heir) next.push(h("button", { class: "btn btn-primary", id: "pass-go", type: "button", onclick: () => passOn(s.note) }, "Pass it on"));
  if (s.note?.state === "Sealed" && !s.note.heir) {
    next.push(h("button", { class: "btn btn-paper", id: "move-go", type: "button", disabled: stationsOpen, onclick: () => { stationsOpen = true; $("stations").hidden = false; $("move-go").disabled = true; $("stations").scrollIntoView({ block: "nearest", behavior: cachetUi.reducedMotion() ? "auto" : "smooth" }); } }, "Move it to a Bitcoin address"));
  }
  setBody(
    h("div", { class: "panel-state" },
      h("h2", { class: "panel-title" }, s.note?.heir && isSwept(s) ? "Delivered." : session.passedIn ? "The note is yours." : session.claimed ? "You hold the note." : "Your note."),
      h("p", { class: "panel-say" }, s.note?.heir && isSwept(s) ? `${who()} holds the Bitcoin. The note's sweep paid no other address.` : session.proof || (session.claimed && !s.note?.heir ? sharesLine() : null))),
    ...(s.note?.heir ? [] : amountBlock(s.note).slice(0, 2)),
    ...((rowsNode, shareNode) => (s.note?.heir
      ? [h("details", { class: "more", id: "owner-details" }, h("summary", null, "Details: owner, claim transaction, key"), rowsNode, shareNode)]
      : [rowsNode, shareNode]))(
    h("dl", { class: "panel-rows" },
      h("div", null, h("dt", null, "Owner"), h("dd", null, `you, claim account ${short(account, 8, 6)}`)),
      hash ? h("div", null, h("dt", null, localStorage.getItem(kindKey()) === "transfer" ? "Hand-off transaction" : "Claim transaction"), h("dd", null, link(txUrl(hash), short(hash, 4, 6), "hexlink"))) : null,
      walletless ? h("div", null, h("dt", null, "Key"), h("dd", null, session.keyFile || tg ? `Saved as ${session.keyFile || "your Telegram cloud backup"}.` : "Saved on this browser.", copyButton(key, "Copy key again"))) : null),
    shareRow(frag.token)),
    next.length ? actionBar(...next) : null,
    h("p", { class: "panel-note" }, link("hongbao.html", "Send a red envelope like this one")));
  $("stations").hidden = !(stationsOpen || (s.note && s.note.state !== "Sealed"));
}

/* ---- passing a note on ---- */
const kindKey = () => `cachet:claim-tx-kind:${frag.contract}:${frag.token}`;
const passedKey = () => `cachet:passed:${frag.contract}:${frag.token}`;
const readPassed = () => { try { const r = JSON.parse(localStorage.getItem(passedKey()) || "null"); return r?.link && /^[a-f0-9]{64}$/.test(r.to || "") ? r : null; } catch { return null; } };
const sameOutput = (a, b) => Boolean(a && b && a.txid === b.txid && a.vout === b.vout && a.sats === b.sats);
const outputText = (u) => `${short(u.txid, 8, 6)}:${u.vout}`;

// The sponsor pays the network fee of an account that holds a note and no NEAR (worker route /api/sponsor).
async function sponsor(account) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    const response = await fetch("/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account, init_data: tg?.initData || "" }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    failure = new Error(body.error || `The fee sponsor answered HTTP ${response.status}.`);
    if (![429, 502, 503, 504].includes(response.status)) throw failure;
  }
  throw failure;
}

async function passOn(note) {
  if (busy) return;
  busy = true;
  lastError = null;
  const go = $("pass-go");
  if (go) { go.disabled = true; go.textContent = "Passing it on…"; }
  try {
    const me = you();
    const seed = cachetClaim.newSeedHex();
    const to = await cachetClaim.publicKeyHexFromSeed(seed);
    progressNote = note;
    let result;
    if (cachetWallet.accountId) {
      progress("Passing the note on. Approve it in your wallet.", 1, "Link made", "Hand-off sent");
      result = await cachetWallet.call(frag.contract, "nft_transfer", { receiver_id: to, token_id: frag.token }, { tgas: 30, yocto: "1" });
    } else {
      const saved = savedAccount();
      if (!saved) throw new Error("No claim account is saved in this browser.");
      if (await accountFunds(me) < FEE_LOW) { progress("Asking the sponsor for the network fee.", 0, "Link made", "Hand-off sent"); await sponsor(me); }
      progress("Passing the note on. NEAR confirms in about two seconds.", 1, "Link made", "Hand-off sent");
      result = await cachetLinkdrop.signAndSend({ signerId: me, seedHex: saved.seedHex, contract: frag.contract, args: { receiver_id: to, token_id: frag.token }, net, method: "nft_transfer", tgas: 30, restricted: false, deposit: 1n, waitForAccountMs: 20000 });
    }
    const failed = cachetOutcome.failureText(result);
    if (failed) throw new Error(failed);
    const tx = txHash(result);
    const owner = await poll(async () => (await view("nft_token", { token_id: frag.token })).value, (v) => v?.owner_id === to, 30000, 1000);
    if (owner?.owner_id !== to) throw new Error("NEAR accepted the hand-off but the new holder has not shown yet. Check again in a moment.");
    const after = (await view("note", { token_id: frag.token })).value;
    const link = `${new URL("claim.html", location.href).href.split("#")[0]}#${cachetClaim.buildFragment({ contract: frag.contract, token: frag.token, key: seed, sender: me, pass: true })}`;
    localStorage.setItem(passedKey(), JSON.stringify({ link, to, tx, from: me, utxo: note.utxo, unchanged: after?.state === "Sealed" && sameOutput(note.utxo, after.utxo), at: Date.now() }));
  } catch (error) { lastError = error.message; status(error.message, true); }
  finally { busy = false; await render(); }
}

function passedPanel(s, rec) {
  const u = rec.utxo;
  const url = `https://t.me/share/url?url=${encodeURIComponent(rec.link)}&text=${encodeURIComponent(`A Bitcoin note for you, ${int(u.sats)} sats. Check the lock, then take it.`)}`;
  setBody(
    h("div", { class: "panel-state" }, h("h2", { class: "panel-title" }, "Send this link."), h("p", { class: "panel-say" }, "Whoever opens it checks the lock and takes the note. It works once.")),
    ...amountBlock(s.note).slice(0, 2),
    h("dl", { class: "panel-rows" },
      h("div", null, h("dt", null, "Lock"), h("dd", null, rec.unchanged ? `Locked, and the Bitcoin output ${outputText(u)} did not move.` : "The note changed during the hand-off. Read it before you send the link.")),
      h("div", null, h("dt", null, "Hand-off transaction"), h("dd", null, link(txUrl(rec.tx), short(rec.tx, 4, 6), "hexlink"))),
      h("div", null, h("dt", null, "Link"), h("dd", null, h("span", { class: "pass-link", id: "pass-link", dataset: { link: rec.link }, title: "The full link is copied by Copy link" }, `${rec.link.replace(/^https?:\/\//, "").slice(0, 38)}…`), copyButton(rec.link, "Copy link")))),
    actionBar(h("a", { class: "btn btn-primary", id: "pass-share", href: url, target: "_blank", rel: "noopener noreferrer" }, "Send on Telegram")),
    h("p", { class: "panel-note" }, "If the link goes unused, open it yourself to take the note back."));
}

async function receiverPanel(s) {
  const u = s.note?.utxo;
  let spent = null;
  for (let attempt = 0; u && spent === null && attempt < 3; attempt++) {
    if (attempt) await delay(1500);
    spent = (await Promise.race([cachetChain.outspendStatus(s.base, u.txid, u.vout), delay(8000).then(() => ({ spent: null }))])).spent;
  }
  const sealed = s.note?.state === "Sealed" && !s.note.claim;
  const checks = [
    ["Lock", sealed ? "Locked. No one holds a key that can spend it." : `Not accepted: the note reads ${s.note?.state || "missing"}.`],
    ["Bitcoin output", u ? (spent === false ? `${outputText(u)} is unspent on Bitcoin.` : spent === true ? `${outputText(u)} is spent. Do not take this note.` : `${outputText(u)}, Bitcoin explorer not read.`) : "No funding yet."],
  ];
  const ok = sealed && u && spent !== true;
  setBody(...amountBlock(s.note).slice(0, 2),
    h("dl", { class: "panel-rows" }, ...checks.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v)))),
    shareRow(frag.token),
    actionBar(h("button", { class: "btn btn-primary", id: "take-go", type: "button", disabled: !ok, onclick: takeIt }, "Take it"),
      cachetWallet.accountId ? null : h("p", { class: "panel-note" }, "The note goes into a new account in this browser. Its key is saved as a file when you take it.")));
}

async function takeIt() {
  if (busy) return;
  busy = true;
  lastError = null;
  const go = $("take-go");
  if (go) { go.disabled = true; go.textContent = "Saving your key…"; }
  let account = null;
  try {
    const passAccount = await cachetClaim.publicKeyHexFromSeed(frag.key);
    const before = (await view("note", { token_id: frag.token })).value;
    progressNote = before;
    if (cachetWallet.accountId) account = cachetWallet.accountId;
    else { const saved = await cachetLinkdrop.createImplicitAccount(localStorage, net.name); account = saved.accountId; await saveKey(saved); }
    progress("Asking the sponsor for the network fee.", 1, cachetWallet.accountId ? "Wallet connected" : "Key saved", "Hand-off sent");
    await sponsor(passAccount);
    progress("Moving the note to you. NEAR confirms in about two seconds.", 1, cachetWallet.accountId ? "Wallet connected" : "Key saved", "Hand-off sent");
    const result = await cachetLinkdrop.signAndSend({ signerId: passAccount, seedHex: frag.key, contract: frag.contract, args: { receiver_id: account, token_id: frag.token }, net, method: "nft_transfer", tgas: 30, restricted: false, deposit: 1n, waitForAccountMs: 20000 });
    const failed = cachetOutcome.failureText(result);
    if (failed) throw new Error(failed);
    const tx = txHash(result);
    if (tx) { localStorage.setItem(`cachet:claim-tx:${frag.contract}:${frag.token}`, tx); localStorage.setItem(kindKey(), "transfer"); session.tx.claim = tx; }
    const owner = await poll(async () => (await view("nft_token", { token_id: frag.token })).value, (v) => v?.owner_id === account, 30000, 1000);
    if (owner?.owner_id !== account) throw new Error("NEAR accepted the hand-off but the new owner has not shown yet. Check again in a moment.");
    const after = (await view("note", { token_id: frag.token })).value;
    session.claimed = true;
    session.passedIn = true;
    session.proof = after?.state === "Sealed" && sameOutput(before?.utxo, after.utxo) ? `The Bitcoin output ${outputText(after.utxo)} did not move. Sealed before and after.` : "The note changed during the hand-off.";
  } catch (error) {
    const landed = account ? await poll(async () => (await view("nft_token", { token_id: frag.token })).value, (v) => v?.owner_id === account, 12000, 1500).catch(() => null) : null;
    if (landed?.owner_id === account) { session.claimed = true; session.passedIn = true; } else lastError = error.message;
  } finally { busy = false; await render(); }
}

/* ---- the stations ---- */
function txLink(hash, label) { return hash ? h("p", { class: "station-tx" }, label, " ", link(txUrl(hash), short(hash, 10, 6), "hexlink")) : null; }

function station(title, state, ...body) {
  const word = { done: "Done", current: "Now", waiting: "Waiting" }[state];
  return h("li", { class: "station", dataset: { state } }, h("div", { class: "station-head" }, h("h3", null, title), h("p", { class: "where" }, word)), ...body);
}

async function accountFunds(account) {
  try { const r = await cachetChain.rpc("query", { request_type: "view_account", finality: "final", account_id: account }, net); return BigInt(r.amount); }
  catch (error) { if (/does not exist|unknown/i.test(`${error.message} ${error.rpc?.cause?.name || ""}`)) return 0n; throw error; }
}

async function stations(s) {
  const { note, config, base, outspend, spend } = s;
  const account = you();
  const owner = s.nft?.owner_id || null;
  const mine = Boolean(account && owner === account);
  const swept = outspend?.spent === true || Boolean(session.tx.broadcast);
  const out = [];

  const sealed = note && !note.claim && note.state === "Sealed";
  if (sealed && mine) {
    const heir = note.heir || null;
    const dest = h("input", { id: "claim-destination", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: `${config.hrp}1...`, ...(heir ? { value: heir, readonly: true } : {}) });
    const feeIn = h("input", { id: "claim-fee", autocomplete: "off", inputmode: "numeric" });
    const consequence = h("p", { class: "consequence-box", id: "claim-consequence", "aria-live": "polite" });
    const go = h("button", { class: "btn btn-primary", type: "submit", id: "heir-go", ...(heir ? { form: "heir-form" } : {}), disabled: outspend?.spent !== false }, !outspend ? "Checking Bitcoin…" : heir ? `Open as ${who()}` : "Unlock the Bitcoin");
    const destField = h("div", { class: "field" }, h("label", { for: "claim-destination" }, heir ? "Bound heir address, fixed when this note was created" : "Bitcoin destination"), dest);
    const feeField = h("div", { class: "field" }, h("label", { for: "claim-fee" }, "Fee rate, sat/vB"), feeIn);
    const fundsSlot = h("div", { class: "funds-slot" });
    const form = h("form", { class: "tool-form", id: heir ? "heir-form" : undefined, novalidate: true },
      ...(heir ? [h("details", { class: "more" }, h("summary", null, "Sweep details: address, fee, network fee"), destField, feeField, consequence, fundsSlot)] : [destField, feeField, consequence]),
      ...(heir ? [] : [go]));
    const explain = () => {
      const len = destinationScriptLen(dest.value.trim());
      const rate = Number(feeIn.value.trim());
      if (!len || !accountAddress(dest.value.trim().toLowerCase(), config.hrp) || !Number.isInteger(rate) || rate < 1) return consequence.replaceChildren("Name a Bitcoin address and a fee rate to see the sweep before you sign.");
      const fee = rate * cachetOutcome.sweepVsize(len);
      const guard = cachetOutcome.feeGuard(note.utxo.sats, rate, len);
      consequence.replaceChildren(guard || `Unlocking signs a Bitcoin transaction that sends ${int(note.utxo.sats - fee)} sats to ${short(dest.value.trim(), 12, 8)}, fee ${int(fee)} sats at ${rate} sat/vB. The seal cannot be restored.`);
    };
    dest.addEventListener("input", explain); feeIn.addEventListener("input", explain);
    form.addEventListener("submit", (event) => { event.preventDefault(); unseal(note, config, dest, feeIn); });
    const own = !cachetWallet.accountId && savedAccount()?.accountId === account;
    const funds = own ? h("p", { class: "consequence-box", id: "claim-funds" }, "Checking the claim account balance.") : null;
    if (own) accountFunds(account).then((n) => {
      funds.textContent = n >= FEE_FLOOR ? "This claim account pays the network fee for the unlock call." : "";
      if (n < FEE_FLOOR) funds.replaceChildren(`This claim account pays its own network fee. Send about 0.05 NEAR to ${account} `, copyButton(account, "Copy account"), ", then unlock. A NEAR wallet that imports your saved key can do the same.");
    }).catch(() => { funds.textContent = ""; });
    const s2 = session.steal;
    const stealBox = !heir ? null : h("div", { class: "steal", id: "steal-box", "aria-live": "polite" },
      h("p", { class: "say" }, `You hold the link, so try to steal it. The sweep goes to a thief address and the contract decides. Only ${who()} is paid.`),
      h("div", { class: "heir-actions" },
        h("button", { class: "btn btn-steal", id: "steal-go", type: "button", disabled: Boolean(s2?.pending) || outspend?.spent !== false, onclick: () => steal(note, feeIn) }, s2?.pending ? "Sending the theft..." : outspend ? "Steal this link" : "Checking Bitcoin…"),
        go),
      !s2 || s2.pending ? null : s2.error ? h("p", { class: "consequence-box", id: "steal-result", dataset: { state: "error" } }, `The attempt did not reach the contract: ${s2.error}`)
        : h("div", { class: "consequence-box steal-receipt", id: "steal-result", dataset: { state: s2.refused ? "refused" : "accepted" } },
          s2.refused ? h("strong", { class: "refused-stamp" }, "Refused") : null,
          h("dl", { class: "receipt" },
            h("div", { class: "receipt-tried" }, h("dt", null, "Tried to send it to"), h("dd", null, h("s", null, short(THIEF_ADDRESS, 10, 8)))),
            h("div", { class: "receipt-bound" }, h("dt", null, "The note is bound to"), h("dd", null, `${short(heir, 10, 8)} \u2713`))),
          h("p", { class: "receipt-why" }, s2.refused ? `No Bitcoin moved. ${String(s2.reason || "").replace(/^./, (c) => c.toUpperCase())}. ` : "The contract accepted a sweep to the thief address. ",
            s2.hash ? link(txUrl(s2.hash), "View the refusal on NEAR", "hexlink") : null)));
    if (heir && funds) fundsSlot.append(funds);
    out.push(station(heir ? "Try the lock" : "Unlock", "current", h("p", { class: "say" }, heir ? `This note pays only ${who()} at ${short(heir, 10, 8)}. The sweep can go nowhere else.` : "Choose the Bitcoin address that receives the share and the fee."), heir ? null : funds, stealBox, form));
    if (net.name === "testnet" && !heir) cachetChain.defaultDestination(net).then((a) => { if (a && !dest.value) { dest.value = a; explain(); } }).catch(() => {});
    feeIn.value = "5"; // a sane testnet rate is in the field at once, so a press before the explorer answers still signs
    feeDefault(base).then((r) => { if (feeIn.value === "5") { feeIn.value = String(r); explain(); } }).catch(() => {});
    explain();
  } else if (note && ["Unsealing", "Resigning"].includes(note.state)) out.push(station("Unlock", "current", h("p", { class: "say" }, "The signer is producing the sweep signature.")));
  else if (!note || note.state !== "Sealed") out.push(station("Unlock", "done", h("p", { class: "say" }, "The seal is broken and the sweep is signed."), txLink(session.tx.unseal, "Unseal transaction")));
  else out.push(station("Unlock", "waiting", h("p", { class: "say" }, "Claim the share first, then pick a Bitcoin destination.")));

  const signed = note?.state === "Unsealed" ? (note.sweep?.signed_tx || (await view("signed_sweep_tx", { token_id: frag.token })).value) : null;
  if (signed && !swept && mine) {
    out.push(station("Broadcast", "current", h("p", { class: "say" }, "The signed sweep spends the locked output to your destination. Broadcast it to Bitcoin."),
      h("div", { class: "actions" },
        h("button", { class: "btn btn-primary", type: "button", onclick: () => broadcast(note, signed, base) }, "Broadcast the sweep"),
        h("button", { class: "btn btn-paper", type: "button", onclick: async () => { await navigator.clipboard.writeText(signed); status("Signed sweep copied."); } }, "Copy signed sweep"))));
  } else if (swept || !note) {
    const txid = spend?.txid || session.tx.broadcast;
    out.push(station("Broadcast", "done", h("p", { class: "say" }, "The output is spent on Bitcoin."), txid ? h("p", { class: "station-tx sweep-proof" }, `${heirSweepLine(note)} `, link(`${base}/tx/${txid}`, "View the Bitcoin transaction", "hexlink")) : null));
  } else out.push(station("Broadcast", "waiting", h("p", { class: "say" }, "The signed sweep goes to Bitcoin once the note is unlocked.")));

  if (note?.heir) { /* a swept heir note needs no burn press: the Bitcoin transaction is the outcome */ }
  else if (note && swept && mine) out.push(station("Finalize", "current", h("p", { class: "say" }, `Once the sweep has ${config.confirmations} confirmations, the light client checks its proof and the note is burned.`),
    h("button", { class: "btn btn-primary", type: "button", onclick: () => finalize(note, config, base) }, "Finalize")));
  else if (!note) out.push(station("Finalize", "done", h("p", { class: "say" }, "The note is finalized and no longer exists."), txLink(session.tx.finalize, "Finalize transaction")));
  else out.push(station("Finalize", "waiting", h("p", { class: "say" }, "After the sweep confirms, the light client checks its proof and the note is burned.")));
  // A heir note shows one live step at a time: the envelope itself carries what happened once the Bitcoin is sent.
  if (note?.heir) {
    if (swept) return [];
    return out.filter((st) => { const t = st.querySelector("h3")?.textContent; return !(t === "Unlock" && st.dataset.state === "done") && !(t === "Broadcast" && st.dataset.state === "waiting") && t !== "Finalize"; });
  }
  return out;
}

const heirSweepLine = (note) => (note?.heir ? `Swept to ${short(note.heir, 10, 8)}.` : "Swept.");

/* ---- draw ---- */
let rendering = Promise.resolve();
function render() { rendering = rendering.then(draw, draw); return rendering; }

function heading(title, sub) {
  $("gift-title").textContent = title;
  $("gift-sub").textContent = sub;
}

// Connect HOT: the wallet Telegram users already hold signs a NEP-413 message on mainnet; the worker verifies it.
function hotChip() {
  const hot = globalThis.cachetHot;
  if (!hot) return null;
  const on = hot.remembered();
  const msg = h("p", { class: "hot-msg", id: "hot-msg", "aria-live": "polite" });
  if (on) return h("div", { class: "wallet-hot", id: "wallet-hot", dataset: { state: "on" } }, h("p", { class: "hot-on" }, "HOT ", h("strong", null, short(on.account_id, 14, 8)), " is your receiving wallet"), h("button", { class: "textlink", type: "button", onclick: () => { hot.disconnect(); render(); } }, "Disconnect"));
  return h("div", { class: "wallet-hot", id: "wallet-hot", dataset: { state: "off" } },
    h("button", { class: "btn btn-paper", id: "hot-go", type: "button", onclick: async (event) => {
      event.currentTarget.disabled = true; msg.textContent = "Waiting for HOT…";
      try { await hot.connect(); T()?.haptic("success"); render(); } catch (error) { msg.textContent = error.message; event.currentTarget.disabled = false; }
    } }, "Connect HOT"), msg);
}

// The Mini App's wallet header: the signed-in Telegram user and the Bitcoin held by notes this claim account owns.
function renderWallet(s, account) {
  const t = T();
  const el = $("tma-wallet");
  if (!t || !el) return;
  const held = new Map();
  for (const r of shares?.reads || []) if (account && r.note?.owner_id === account && r.note.utxo) held.set(r.token, r.note.utxo.sats);
  if (account && s.note?.owner_id === account && s.note.utxo) held.set(s.note.token_id, s.note.utxo.sats);
  if (isSwept(s) && s.note?.heir) held.delete(s.note.token_id);
  const total = [...held.values()].reduce((sum, n) => sum + n, 0);
  const u = t.user();
  el.hidden = false;
  el.dataset.empty = total === 0 ? "1" : "0";
  el.replaceChildren(
    h("div", { class: "wallet-who" },
      t.avatar({ name: u?.name || "You", photo: u?.photo, size: 44 }),
      h("div", null, h("p", { class: "wallet-hi" }, u?.first ? `Hi, ${u.first}` : "Your wallet"), h("p", { class: "wallet-sub" }, u?.username ? `@${u.username}` : "Telegram wallet"))),
    hotChip(),
    h("div", { class: "wallet-bal" },
      h("p", { class: "wallet-label" }, "Bitcoin balance"),
      h("p", { class: "wallet-amount" }, t.icon("btc", "ico-coin"), h("span", { class: "wallet-figure" }, `${int(total)} sats`), h("span", { class: "wallet-btc" }, btc(total)))));
}

// A swept heir note shows what left and where it went: the Bitcoin transaction is the status.
function cardCtx(s, account) {
  const ctx = { net, hrp: s.config.hrp, contract: frag.contract, you: account, proofHref: "index.html#record", heirName };
  const txid = s.spend?.txid || session.tx.broadcast;
  if (s.note?.heir && s.note.utxo && txid && (s.outspend?.spent === true || session.tx.broadcast)) {
    ctx.swept = { sats: s.note.utxo.sats - (s.note.sweep?.fee_sats || 0), fee: s.note.sweep?.fee_sats || 0, to: s.note.heir, url: `${s.base}/tx/${txid}` };
  }
  return ctx;
}

async function draw() {
  nativeMain(null);
  T()?.back(null);
  const [s] = await Promise.all([readFast(), readShares()]);
  await loadHeirName(s.note?.heir);
  const account = you();
  const owner = s.nft?.owner_id || null;
  const mine = Boolean(account && owner === account);
  const open = Boolean(s.note?.claim && frag.key && s.note.claim.key === await cachetClaim.publicKeyHexFromSeed(frag.key));
  const sender = frag.sender || pool[0]?.frag.sender || net.poolOwner || owner;
  const slot = $("gift-card");
  if (!s.note) cachetCard.none(slot, frag.token, frag.contract);
  else cachetCard.render(slot, s.note, cardCtx(s, account));
  progressNote = s.note;
  renderWallet(s, account);
  const passKey = frag.pass ? await cachetClaim.publicKeyHexFromSeed(frag.key) : null;
  const passed = readPassed();
  if (example) {
    heading("Every share is claimed.", example.block ? `Here is the last one, claimed at NEAR block ${int(example.block)}.` : "Here is the last one.");
    await examplePanel(s);
  } else if (passed && owner === passed.to) {
    heading("You passed it on.", `Note #${frag.token} is held by the link. ${sharesLine()}.`);
    passedPanel(s, passed);
  } else if (frag.pass && passKey && owner === passKey && !mine) {
    heading("A Bitcoin note was passed to you.", `From ${short(frag.sender, 8, 6)}. Check the lock, then take it.`);
    if (lastError) errorPanel(s.note, lastError, takeIt, "The note stays where it is.");
    else await receiverPanel(s);
  } else if (mine && s.note?.heir) {
    if (isSwept(s)) heading(`Sent to ${who()}.`, `The Bitcoin transaction paid only ${short(s.note.heir, 12, 8)}, the address fixed when the note was created.`);
    else heading(`For ${who()}.`, `Whoever holds this link, the Bitcoin can only be paid to ${short(s.note.heir, 12, 8)}, fixed when the note was created.`);
    if (slow && !session.claimed) slowPanel(); else await ownedPanel(s, account);
  } else if (mine) {
    heading("Your Bitcoin share.", `Test envelope on Bitcoin testnet, sent by ${sender}. ${sharesLine()}.`);
    if (slow && !session.claimed) slowPanel(); else await ownedPanel(s, account);
  } else if (open && s.note?.heir) {
    heading(`A Bitcoin note for ${who()}.`, `Bound when it was created to ${short(s.note.heir, 12, 8)}. A thief who gets the link can only sweep it there.`);
    if (slow) slowPanel();
    else if (lastError) errorPanel(s.note, lastError);
    else idlePanel(s.note);
  } else if (open) {
    heading("A Bitcoin red envelope is waiting.", `Test envelope on Bitcoin testnet, sent by ${sender}. ${sharesLine()}.`);
    if (slow) slowPanel();
    else if (lastError) errorPanel(s.note, lastError);
    else idlePanel(s.note);
  } else {
    heading("A Bitcoin red envelope.", `Test envelope on Bitcoin testnet, sent by ${sender}. ${sharesLine()}.`);
    await openedPanel(s.note, owner, null);
  }
  document.body.dataset.heirOwned = s.note?.heir && mine && !example ? "1" : "";
  if (s.note?.heir && mine) stationsOpen = true;
  $("stations").replaceChildren(...(mine && !example ? (await stations(s)) : []));
  if (s.note?.heir && mine) stationsOpen = true;
  if (mine && !example) $("stations").hidden = !(stationsOpen || (s.note && s.note.state !== "Sealed"));
  else $("stations").hidden = true;
  cachetUi.provenance($("foot-facts"), { net, contract: frag.contract, config: s.config, block: s.height });
  strip(frag.contract, s.height);
  document.body.dataset.ready = "1";
  if (s.note?.utxo && mine) {
    bitcoinChecks(s).then(async (checks) => {
      s.outspend = checks.outspend; s.spend = checks.spend;
      if (s.note?.heir && s.outspend?.spent === true) { cachetCard.render($("gift-card"), s.note, cardCtx(s, you())); renderWallet(s, you()); heading(`Sent to ${who()}.`, `The Bitcoin transaction paid only ${short(s.note.heir, 12, 8)}, the address fixed when the note was created.`); await ownedPanel(s, you()); }
      if ($("stations").hidden && !stationsOpen) return;
      $("stations").replaceChildren(...await stations(s));
      $("stations").hidden = !$("stations").children.length;
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
    const fragment = cachetClaim.parseMiniAppStartParam(new URLSearchParams(location.search).get("tgWebAppStartParam") || tg?.initDataUnsafe?.start_param);
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
