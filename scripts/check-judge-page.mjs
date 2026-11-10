#!/usr/bin/env node
// Fails unless web/judge.html names every proof field, web/index.html links to it, and the
// live testnet state agrees with web/judge-attacks.json and docs/EVIDENCE.md.
import fs from "node:fs";

const NEARRPC = process.env.NEARRPC || "https://test.rpc.fastnear.com";
const ESPLORA = process.env.ESPLORA || "https://blockstream.info/testnet/api";
const BALANCE = "1000000000000000000000000";
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const need = (c, m) => { if (!c) fail(m); };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return fail(`cannot read ${p}`); } };

async function rpc(method, params) {
  for (let i = 1; i <= 6; i++) {
    try {
      const r = await fetch(NEARRPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (j.result) return j.result;
    } catch {}
    await new Promise((r) => setTimeout(r, i * 4000));
  }
  return fail(`rpc ${method} did not answer`);
}
const view = async (contract, method, args) => {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
};
const esplora = async (path) => {
  const r = await fetch(ESPLORA + path, { signal: AbortSignal.timeout(30000) });
  need(r.ok, `esplora ${path} answered ${r.status}`);
  return path.endsWith("height") ? Number(await r.text()) : r.json();
};

const html = read("web/judge.html");
const index = read("web/index.html");
const js = read("web/judge.js");
const evidenceMd = read("docs/EVIDENCE.md");
const data = JSON.parse(read("web/judge-attacks.json"));

need(/href="judge\.html"/.test(index), "web/index.html does not link judge.html");
for (const id of ["j-contract", "j-token", "j-owner", "j-state", "j-sats", "j-txid", "j-block", "j-confirmations", "j-attest", "j-payout", "j-attacks"]) {
  need(html.includes(`id="${id}"`), `web/judge.html has no #${id}`);
}
need(html.includes('src="judge.js"') && html.includes('src="chain.js"'), "web/judge.html does not load chain.js and judge.js");
need(/nft_payout/.test(js) && /txStatus/.test(js) && /confirmed/.test(js), "web/judge.js does not verify payout, receipts and Bitcoin confirmation");
need(js.indexOf("Proof claims render only now") > js.lastIndexOf("throw new Error"), "web/judge.js renders proof claims before verification finishes");

// live state
const [note, nft] = await Promise.all([view(data.contract, "note", { token_id: data.token_id }), view(data.contract, "nft_token", { token_id: data.token_id })]);
need(note && nft, `note ${data.token_id} missing on ${data.contract}`);
need(note.state === "Sealed", `note is ${note.state}`);
need(nft.owner_id === data.owner, `owner is ${nft.owner_id}, evidence says ${data.owner}`);
const u = note.utxo;
need(u && u.txid && u.block_hash && u.sats > 0, "note has no attested utxo");
const tx = await esplora(`/tx/${u.txid}`);
need(tx.status.confirmed && tx.status.block_hash === u.block_hash, "bitcoin tx is not confirmed in the attested block");
need(tx.vout[u.vout].scriptpubkey_address === note.address && tx.vout[u.vout].value === u.sats, "bitcoin output differs from the attested funding");
const tip = await esplora("/blocks/tip/height");
need(tip - tx.status.block_height + 1 >= 2, "fewer than 2 confirmations");

const attest = await rpc("EXPERIMENTAL_tx_status", [data.attest_tx, "cachet-ops.testnet"]);
need(attest.transaction.receiver_id === data.contract && "SuccessValue" in attest.status, "attestation receipt did not succeed on the contract");
const pc = data.payout;
need(pc?.contract && pc.mint_tx && pc.deploy_tx, "no payout instance recorded");
const pnft = await view(pc.contract, "nft_token", { token_id: pc.token_id });
need(pnft.owner_id === pc.owner, `payout note owner is ${pnft.owner_id}`);
const payout = await view(pc.contract, "nft_payout", { token_id: pc.token_id, balance: BALANCE, max_len_payout: 1 });
need(JSON.stringify(payout.payout) === JSON.stringify({ [pnft.owner_id]: BALANCE }), `payout is ${JSON.stringify(payout)}`);
for (const h of [pc.mint_tx, pc.deploy_tx]) need(evidenceMd.includes(h), `docs/EVIDENCE.md does not cite ${h}`);

need(data.attacks.length >= 4 && new Set(data.attacks.map((a) => a.scenario)).size >= 3, "need four rejected receipts across three scenarios");
for (const a of data.attacks) {
  const r = await rpc("EXPERIMENTAL_tx_status", [a.tx, a.signer]);
  need(r.status.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError === `Smart contract panicked: ${a.reason}`, `${a.tx} did not fail with "${a.reason}"`);
  need(evidenceMd.includes(a.tx), `docs/EVIDENCE.md does not cite ${a.tx}`);
}
need(evidenceMd.includes(data.attest_tx), "docs/EVIDENCE.md does not cite the attestation receipt");
need(/nep199_nft_payout|nep199_sealed_transfer_payout_maps_entire_balance_only_to_new_owner/.test(evidenceMd) && /1 passed/.test(evidenceMd), "docs/EVIDENCE.md has no focused payout test result");
console.log(`PASS: note ${data.token_id} Sealed, owner ${nft.owner_id}, ${u.sats} sats in ${u.txid}, ${tip - tx.status.block_height + 1} confirmations, payout and ${data.attacks.length} rejected receipts verified`);
