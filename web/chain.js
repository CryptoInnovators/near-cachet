"use strict";

(() => {

const NETWORKS = {
  testnet: { name: "testnet", rpc: "https://rpc.testnet.near.org", rpcs: ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"], txApi: "https://tx.test.fastnear.com", contract: "cachet.testnet", nearExplorer: "https://testnet.nearblocks.io", poolOwner: "cachet-ops.testnet" },
  mainnet: { name: "mainnet", rpc: "https://rpc.mainnet.fastnear.com", rpcs: ["https://rpc.mainnet.fastnear.com", "https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"], txApi: "https://tx.main.fastnear.com", contract: "cachet.near", nearExplorer: "https://nearblocks.io", poolOwner: null },
};
const REQUEST_TIMEOUT_MS = 15000;
const network = (search = typeof location === "undefined" ? "" : location.search) => {
  const params = new URLSearchParams(search);
  const net = NETWORKS[params.get("network")] || NETWORKS.testnet;
  const override = params.get("rpc");
  return override && /^https:\/\//.test(override) ? { ...net, rpc: override, rpcs: [override] } : net;
};
const lastGood = {};

async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error?.name === "AbortError") throw new Error(`The request to ${url} timed out after ${Math.round(timeout / 1000)} seconds.`);
    throw error;
  } finally { clearTimeout(timer); }
}

// Tries each provider in turn, starting with the one that answered last. A 429 or a network error moves on to the next provider.
async function rpc(method, params, net = network()) {
  const list = net.rpcs || [net.rpc];
  const first = list.indexOf(lastGood[net.name]);
  const order = first > 0 ? [list[first], ...list.filter((_, i) => i !== first)] : list;
  let failure;
  for (const url of order.length === 1 ? [order[0], order[0]] : order) {
    let response;
    try { response = await fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-web", method, params }) }, 8000); }
    catch (error) { failure = error; continue; }
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch {}
    if (payload?.error?.code === -429 || [429, 502, 503, 504].includes(response.status)) { failure = new Error(`The RPC at ${url} answered HTTP ${response.status}, rate limited or unavailable.`); continue; }
    if (payload?.error) { const error = new Error(payload.error.message || "The RPC returned an error."); error.rpc = payload.error; throw error; }
    if (!payload) { failure = new Error(`The RPC returned HTTP ${response.status} with a non-JSON body: ${text.slice(0, 240)}`); continue; }
    if (!response.ok) { failure = new Error(`The RPC returned HTTP ${response.status}.`); continue; }
    lastGood[net.name] = url;
    return payload.result;
  }
  throw failure || new Error("No RPC provider answered.");
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function callView(account, method, args, net = network()) {
  const result = await rpc("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(args))) }, net);
  const text = new TextDecoder().decode(new Uint8Array(result.result));
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { value, blockHeight: result.block_height, blockHash: result.block_hash };
}

function mempoolBase(hrp) { return hrp === "bc" ? "https://mempool.space" : hrp === "tb" ? "https://mempool.space/testnet" : null; }

// mempool.space first, then the blockstream.info esplora twin for every path both serve.
const esploraTwin = (base) => (base.endsWith("/testnet") ? "https://blockstream.info/testnet" : base === "https://mempool.space" ? "https://blockstream.info" : null);

async function explorerGet(base, path, accept) {
  const urls = [`${base}/api${path}`];
  const twin = esploraTwin(base);
  if (twin && !path.startsWith("/v1/") && path !== "/blocks") urls.push(`${twin}/api${path}`);
  let failure;
  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, { headers: { accept } });
      if (response.ok) return response;
      if (response.status === 404 || response.status === 400) { const body = await response.text(); throw Object.assign(new Error(`${new URL(url).host} returned HTTP ${response.status}: ${body.slice(0, 240)}`), { final: true }); }
      failure = new Error(`${new URL(url).host} returned HTTP ${response.status}.`);
    } catch (error) { if (error.final) throw error; failure = error; }
  }
  throw failure;
}

async function mempoolJson(base, path) { return (await explorerGet(base, path, "application/json")).json(); }

async function mempoolText(base, path) { return (await explorerGet(base, path, "text/plain")).text(); }

async function outspendStatus(base, txid, vout) {
  try {
    const result = await mempoolJson(base, `/tx/${encodeURIComponent(txid)}/outspend/${Number(vout)}`);
    return { spent: typeof result?.spent === "boolean" ? result.spent : null, readAt: new Date().toISOString() };
  } catch { return { spent: null, readAt: new Date().toISOString() }; }
}

// Latest transaction that touched an account, read from the FastNear transactions index.
async function latestTx(account, net = network()) {
  const response = await fetchWithTimeout(`${net.txApi}/v0/account`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ account_id: account, limit: 1 }) }, 8000);
  if (!response.ok) throw new Error(`The transactions index returned HTTP ${response.status}.`);
  const latest = (await response.json()).account_txs?.[0];
  if (!latest) return null;
  return { hash: latest.transaction_hash, blockHeight: latest.tx_block_height, timestampMs: Math.floor(Number(BigInt(latest.tx_block_timestamp) / 1000000n)), success: latest.is_success };
}

async function defaultDestination(net = network(), mempool = mempoolJson) {
  if (!net.poolOwner) return null;
  const tokens = await callView(net.contract, "nft_tokens_for_owner", { account_id: net.poolOwner, from_index: null, limit: 100 }, net);
  for (const token of tokens.value || []) {
    let note;
    try { note = JSON.parse(token.metadata?.extra || "null"); } catch { continue; }
    if (!note || note.state !== "Minted") continue;
    const activity = await mempool("https://mempool.space/testnet", `/address/${encodeURIComponent(note.address)}`);
    if ((activity.chain_stats?.tx_count || 0) + (activity.mempool_stats?.tx_count || 0) === 0) return note.address;
  }
  return null;
}

const lib = { NETWORKS, network, fetchWithTimeout, rpc, callView, mempoolBase, mempoolJson, mempoolText, outspendStatus, latestTx, defaultDestination };
if (typeof module !== "undefined" && module.exports) module.exports = lib;
if (typeof globalThis !== "undefined") globalThis.cachetChain = lib;

})();
