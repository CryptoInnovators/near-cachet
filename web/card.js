"use strict";

(() => {
// The provenance card: one note, its wax seal and the facts the contract holds about it.
const { h, int, sats, btc, groupHex, link, copyButton, countUp, reducedMotion } = cachetUi;

const PENDING = {
  Attesting: "The Bitcoin light client is checking the funding proof.",
  Unsealing: "The signer is producing the sweep signature.",
  Resigning: "The signer is signing the sweep again at the new fee.",
  Finalizing: "The Bitcoin light client is checking the sweep proof.",
};

function consequence(note) {
  if (note.state === "Minted") return "Waiting for one funding output.";
  if (note.state === "Sealed") return `Only ${note.owner_id} can ask the signer to release it.`;
  if (note.state === "Unsealed") return `The sweep is signed. ${int(note.utxo.sats - (note.sweep?.fee_sats || 0))} sats leave to its destination once it is broadcast.`;
  return PENDING[note.state] || "";
}

function row(label, ...value) { return h("div", { class: "row" }, h("dt", null, label), h("dd", null, ...value)); }

function leadingZeros(hash) { return (hash.match(/^0*/) || [""])[0].length; }

function microprint(txid) { return Array(5).fill(txid).join("  ·  "); }

function facts(note, ctx) {
  const mempool = cachetChain.mempoolBase(ctx.hrp);
  const rows = [row("Holder", link(`${ctx.net.nearExplorer}/address/${encodeURIComponent(note.owner_id)}`, note.owner_id))];
  if (note.state === "Minted" && ctx.funding?.address) {
    const a = ctx.funding.activity;
    rows.push(row("Fund once with one output", groupHex(ctx.funding.address, 6), copyButton(ctx.funding.address, "Copy address")));
    if (a) rows.push(row("Bitcoin at the address", `${sats(a.received)} received, ${sats(a.spent)} spent, ${int(a.count)} ${a.count === 1 ? "transaction" : "transactions"}`));
  }
  if (note.utxo) {
    const outpoint = `${note.utxo.txid}:${note.utxo.vout}`;
    rows.push(row("Funded by", mempool ? link(`${mempool}/tx/${note.utxo.txid}`, groupHex(note.utxo.txid), "hexlink") : groupHex(note.utxo.txid), h("span", { class: "vout" }, ` output ${note.utxo.vout}`), copyButton(outpoint, "Copy outpoint")));
    const zeros = leadingZeros(note.utxo.block_hash);
    rows.push(row("In Bitcoin block", mempool ? link(`${mempool}/block/${note.utxo.block_hash}`, groupHex(note.utxo.block_hash), "hexlink") : groupHex(note.utxo.block_hash), h("span", { class: "work" }, `${zeros} leading zeros are the work behind it.`)));
  }
  if (note.state === "Unsealed" && note.sweep) {
    rows.push(row("Sweep", `Signed at ${sats(note.sweep.fee_sats)} fee`, note.sweep.signed_tx ? copyButton(note.sweep.signed_tx, "Copy signed sweep") : null));
  }
  if (note.claim) rows.push(row("Claim link", note.claim.locked ? `Active until NEAR block ${int(note.claim.expires_at_block)}` : "Registered, not locked"));
  return h("dl", { class: "rows" }, rows);
}

function sealMarkup(note) {
  if (note.utxo) return cachetSeal.seal({ blockHash: note.utxo.block_hash, txid: note.utxo.txid, state: note.state, token: note.token_id });
  return cachetSeal.seal({ state: "Minted", token: note.token_id });
}

function shell(state, children) {
  return h("article", { class: "card", dataset: { state } }, children);
}

function placeholder(slot, title, line, tone) {
  const art = h("div", { class: "card-seal", role: "presentation" });
  art.innerHTML = cachetSeal.seal({ state: "Minted", token: "?" });
  slot.replaceChildren(shell(tone, [
    h("div", { class: "card-head" }, h("h2", { class: "card-title" }, title), h("p", { class: "card-state" }, tone === "error" ? "Not read" : tone === "loading" ? "Reading" : "No note")),
    art,
    h("p", { class: "consequence" }, line),
  ]));
}

// ctx: { net, hrp, funding?: { address, activity } }. Plays the seal animation once per distinct note state.
function render(slot, note, ctx) {
  const key = `${ctx.net.name}:${ctx.contract}:${note.token_id}:${note.state}:${note.utxo?.block_hash || ""}`;
  const play = slot.dataset.sealKey !== key && !reducedMotion();
  slot.dataset.sealKey = key;
  const art = h("div", { class: "card-seal", role: "presentation" });
  art.innerHTML = sealMarkup(note);
  art.querySelectorAll(".seal-tick").forEach((tick) => tick.style.setProperty("--i", tick.dataset.i));
  const figure = h("span", { class: "figure-n" }, note.utxo ? int(note.utxo.sats) : "0");
  const card = shell(note.state, [
    h("div", { class: "card-head" },
      h("h2", { class: "card-title" }, "Cachet note ", h("span", { class: "tok" }, `#${note.token_id}`)),
      h("p", { class: "card-state", dataset: { state: note.state } }, note.state)),
    art,
    h("div", { class: "amount" },
      note.utxo
        ? [h("p", { class: "figure" }, figure, h("span", { class: "figure-u" }, " sats")), h("p", { class: "figure-sub" }, btc(note.utxo.sats))]
        : h("p", { class: "figure figure-wait" }, "Not funded yet"),
      h("p", { class: "consequence" }, consequence(note))),
    facts(note, ctx),
    note.utxo ? h("p", { class: "microprint", "aria-hidden": "true" }, microprint(note.utxo.txid)) : null,
  ]);
  if (play) card.dataset.play = "1";
  slot.replaceChildren(card);
  if (note.utxo) countUp(figure, note.utxo.sats, { delay: play ? 560 : 0 });
  return card;
}

const lib = {
  render,
  loading: (slot, token) => placeholder(slot, `Cachet note #${token}`, "Reading the note from the contract.", "loading"),
  none: (slot, token, contract) => placeholder(slot, `Cachet note #${token}`, `${contract} has no token with this id. A note exists once mint_note finishes.`, "none"),
  failed: (slot, token, message) => placeholder(slot, `Cachet note #${token}`, message, "error"),
  leadingZeros,
};
if (typeof module !== "undefined" && module.exports) module.exports = lib;
globalThis.cachetCard = lib;

})();
