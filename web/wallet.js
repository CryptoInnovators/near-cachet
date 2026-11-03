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

const api = { connect, call, get accountId() { return accountId; } };
globalThis.cachetWallet = api;
