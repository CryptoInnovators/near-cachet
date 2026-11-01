"use strict";
const RPC_URL = "https://rpc.mainnet.fastnear.com";
const ACCOUNT_RE = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const TOKEN_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MIN_LOCK = 3600;
const MAX_LOCK = 3000000;
const $ = (id) => document.getElementById(id);

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${body.error.name || "RPC_ERROR"}: ${JSON.stringify(body.error.cause || body.error.data || body.error.message)}`);
  return body.result;
}

async function finalHeight() {
  return (await rpc("block", { finality: "final" })).header.height;
}

async function viewNote(contract, token) {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: "note",
    args_base64: btoa(JSON.stringify({ token_id: token })),
  });
  return { note: JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))), height: result.block_height };
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function commandBlock(label, text) {
  const wrap = el("div", "cmd");
  wrap.append(el("p", "cmd-label", label));
  const pre = el("pre", "cmd-text", text);
  wrap.append(pre);
  const copy = el("button", null, "Copy");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copy.textContent = "Selected, press copy";
    }
  });
  wrap.append(copy);
  return wrap;
}

function status(id, text, tone) {
  const e = $(id);
  e.textContent = text;
  e.className = tone === "error" ? "control-status error" : "control-status";
}

function ed25519Missing() {
  return !(globalThis.crypto && crypto.subtle) ? "This browser has no WebCrypto." : null;
}

async function makeLink(event) {
  event.preventDefault();
  const out = $("make-out");
  out.replaceChildren();
  const contract = $("make-contract").value.trim().toLowerCase();
  const token = $("make-token").value.trim();
  const blocks = Number($("make-blocks").value.trim());
  const owner = $("make-owner").value.trim().toLowerCase();
  if (!ACCOUNT_RE.test(contract)) return status("make-status", "Enter the contract account, for example cachet.near.", "error");
  if (!TOKEN_RE.test(token)) return status("make-status", "Enter the token id of the note you own.", "error");
  if (!Number.isInteger(blocks) || blocks < MIN_LOCK || blocks > MAX_LOCK) return status("make-status", `The lock must be a whole number of blocks from ${MIN_LOCK} to ${MAX_LOCK}.`, "error");
  if (!ACCOUNT_RE.test(owner)) return status("make-status", "Enter your NEAR account, the current owner of the note.", "error");
  status("make-status", "Reading the NEAR block height...");
  let height;
  try {
    const missing = ed25519Missing();
    if (missing) throw new Error(missing);
    height = await finalHeight();
  } catch (error) {
    return status("make-status", `Could not start: ${error.message}`, "error");
  }
  let seed, publicKey;
  try {
    seed = cachetClaim.newSeedHex();
    publicKey = await cachetClaim.publicKeyHexFromSeed(seed);
  } catch (error) {
    return status("make-status", `This browser cannot make ed25519 keys: ${error.message}. Use a current Brave, Chrome, Firefox or Safari.`, "error");
  }
  const expires = height + blocks;
  const link = `${location.origin}${location.pathname}#${cachetClaim.buildFragment({ contract, token, key: seed })}`;
  const call = cachetClaim.nearCall(contract, "create_claim", { token_id: token, claim_key: publicKey, expires_at_block: expires }, owner);
  status("make-status", `Link made at NEAR block ${height}. Run the call below to arm it; the link does nothing until then.`, "ok");
  out.append(commandBlock(`Step 1. Register the claim key (run as ${owner}, expiry block ${expires})`, call));
  const linkBlock = el("div", "cmd");
  linkBlock.append(el("p", "cmd-label", "Step 2. Send this link to the receiver"));
  const a = el("a", "cmd-link", link);
  a.href = link;
  linkBlock.append(a);
  out.append(linkBlock);
  out.append(
    el(
      "p",
      "fine",
      `Until block ${expires} you cannot transfer, unseal or cancel this note. After that you can cancel the link with cancel_claim. Anyone who holds the link can claim before then, so send it only to the receiver.`,
    ),
  );
}

