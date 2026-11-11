import { NearConnector } from "./vendor/near-connect-0.12.0.mjs";

let connector;
let wallet;
let accountId;

async function connect(networkName) {
  if (!connector || connector.network !== networkName) connector = new NearConnector({ network: networkName });
  wallet = await connector.connect();
  accountId = (await wallet.getAccounts())[0]?.accountId || null;
  if (!accountId) throw new Error("The selected wallet did not return a NEAR account.");
  return accountId;
}

async function call(contract, method, args, { tgas, yocto = "0" }) {
  if (!wallet || !accountId) throw new Error("Connect a NEAR wallet before sending this transaction.");
  return wallet.signAndSendTransaction({
    receiverId: contract,
    actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: String(BigInt(tgas) * 1000000000000n), deposit: String(yocto) } }],
  });
}

async function addClaimKey(contract, token, publicKeyHex) {
  if (!wallet || !accountId) throw new Error("Connect the sender wallet before creating claim links.");
  const note = (await cachetChain.callView(contract, "note", { token_id: String(token) }, cachetChain.network("?network=testnet"))).value;
  if (!cachetLinkdrop.canAddClaimKey(note)) throw new Error("This note is not sealed and unclaimed; no claim key was added.");
  const publicKey = `ed25519:${cachetLinkdrop.b58encode(Uint8Array.from(publicKeyHex.match(/../g), (x) => parseInt(x, 16)))}`;
  return wallet.signAndSendTransaction({
    receiverId: accountId,
    actions: [{ type: "AddKey", params: { publicKey, accessKey: { nonce: 0, permission: {
      receiverId: contract, allowance: "150000000000000000000000", methodNames: ["claim"],
    } } } }],
  });
}

async function cleanupClaimKeys(contract) {
  if (!wallet || !accountId || connector.network !== "testnet") throw new Error("Connect a testnet sender wallet before cleaning claim keys.");
  const net = cachetChain.network("?network=testnet");
  const live = new Set();
  let offset = 0;
  while (true) {
    const tokens = (await cachetChain.callView(contract, "nft_tokens_for_owner", { account_id: accountId, from_index: String(offset), limit: 100 }, net)).value;
    for (const token of tokens) {
      const note = (await cachetChain.callView(contract, "note", { token_id: token.token_id }, net)).value;
      if (note?.claim?.key) live.add(note.claim.key.toLowerCase());
    }
    if (tokens.length < 100) break;
    offset += tokens.length;
  }
  const keys = (await cachetChain.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId }, net)).keys;
  const stale = keys.filter(({ public_key, access_key }) => {
    const permission = access_key?.permission?.FunctionCall;
    if (permission?.receiver_id !== contract || permission.method_names?.length !== 1 || permission.method_names[0] !== "claim") return false;
    const publicHex = Array.from(cachetLinkdrop.b58decode(public_key.replace(/^ed25519:/, "")), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return !live.has(publicHex.toLowerCase());
  });
  if (!stale.length) return null;

  const result = await wallet.signAndSendTransaction({
    receiverId: accountId,
    actions: stale.map(({ public_key }) => ({ type: "DeleteKey", params: { publicKey: public_key } })),
  });
  const failure = cachetOutcome.failureText(result);
  if (failure) throw new Error(failure);
  const hash = result?.transaction?.hash || result?.transaction_outcome?.id;
  if (!hash) throw new Error("The claim-key cleanup returned no transaction hash.");
  const until = Date.now() + 120000;
  let finalized = false;
  while (Date.now() < until) {
    const status = await cachetChain.rpc("EXPERIMENTAL_tx_status", [hash, accountId], net);
    const failure = cachetOutcome.failureText(status);
    if (failure) throw new Error(failure);
    if (status?.final_execution_status === "FINAL") { finalized = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!finalized) throw new Error("The claim-key cleanup did not reach finality within 120 seconds.");
  const remaining = (await cachetChain.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId }, net)).keys;
  if (stale.some(({ public_key }) => remaining.some((entry) => entry.public_key === public_key))) throw new Error("The stale claim key is still live after cleanup.");
  return result;
}

const api = { connect, call, addClaimKey, cleanupClaimKeys, get accountId() { return accountId; } };
globalThis.cachetWallet = api;
