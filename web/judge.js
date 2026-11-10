const pc = evidence.payout;
  const payoutNft = await chain.callView(pc.contract, "nft_token", { token_id: pc.token_id }, net);
  const payout = await chain.callView(pc.contract, "nft_payout", { token_id: pc.token_id, balance: PAYOUT_BALANCE, max_len_payout: 1 }, net);
  const entries = Object.entries(payout.payout);
  if (payoutNft?.owner_id !== pc.owner || entries.length !== 1 || entries[0][0] !== payoutNft.owner_id || entries[0][1] !== PAYOUT_BALANCE)"use strict";

(() => {

const BTC = "https://mempool.space/testnet";
const PAYOUT_BALANCE = "1000000000000000000000000";
const $ = (id) => document.getElementById(id);
const link = (href, text) => { const a = document.createElement("a"); a.href = href; a.textContent = text; a.rel = "noopener"; return a; };
const nearTx = (hash) => `https://explorer.testnet.near.org/transactions/${hash}`;

async function txStatus(hash, signer, net) {
  return globalThis.cachetChain.rpc("EXPERIMENTAL_tx_status", [hash, signer], net);
}

// A rejected call counts only when the chain shows it failed with exactly the named guard.
function failedWith(result, reason) {
  return result?.status?.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError === `Smart contract panicked: ${reason}`;
}

async function run() {
  const chain = globalThis.cachetChain;
  const net = chain.network();
  const evidence = await (await fetch("judge-attacks.json", { cache: "no-store" })).json();
  const { contract, token_id: token } = evidence;
  const [note, nft] = await Promise.all([
    chain.callView(contract, "note", { token_id: token }, net),
    chain.callView(contract, "nft_token", { token_id: token }, net)
  ]);
  if (!note || !nft) throw new Error(`Note ${token} does not exist on ${contract}.`);
  if (note.state !== "Sealed" || !note.utxo) throw new Error(`Note ${token} is ${note.state}, not Sealed with attested funding.`);
  if (nft.owner_id !== evidence.owner) throw new Error(`Note ${token} belongs to ${nft.owner_id}, not ${evidence.owner}.`);

  // Bitcoin side: the output the contract attested must exist in the block it names.
  const tx = await chain.mempoolJson(BTC, `/tx/${note.utxo.txid}`);
  const out = tx.vout[note.utxo.vout];
  if (!tx.status?.confirmed || tx.status.block_hash !== note.utxo.block_hash) throw new Error("The Bitcoin transaction is not confirmed in the attested block.");
  if (out?.scriptpubkey_address !== note.address || out.value !== note.utxo.sats) throw new Error("The Bitcoin output differs from the attested funding.");
  const tip = Number(await chain.mempoolText(BTC, "/blocks/tip/height"));
  const confirmations = tip - tx.status.block_height + 1;

  const attest = await txStatus(evidence.attest_tx, "cachet-ops.testnet", net);
  if (attest.transaction?.receiver_id !== contract || !("SuccessValue" in (attest.status || {}))) throw new Error("The attestation receipt did not succeed on the contract.");

  const payout = await chain.callView(contract, "nft_payout", { token_id: token, balance: PAYOUT_BALANCE, max_len_payout: 1 }, net);
  const entries = Object.entries(payout.payout);
  if (entries.length !== 1 || entries[0][0] !== nft.owner_id || entries[0][1] !== PAYOUT_BALANCE) throw new Error("nft_payout does not return the full balance to the current owner only.");

  const attacks = [];
  for (const attack of evidence.attacks) {
    const result = await txStatus(attack.tx, attack.signer, net);
    if (!failedWith(result, attack.reason)) throw new Error(`Receipt ${attack.tx} did not fail with "${attack.reason}".`);
    attacks.push(attack);
  }

  // Proof claims render only now, after every read above agreed.
  $("j-contract").textContent = contract;
  $("j-token").textContent = token;
  $("j-owner").textContent = nft.owner_id;
  $("j-state").textContent = note.state;
  $("j-sats").textContent = String(note.utxo.sats);
  $("j-txid").replaceChildren(link(`${BTC}/tx/${note.utxo.txid}`, note.utxo.txid), ` output ${note.utxo.vout}`);
  $("j-block").replaceChildren(link(`${BTC}/block/${note.utxo.block_hash}`, note.utxo.block_hash), ` height ${tx.status.block_height}`);
  $("j-confirmations").textContent = String(confirmations);
  $("j-attest").replaceChildren(link(nearTx(evidence.attest_tx), evidence.attest_tx));
  $("j-payout").textContent = `nft_payout on ${pc.contract} for note ${pc.token_id} and ${PAYOUT_BALANCE} yoctoNEAR returns {"${entries[0][0]}": "${entries[0][1]}"}: the whole balance to the current owner, no other entry.`;
  $("j-attacks").replaceChildren(...attacks.map((a) => {
    const li = document.createElement("li");
    li.append(`${a.scenario}: ${a.method} by ${a.signer} failed with "${a.reason}" `, link(nearTx(a.tx), a.tx));
    return li;
  }));
  $("judge-status").textContent = `Verified live: every field below was read from NEAR testnet and Bitcoin testnet3 just now.`;
  document.body.dataset.verified = "true";
}

run().catch((error) => {
  $("judge-status").textContent = `Unverified: ${error.message}`;
  document.body.dataset.verified = "false";
});

})();
