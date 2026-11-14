"use strict";

(() => {
// The provenance card: one note, its wax seal and the facts the contract holds about it.
const { h, int, sats, btc, groupHex, short, link, copyButton, countUp, reducedMotion } = cachetUi;
let counted = false; // the amount counts up once per page load; later renders show the final figure

const net_ = () => (typeof cachetChain !== "undefined" ? cachetChain.network().contract : "the contract");
const PENDING = {
  Attesting: "The Bitcoin light client is checking the funding proof.",
  Unsealing: "The signer is producing the sweep signature.",
  Resigning: "The signer is signing the sweep again at the new fee.",
  Finalizing: "The Bitcoin light client is checking the sweep proof.",
};

// Holder as a reader sees it: "You" for this browser's claim account, else the short form.
const holder = (owner, you) => (owner && owner === you ? "You" : short(owner || ""));

function consequence(note, you) {
  if (note.state === "Minted") return "Waiting for one funding output.";
  if (note.state === "Sealed") return "";
  if (note.state === "Unsealed") return `The sweep is signed. ${int(note.utxo.sats - (note.sweep?.fee_sats || 0))} sats leave to its destination once it is broadcast.`;
  return PENDING[note.state] || "";
}

function row(label, ...value) { return h("div", { class: "row" }, h("dt", null, label), h("dd", null, ...value)); }

function leadingZeros(hash) { return (hash.match(/^0*/) || [""])[0].length; }

function microprint(txid) { return Array(5).fill(txid).join("  ·  "); }

function facts(note, ctx) {
  const mempool = cachetChain.mempoolBase(ctx.hrp);
  const rows = [row("Holder", link(`${ctx.net.nearExplorer}/address/${encodeURIComponent(note.owner_id)}`, short(note.owner_id)), copyButton(note.owner_id, "Copy"))];
  if (note.state === "Minted" && ctx.funding?.address) {
    const a = ctx.funding.activity;
    rows.push(row("Fund once with one output", groupHex(ctx.funding.address, 6), copyButton(ctx.funding.address, "Copy address")));
    if (a) rows.push(row("Bitcoin at the address", `${sats(a.received)} received, ${sats(a.spent)} spent, ${int(a.count)} ${a.count === 1 ? "transaction" : "transactions"}`));
  }
  if (note.utxo) {
    const outpoint = `${note.utxo.txid}:${note.utxo.vout}`;
    rows.push(row("Funded by", mempool ? link(`${mempool}/tx/${note.utxo.txid}`, short(note.utxo.txid), "hexlink") : short(note.utxo.txid), h("span", { class: "vout" }, ` output ${note.utxo.vout}`), copyButton(outpoint, "Copy")));
    const zeros = leadingZeros(note.utxo.block_hash);
    rows.push(row("In Bitcoin block", mempool ? link(`${mempool}/block/${note.utxo.block_hash}`, short(note.utxo.block_hash), "hexlink") : short(note.utxo.block_hash), h("span", { class: "work" }, ` ${zeros} leading zeros are the work behind it.`), copyButton(note.utxo.block_hash, "Copy")));
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

const tma = () => (globalThis.cachetTma?.inTelegram() ? globalThis.cachetTma : null);

// Contract state to the one plain word the card shows. A Sealed note whose claim link is spent is a claimed share.
function stateWord(note, ctx) {
  const t = globalThis.cachetTma;
  if (note.state === "Sealed" && ctx.you && note.owner_id === ctx.you) return { word: "Yours", icon: "check" };
  if (note.state === "Sealed" && !note.claim) return { word: "Claimed", icon: "done" };
  return t ? t.status(note.state) : { word: note.state, icon: "check" };
}

function proofBlock(note, ctx) {
  return h("details", { class: "proof" },
    h("summary", null, "Show how it is checked"),
    note.utxo ? h("p", { class: "card-note" }, `The seal has one tick per hex digit of the Bitcoin block hash. ${leadingZeros(note.utxo.block_hash)} leading zeros are the gap at the top.`) : null,
    facts(note, ctx),
    note.utxo ? h("p", { class: "microprint", "aria-hidden": "true" }, microprint(note.utxo.txid)) : null,
    h("p", null, link(ctx.proofHref || "index.html#record", "Open the full proof view")));
}

// The Mini App card: a red envelope holding sats with the BTC icon, who alone can open it, and one status word.
function envelope(slot, note, ctx) {
  const t = tma();
  const key = `env:${ctx.net.name}:${ctx.contract}:${note.token_id}:${note.state}:${note.owner_id}:${note.claim ? 1 : 0}:${ctx.swept ? 1 : 0}`;
  const play = slot.dataset.sealKey !== key && !reducedMotion();
  slot.dataset.sealKey = key;
  const count = Boolean(note.utxo) && !counted && !reducedMotion();
  const sw = ctx.swept || null;
  const figure = h("span", { class: "figure-n" }, note.utxo ? (count ? "0" : int(sw ? sw.sats : note.utxo.sats)) : "0");
  const st = sw ? { word: "Sent", icon: "check" } : stateWord(note, ctx);
  const card = h("article", { class: "card env", dataset: { state: note.state, swept: sw ? "1" : "0" } },
    h("div", { class: "env-flap", "aria-hidden": "true" }),
    h("div", { class: "card-head" },
      h("h2", { class: "card-title" }, "Red envelope ", h("span", { class: "tok" }, `#${note.token_id}`)),
      h("p", { class: "card-state", dataset: { state: st.word } }, t.icon(st.icon), st.word)),
    note.utxo
      ? h("div", { class: "env-amount" }, t.icon("btc", "ico-coin"), h("p", { class: "figure" }, figure, h("span", { class: "figure-u" }, sw ? " sats sent" : " sats")))
      : h("p", { class: "figure figure-wait" }, "Not funded yet"),
    note.utxo ? h("p", { class: "figure-sub" }, btc(sw ? sw.sats : note.utxo.sats)) : null,
    sw ? h("p", { class: "consequence" }, `${int(sw.sats + sw.fee)} sat note, ${int(sw.fee)} sats network fee. `, link(sw.url, "View the Bitcoin transaction", "hexlink"))
      : consequence(note, ctx.you) ? h("p", { class: "consequence" }, consequence(note, ctx.you)) : null,
    note.heir
      ? h("p", { class: "env-lock" }, t.icon(sw ? "check" : "lock"), h("span", null, sw ? "Sent to " : "Only ", t.avatar({ seed: note.heir, size: 22 }), h("strong", { class: "env-name" }, ctx.heirName || short(note.heir, 8, 5)), sw ? "" : " can open this", ctx.heirName ? h("span", { class: "env-addr" }, short(note.heir, 8, 5)) : null))
      : null,
    h("dl", { class: "rows rows-plain env-holder" }, row("Holder", h("span", { class: "holder" }, holder(note.owner_id, ctx.you)))),
    note.utxo ? h("p", { class: "env-proof" }, t.icon("check"), h("span", null, "Bitcoin funding proven on NEAR ", link(`${cachetChain.mempoolBase(ctx.hrp)}/block/${note.utxo.block_hash}`, "View block", "hexlink"))) : null,
    proofBlock(note, ctx));
  if (play) card.dataset.play = "1";
  slot.replaceChildren(card);
  if (count) { counted = true; countUp(figure, note.utxo.sats, { delay: 360 }); }
  return card;
}

// ctx: { net, hrp, contract, you?, funding?: { address, activity }, proofHref? }. Plays the seal press once per distinct note state.
function render(slot, note, ctx) {
  if (tma()) return envelope(slot, note, ctx);
  const key = `${ctx.net.name}:${ctx.contract}:${note.token_id}:${note.state}:${note.utxo?.block_hash || ""}`;
  const play = slot.dataset.sealKey !== key && !reducedMotion();
  slot.dataset.sealKey = key;
  const art = h("div", { class: "card-seal", role: "presentation" });
  art.innerHTML = sealMarkup(note);
  art.querySelectorAll(".seal-tick").forEach((tick) => tick.style.setProperty("--i", tick.dataset.i));
  const count = Boolean(note.utxo) && !counted && !reducedMotion();
  const figure = h("span", { class: "figure-n" }, note.utxo ? (count ? "0" : int(note.utxo.sats)) : "0");
  const proof = proofBlock(note, ctx);
  const card = shell(note.state, [
    h("div", { class: "card-head" },
      h("h2", { class: "card-title" }, "Cachet note ", h("span", { class: "tok" }, `#${note.token_id}`)),
      h("p", { class: "card-state", dataset: { state: note.state } }, stateWord(note, ctx).word)),
    art,
    h("div", { class: "amount" },
      note.utxo
        ? [h("p", { class: "figure" }, figure, h("span", { class: "figure-u" }, " sats")), h("p", { class: "figure-sub" }, btc(note.utxo.sats))]
        : h("p", { class: "figure figure-wait" }, "Not funded yet"),
      consequence(note, ctx.you) ? h("p", { class: "consequence" }, consequence(note, ctx.you)) : null),
    note.heir ? null : h("dl", { class: "rows rows-plain" }, row("Holder", h("span", { class: "holder" }, holder(note.owner_id, ctx.you)))),
    proof,
  ]);
  if (play) card.dataset.play = "1";
  slot.replaceChildren(card);
  if (count) { counted = true; countUp(figure, note.utxo.sats, { delay: 560 }); }
  return card;
}

const lib = {
  render,
  loading: (slot, token) => placeholder(slot, `Cachet note${token ? ` #${token}` : ""}`, `Reading the gift from ${net_()}.`, "loading"),
  none: (slot, token, contract) => placeholder(slot, `Cachet note${token ? ` #${token}` : ""}`, `${contract} has no token with this id. A note exists once mint_note finishes.`, "none"),
  failed: (slot, token, message) => placeholder(slot, `Cachet note${token ? ` #${token}` : ""}`, message, "error"),
  leadingZeros,
  holder,
};
if (typeof module !== "undefined" && module.exports) module.exports = lib;
globalThis.cachetCard = lib;

})();