async function showClaimTarget(frag) {
  const intro = $("claim-intro");
  intro.replaceChildren(el("p", "reading", `Reading ${frag.contract}.note("${frag.token}")...`));
  let read;
  try {
    read = await viewNote(frag.contract, frag.token);
  } catch (error) {
    const unknown = /UNKNOWN_ACCOUNT/.test(error.message);
    intro.replaceChildren(
      el("p", "state-title", unknown ? `No contract is deployed at ${frag.contract}.` : "The note could not be read."),
      el("p", null, unknown ? "The link names an account that does not exist on mainnet. Check it with the person who sent it." : error.message),
    );
    return false;
  }
  const note = read.note;
  if (!note) {
    intro.replaceChildren(el("p", "state-title", `No note ${frag.token} on ${frag.contract}.`), el("p", null, "Check the link with the person who sent it."));
    return false;
  }
  const mine = await cachetClaim.publicKeyHexFromSeed(frag.key);
  const rows = el("dl", "record");
  const add = (k, v) => {
    const row = el("div", "record-row");
    row.append(el("dt", null, k), el("dd", null, v));
    rows.append(row);
  };
  add("Note", `${frag.contract} #${note.token_id}`);
  add("Owner now", note.owner_id);
  add("State", note.state);
  add("Funding", note.utxo ? `${note.utxo.sats} sats at ${note.utxo.txid}:${note.utxo.vout}` : "none attested yet");
  add("Bitcoin address", note.address);
  add("Claim expiry block", note.claim ? String(note.claim.expires_at_block) : "no claim link registered");
  intro.replaceChildren(rows);
  let ok = false;
  if (!note.claim) intro.append(el("p", "state-title", "No claim link is registered on this note yet. Ask the owner to run Step 1."));
  else if (note.claim.key !== mine) intro.append(el("p", "state-title", "This link does not match the claim key on the note. It is out of date or for another note."));
  else {
    ok = true;
    intro.append(el("p", "state-title", "This link matches the claim key on the note."));
  }
  intro.append(el("p", "meta", `read at NEAR block ${read.height}. source: ${frag.contract}.note("${frag.token}").`));
  return ok;
}

async function signClaim(event, frag) {
  event.preventDefault();
  const out = $("claim-out");
  out.replaceChildren();
  const receiver = $("claim-owner").value.trim().toLowerCase();
  if (!ACCOUNT_RE.test(receiver)) return status("claim-status", "Enter the NEAR account that should receive the note.", "error");
  let signature;
  try {
    signature = await cachetClaim.signClaim(frag.key, frag.contract, frag.token, receiver);
  } catch (error) {
    return status("claim-status", `Could not sign: ${error.message}`, "error");
  }
  const dest = $("claim-dest").value.trim().toLowerCase();
  const fee = Number($("claim-fee").value.trim());
  if (dest && !/^bc1[a-z0-9]{20,90}$/.test(dest)) return status("claim-status", "The bitcoin address must be a bc1 mainnet address, or left empty.", "error");
  if (dest && (!Number.isInteger(fee) || fee < 1 || fee > 10000)) return status("claim-status", "The fee rate must be a whole number of sat/vB from 1 to 10000.", "error");
  status("claim-status", `Signed for ${receiver}. The signature is useless for any other account.`, "ok");
  out.append(commandBlock(`Step 3. Submit the claim (run as ${receiver})`, cachetClaim.nearCall(frag.contract, "claim", { token_id: frag.token, new_owner: receiver, signature }, receiver)));
  if (dest) {
    out.append(commandBlock("Step 4, once the claim lands: sign the sweep to your bitcoin address", cachetClaim.nearCall(frag.contract, "unseal", { token_id: frag.token, btc_dest: dest, fee_rate: fee }, receiver)));
  }
}

function init() {
  $("make-form").addEventListener("submit", makeLink);
  const frag = cachetClaim.parseFragment(location.hash);
  if (!frag) return;
  $("make-contract").value = frag.contract;
  $("make-token").value = frag.token;
  showClaimTarget(frag).then((matches) => {
    if (!matches) return;
    const form = $("claim-form");
    form.hidden = false;
    form.addEventListener("submit", (event) => signClaim(event, frag));
  });
}

init();
