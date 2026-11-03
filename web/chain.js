"use strict";

const NETWORKS = {
  testnet: { name: "testnet", rpc: "https://rpc.testnet.fastnear.com", contract: "cachet.testnet", nearExplorer: "https://testnet.nearblocks.io", poolOwner: "cachet-ops.testnet" },
  mainnet: { name: "mainnet", rpc: "https://rpc.mainnet.fastnear.com", contract: "cachet.near", nearExplorer: "https://nearblocks.io", poolOwner: null },
};
const REQUEST_TIMEOUT_MS = 15000;
const network = (search = typeof location === "undefined" ? "" : location.search) => NETWORKS[new URLSearchParams(search).get("network")] || NETWORKS.testnet;

async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error?.name === "AbortError") throw new Error(`The request to ${url} timed out after ${Math.round(timeout / 1000)} seconds.`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function rpc(method, params, net = network()) {
  const response = await fetchWithTimeout(net.rpc, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-web", method, params }) });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`The RPC returned HTTP ${response.status} with a non-JSON body: ${text.slice(0, 240)}`); }
  if (payload.error) { const error = new Error(payload.error.message || "The RPC returned an error."); error.rpc = payload.error; throw error; }
  if (!response.ok) throw new Error(`The RPC returned HTTP ${response.status}.`);
  return payload.result;
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

async function mempoolJson(base, path) {
  const response = await fetchWithTimeout(`${base}/api${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) { const body = await response.text(); throw new Error(`mempool.space returned HTTP ${response.status}: ${body.slice(0, 240)}`); }
  return response.json();
}

async function mempoolText(base, path) {
  const response = await fetchWithTimeout(`${base}/api${path}`, { headers: { accept: "text/plain" } });
  if (!response.ok) { const body = await response.text(); throw new Error(`mempool.space returned HTTP ${response.status}: ${body.slice(0, 240)}`); }
  return response.text();
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

const lib = { NETWORKS, network, fetchWithTimeout, rpc, callView, mempoolBase, mempoolJson, mempoolText, defaultDestination };
if (typeof module !== "undefined" && module.exports) module.exports = lib;
if (typeof globalThis !== "undefined") globalThis.cachetChain = lib;
