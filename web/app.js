const RPC_ENDPOINT = "https://rpc.mainnet.fastnear.com";
const DEFAULT_CONTRACT = "cachet.near";
const DEFAULT_SIGNER = "v1.signer";
const DEFAULT_HRP = "bc";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_SLOT = 4294967295;

const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SHA256_INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const RIPEMD_R = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8],
  [3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12],
  [1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2],
  [4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13],
];

const RIPEMD_RP = [
  [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12],
  [6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2],
  [15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13],
  [8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14],
  [12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11],
];

const RIPEMD_S = [
  [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
  [7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12],
  [11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5],
  [11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12],
  [9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6],
];

const RIPEMD_SP = [
  [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6],
  [9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11],
  [9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5],
  [15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8],
  [8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11],
];

const RIPEMD_K = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const RIPEMD_KP = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

let currentRun = 0;

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function rotl(value, bits) {
  return (value << bits) | (value >>> (32 - bits));
}

function add32(...values) {
  let total = 0;
  for (const value of values) total = (total + (value >>> 0)) >>> 0;
  return total;
}

function padMessage(bytes, littleEndian) {
  const length = bytes.length;
  const bitLength = BigInt(length) * 8n;
  const withOne = length + 1;
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
  const output = new Uint8Array(total);
  output.set(bytes);
  output[length] = 0x80;
  if (littleEndian) {
    let value = bitLength;
    for (let index = 0; index < 8; index += 1) {
      output[total - 8 + index] = Number(value & 0xffn);
      value >>= 8n;
    }
  } else {
    output[total - 8] = Number((bitLength >> 56n) & 0xffn);
    output[total - 7] = Number((bitLength >> 48n) & 0xffn);
    output[total - 6] = Number((bitLength >> 40n) & 0xffn);
    output[total - 5] = Number((bitLength >> 32n) & 0xffn);
    output[total - 4] = Number((bitLength >> 24n) & 0xffn);
    output[total - 3] = Number((bitLength >> 16n) & 0xffn);
    output[total - 2] = Number((bitLength >> 8n) & 0xffn);
    output[total - 1] = Number(bitLength & 0xffn);
  }
  return output;
}

function bytesToWords(bytes, offset, littleEndian) {
  const words = new Array(16);
  for (let index = 0; index < 16; index += 1) {
    const at = offset + index * 4;
    words[index] = littleEndian
      ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
      : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  }
  return words;
}

function wordsToBytes(words, littleEndian) {
  const output = new Uint8Array(words.length * 4);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] >>> 0;
    const at = index * 4;
    if (littleEndian) {
      output[at] = word & 0xff;
      output[at + 1] = (word >>> 8) & 0xff;
      output[at + 2] = (word >>> 16) & 0xff;
      output[at + 3] = (word >>> 24) & 0xff;
    } else {
      output[at] = (word >>> 24) & 0xff;
      output[at + 1] = (word >>> 16) & 0xff;
      output[at + 2] = (word >>> 8) & 0xff;
      output[at + 3] = word & 0xff;
    }
  }
  return output;
}

function sha256(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const message = padMessage(bytes, false);
  const hash = SHA256_INIT.slice();
  const schedule = new Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    const words = bytesToWords(message, offset, false);
    for (let index = 0; index < 16; index += 1) schedule[index] = words[index];
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(schedule[index - 15], 7) ^ rotr(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
      const s1 = rotr(schedule[index - 2], 17) ^ rotr(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
      schedule[index] = add32(schedule[index - 16], s0, schedule[index - 7], s1);
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = add32(h, s1, choice, SHA256_K[index], schedule[index]);
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(s0, majority);
      h = g;
      g = f;
      f = e;
      e = add32(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add32(temp1, temp2);
    }

    hash[0] = add32(hash[0], a);
    hash[1] = add32(hash[1], b);
    hash[2] = add32(hash[2], c);
    hash[3] = add32(hash[3], d);
    hash[4] = add32(hash[4], e);
    hash[5] = add32(hash[5], f);
    hash[6] = add32(hash[6], g);
    hash[7] = add32(hash[7], h);
  }

  return wordsToBytes(hash, false);
}

function ripemdF(round, x, y, z) {
  if (round === 0) return x ^ y ^ z;
  if (round === 1) return (x & y) | (~x & z);
  if (round === 2) return (x | ~y) ^ z;
  if (round === 3) return (x & z) | (y & ~z);
  return x ^ (y | ~z);
}

function ripemd160(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const message = padMessage(bytes, true);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let offset = 0; offset < message.length; offset += 64) {
    const words = bytesToWords(message, offset, true);
    let al = h0;
    let bl = h1;
    let cl = h2;
    let dl = h3;
    let el = h4;
    let ar = h0;
    let br = h1;
    let cr = h2;
    let dr = h3;
    let er = h4;

    for (let round = 0; round < 5; round += 1) {
      for (let step = 0; step < 16; step += 1) {
        const tl = add32(
          al,
          ripemdF(round, bl, cl, dl),
          words[RIPEMD_R[round][step]],
          RIPEMD_K[round],
        );
        const nextL = add32(rotl(tl, RIPEMD_S[round][step]), el);
        al = el;
        el = dl;
        dl = rotl(cl, 10);
        cl = bl;
        bl = nextL;
      }

      for (let step = 0; step < 16; step += 1) {
        const tr = add32(
          ar,
          ripemdF(4 - round, br, cr, dr),
          words[RIPEMD_RP[round][step]],
          RIPEMD_KP[round],
        );
        const nextR = add32(rotl(tr, RIPEMD_SP[round][step]), er);
        ar = er;
        er = dr;
        dr = rotl(cr, 10);
        cr = br;
        br = nextR;
      }
    }

    const nextH0 = add32(h1, cl, dr);
    h1 = add32(h2, dl, er);
    h2 = add32(h3, el, ar);
    h3 = add32(h4, al, br);
    h4 = add32(h0, bl, cr);
    h0 = nextH0;
  }

  return wordsToBytes([h0, h1, h2, h3, h4], true);
}

function bytesToHex(bytes) {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("Invalid hexadecimal value.");
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function base58Decode(value) {
  const indexes = new Map();
  for (let index = 0; index < BASE58_ALPHABET.length; index += 1) {
    indexes.set(BASE58_ALPHABET[index], BigInt(index));
  }
  let number = 0n;
  for (const character of value) {
    const index = indexes.get(character);
    if (index === undefined) throw new Error(`Invalid base58 character: ${character}`);
    number = number * 58n + index;
  }
  let hex = number.toString(16);
  if (hex === "0") hex = "";
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const body = hex ? hexToBytes(hex) : new Uint8Array(0);
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros += 1;
  const output = new Uint8Array(leadingZeros + body.length);
  output.set(body, leadingZeros);
  return output;
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < 5; index += 1) {
      if ((top >> index) & 1) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

function bech32HrpExpand(hrp) {
  const output = [];
  for (let index = 0; index < hrp.length; index += 1) output.push(hrp.charCodeAt(index) >> 5);
  output.push(0);
  for (let index = 0; index < hrp.length; index += 1) output.push(hrp.charCodeAt(index) & 31);
  return output;
}

function convertBits(data, from, to, pad) {
  let accumulator = 0;
  let bits = 0;
  const output = [];
  const maxValue = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error("Invalid value for bit conversion.");
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      output.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) output.push((accumulator << (to - bits)) & maxValue);
  } else if (bits >= from || ((accumulator << (to - bits)) & maxValue) !== 0) {
    throw new Error("Invalid padding in bech32 data.");
  }
  return output;
}

function bech32Encode(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data);
  const polymod = bech32Polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = [];
  for (let index = 0; index < 6; index += 1) {
    checksum.push((polymod >> (5 * (5 - index))) & 31);
  }
  return `${hrp}1${data.concat(checksum).map((value) => BECH32_ALPHABET[value]).join("")}`;
}

function pubkeyToAddress(signerKey, hrp) {
  const match = /^secp256k1:(.+)$/.exec(String(signerKey).trim());
  if (!match) throw new Error("The signer did not return a secp256k1 key.");
  const key = base58Decode(match[1]);
  if (key.length !== 64) throw new Error(`Expected a 64-byte key, received ${key.length} bytes.`);
  const compressed = new Uint8Array(33);
  compressed[0] = 2 + (key[63] & 1);
  compressed.set(key.subarray(0, 32), 1);
  const hash160 = ripemd160(sha256(compressed));
  const words = convertBits(hash160, 8, 5, true);
  const address = bech32Encode(hrp, [0].concat(words));
  return { address, compressedHex: bytesToHex(compressed), hash160: bytesToHex(hash160) };
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`The request to ${url} timed out after ${Math.round(timeout / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(method, params) {
  const response = await fetchWithTimeout(RPC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-web", method, params }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`The RPC returned HTTP ${response.status} with a non-JSON body: ${text.slice(0, 240)}`);
  }
  if (payload.error) {
    const error = new Error(payload.error.message || "The RPC returned an error.");
    error.rpc = payload.error;
    throw error;
  }
  if (!response.ok) throw new Error(`The RPC returned HTTP ${response.status}.`);
  return payload.result;
}

async function callView(account, method, args) {
  const argsBase64 = bytesToBase64(new TextEncoder().encode(JSON.stringify(args)));
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: argsBase64,
  });
  const text = new TextDecoder().decode(new Uint8Array(result.result));
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { value, blockHeight: result.block_height, blockHash: result.block_hash };
}

async function viewAccessKeys(account) {
  const result = await rpc("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: account,
  });
  return { keys: Array.isArray(result.keys) ? result.keys : [], blockHeight: result.block_height };
}

function mempoolBase(hrp) {
  if (hrp === "bc") return "https://mempool.space";
  if (hrp === "tb") return "https://mempool.space/testnet";
  return null;
}

async function mempoolJson(base, path) {
  const response = await fetchWithTimeout(`${base}/api${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`mempool.space returned HTTP ${response.status}: ${body.slice(0, 240)}`);
  }
  return response.json();
}

function formatError(error) {
  if (error && error.rpc) {
    const payload = error.rpc;
    const cause = payload.cause || {};
    const lines = [];
    if (payload.name || cause.name) {
      lines.push(cause.name ? `${payload.name || "RPC"}: ${cause.name}` : payload.name);
    }
    if (payload.data) lines.push(String(payload.data));
    if (cause.info && cause.info.block_height != null) lines.push(`block ${cause.info.block_height}`);
    if (lines.length === 0) lines.push(JSON.stringify(payload));
    return lines.join("\n");
  }
  if (error && error.message) return error.message;
  return String(error);
}

function adviceFor(error, context) {
  const text = formatError(error);
  if (/UNKNOWN_ACCOUNT|does not exist while viewing/i.test(text)) {
    if (context === "signer") return "The configured signer account is not deployed on mainnet. Check the contract config.";
    return "This contract account is not deployed on mainnet. Deploy Cachet at this account, or enter a deployed contract account above.";
  }
  if (/MethodNotFound|does not have a method|Method not found/i.test(text)) {
    return "The account exists but does not expose this view. Confirm the account is the Cachet contract.";
  }
  if (/FunctionCallError|ExecutionError|panicked|HostError|wasm execution/i.test(text)) {
    return "The contract rejected the view call. Check the token id and the contract version above.";
  }
  if (/timed out|Failed to fetch|NetworkError|Load failed/i.test(text)) {
    return "The browser could not complete the request. Check the connection and read again.";
  }
  if (context === "bitcoin") return "The address above is still valid. Open it on mempool.space, or read again when the API responds.";
  if (context === "signer") return "The signer may be unavailable or misconfigured. Try again, or check the contract config.";
  if (context === "keys") return "Check the contract account, then read again.";
  return "Read the exact error above, then try again or enter another contract account.";
}

function nearAccountUrl(account) {
  return `https://nearblocks.io/accounts/${encodeURIComponent(account)}`;
}

function mempoolAddressUrl(address, hrp) {
  const base = mempoolBase(hrp);
  return base ? `${base}/address/${encodeURIComponent(address)}` : null;
}

function mempoolTxUrl(txid, hrp) {
  const base = mempoolBase(hrp);
  return base ? `${base}/tx/${encodeURIComponent(txid)}` : null;
}

function formatSats(value) {
  return `${new Intl.NumberFormat("en-US").format(value)} sats`;
}

function formatBtc(value) {
  const amount = Math.trunc(value);
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const whole = Math.floor(absolute / 100000000);
  const fraction = String(absolute % 100000000).padStart(8, "0");
  return `${negative ? "-" : ""}${new Intl.NumberFormat("en-US").format(whole)}.${fraction} BTC`;
}

function satsAndBtc(value) {
  return `${formatSats(value)} (${formatBtc(value)})`;
}

function formatNear(yocto) {
  const value = BigInt(yocto);
  const whole = value / 1000000000000000000000000n;
  const fraction = (value % 1000000000000000000000000n).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return `${new Intl.NumberFormat("en-US").format(whole)}${fraction ? `.${fraction}` : ""} NEAR`;
}

function formatUnixUtc(seconds) {
  return `${new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function nowUtc() {
  return `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
}

function appendContent(parent, content) {
  if (content == null) return;
  if (typeof content === "object" && content.nodeType) parent.append(content);
  else parent.append(document.createTextNode(String(content)));
}

function mono(text, extra) {
  const element = node("span", `mono${extra ? ` ${extra}` : ""}`, text);
  return element;
}

function code(text) {
  return node("code", null, text);
}

function externalLink(href, text, className) {
  const link = node("a", className || null, text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function accountLink(account) {
  return externalLink(nearAccountUrl(account), account, "mono");
}

function record(rows) {
  const list = node("dl", "record");
  for (const [label, value] of rows) {
    if (value == null) continue;
    const row = node("div", "record-row");
    row.append(node("dt", null, label));
    const detail = node("dd");
    appendContent(detail, value);
    row.append(detail);
    list.append(row);
  }
  return list;
}

function reading(text) {
  const element = node("p", "reading");
  element.append(node("span", "reading-dot"));
  element.append(document.createTextNode(text));
  return element;
}

function emptyState(title, text, next) {
  const box = node("div", "state state-empty");
  box.append(node("p", "state-title", title));
  if (text) box.append(node("p", null, text));
  if (next) box.append(node("p", "next", `Next: ${next}`));
  return box;
}

function notice(title, content, tone = "info") {
  const box = node("div", `notice notice-${tone}`);
  box.append(node("p", "notice-title", title));
  if (content) {
    const paragraph = node("p");
    appendContent(paragraph, content);
    box.append(paragraph);
  }
  return box;
}

function errorState(title, error, advice) {
  const box = node("div", "state state-error");
  box.setAttribute("role", "alert");
  box.append(node("p", "state-title", title));
  const exact = node("pre", "exact");
  exact.textContent = formatError(error);
  box.append(exact);
  if (advice) box.append(node("p", "next", `Next: ${advice}`));
  return box;
}

function renderError(container, title, error, context) {
  container.replaceChildren(errorState(title, error, adviceFor(error, context)));
}

function isAccountId(value) {
  return (
    value.length >= 2 &&
    value.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value) &&
    !value.includes("..")
  );
}

function isTokenId(value) {
  return value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isSlot(value) {
  return /^\d{1,10}$/.test(value) && Number(value) <= MAX_SLOT;
}

function renderBanner(contract, config, configError) {
  const banner = document.getElementById("contract-banner");
  banner.replaceChildren();
  if (!configError) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  if (isUnknownAccount(configError)) {
    banner.append(node("p", "banner-title", "The contract account is not deployed on mainnet."));
    const paragraph = node("p", "banner-body");
    paragraph.append(document.createTextNode("The note and access key panels show the exact chain error for "));
    paragraph.append(code(contract));
    paragraph.append(document.createTextNode(". The address panel still reads the live "));
    paragraph.append(code(DEFAULT_SIGNER));
    paragraph.append(document.createTextNode(", so the derived address is real. Deploy Cachet at this account, or enter a deployed contract above."));
    banner.append(paragraph);
  } else {
    banner.append(node("p", "banner-title", "The contract config could not be read."));
    const paragraph = node("p", "banner-body");
    paragraph.append(document.createTextNode("The address panel falls back to "));
    paragraph.append(code(DEFAULT_SIGNER));
    paragraph.append(document.createTextNode(" and "));
    paragraph.append(code(DEFAULT_HRP));
    paragraph.append(document.createTextNode(". The note panel carries the exact error."));
    banner.append(paragraph);
  }
}

function renderNote(container, meta, note, error, contract, tokenId, hrp, run) {
  if (run !== currentRun) return;
  meta.textContent = "";
  if (error) {
    renderError(container, "The note record could not be read.", error, "note");
    meta.textContent = `source: ${contract}.note("${tokenId}")`;
    return;
  }
  const view = note.value;
  if (view == null) {
    container.replaceChildren(
      emptyState(
        `No note at token id ${tokenId}.`,
        `The contract returned null for note("${tokenId}"). No token with this id is stored on this contract.`,
        "mint a note with mint_note, or enter an existing token id above.",
      ),
    );
    meta.textContent = `read at NEAR block ${note.blockHeight}. source: ${contract}.note("${tokenId}").`;
    return;
  }
  if (typeof view !== "object") {
    container.replaceChildren(
      errorState("The note view was not an object.", new Error(`Received: ${JSON.stringify(view)}`), "Check that the account is the Cachet contract."),
    );
    return;
  }

  container.replaceChildren();
  const rows = [
    ["Token", mono(`#${view.token_id}`)],
    ["Owner", accountLink(view.owner_id)],
    ["State", mono(view.state)],
    ["Path", mono(view.path)],
    ["Address", mempoolAddressUrl(view.address, hrp) ? externalLink(mempoolAddressUrl(view.address, hrp), view.address, "mono") : mono(view.address)],
    ["Compressed key", mono(view.pubkey, "wrap")],
  ];

  if (view.utxo) {
    const txUrl = mempoolTxUrl(view.utxo.txid, hrp);
    const utxoLabel = `${view.utxo.txid}:${view.utxo.vout}`;
    rows.push(["Funding UTXO", txUrl ? externalLink(txUrl, utxoLabel, "mono wrap") : mono(utxoLabel, "wrap")]);
    rows.push(["Funding value", mono(satsAndBtc(view.utxo.sats))]);
    rows.push(["Attestation hash", mono(view.utxo.attestation_payload_hash, "wrap")]);
  } else {
    rows.push(["Funding UTXO", mono("None attested")]);
  }

  if (view.sweep) {
    rows.push(["Sweep destination script", mono(view.sweep.destination_script, "wrap")]);
    rows.push(["Sweep fee", mono(satsAndBtc(view.sweep.fee_sats))]);
    rows.push(["Signed sweep", mono(view.sweep.signed_tx ? `Ready, ${view.sweep.signed_tx.length} hex characters` : "Not signed")]);
  } else {
    rows.push(["Sweep", mono("No destination set")]);
  }

  if (view.claim) {
    rows.push(["Claim key hash", mono(view.claim.key, "wrap")]);
    rows.push(["Claim expires", mono(`NEAR block ${view.claim.expires_at_block}`)]);
    rows.push(["Claim locked", mono(view.claim.locked ? "Yes" : "No")]);
  } else {
    rows.push(["Claim link", mono("None")]);
  }

  rows.push(["In transfer", mono(view.in_transfer ? "Yes" : "No")]);
  container.append(record(rows));

  if (view.in_transfer) {
    container.append(notice("This note is mid-transfer.", "The owner cannot request a signature until the transfer settles.", "warn"));
  }
  meta.textContent = `read at NEAR block ${note.blockHeight}. source: ${contract}.note("${tokenId}").`;
}

function isUnknownAccount(error) {
  return /UNKNOWN_ACCOUNT|does not exist while viewing/i.test(formatError(error));
}

function renderKeys(container, meta, result, error, contract, run, deployed = true) {
  if (run !== currentRun) return;
  meta.textContent = "";
  if (!error && !deployed) {
    container.replaceChildren();
    container.append(emptyState(`No account exists at ${contract}.`, "The RPC returns an empty key list for an account that was never created, so an empty list here says nothing about keys.", "enter a deployed contract above, or deploy Cachet at this account and read again."));
    meta.textContent = `source: ${contract}.view_access_key_list, answered with an empty list for an unknown account.`;
    return;
  }
  if (error) {
    renderError(container, "The access key list could not be read.", error, "keys");
    meta.textContent = `source: ${contract}.view_access_key_list`;
    return;
  }
  const keys = result.keys || [];
  container.replaceChildren();
  if (keys.length === 0) {
    const box = node("div", "keys-empty");
    box.append(node("p", "key-count", "0"));
    box.append(node("p", "state-title", "No access keys on this account."));
    box.append(node("p", null, "No key can sign a transaction for the contract account. Calls can still reach its public methods."));
    box.append(node("p", "next", "This is the intended post-deploy state for Cachet. A deployer key would appear here if it still existed."));
    container.append(box);
    meta.textContent = `read at NEAR block ${result.blockHeight}. source: ${contract}.view_access_key_list.`;
    return;
  }

  const fullAccess = keys.filter((entry) => entry.access_key && entry.access_key.permission === "FullAccess");
  container.append(node("p", "key-count", String(keys.length)));
  if (fullAccess.length > 0) {
    container.append(
      notice(
        `${fullAccess.length} full-access ${fullAccess.length === 1 ? "key can" : "keys can"} sign for this account.`,
        "The no-admin property does not hold while a full-access key exists.",
        "warn",
      ),
    );
  } else {
    container.append(node("p", "key-summary", "No full-access keys. Only function-call keys are attached."));
  }

  const list = node("div", "key-list");
  for (const entry of keys) {
    const row = node("div", "key-row");
    row.append(mono(entry.public_key, "key-pub wrap"));
    const permission = entry.access_key ? entry.access_key.permission : "Unknown";
    if (permission === "FullAccess") {
      row.append(node("p", "key-perm key-full", "Full access"));
    } else if (permission && permission.FunctionCall) {
      const call = permission.FunctionCall;
      const line = node("p", "key-perm");
      line.append(document.createTextNode("Function calls to "));
      line.append(accountLink(call.receiver_id));
      if (Array.isArray(call.method_names) && call.method_names.length > 0) {
        line.append(document.createTextNode(` for ${call.method_names.join(", ")}`));
      }
      if (call.allowance) line.append(document.createTextNode(`; allowance ${formatNear(call.allowance)}`));
      row.append(line);
    } else {
      row.append(node("p", "key-perm", "Unknown permission"));
    }
    if (entry.access_key && entry.access_key.nonce != null) {
      row.append(node("p", "key-meta", `nonce ${entry.access_key.nonce}`));
    }
    list.append(row);
  }
  container.append(list);
  meta.textContent = `read at NEAR block ${result.blockHeight}. source: ${contract}.view_access_key_list.`;
}

async function renderBitcoinActivity(container, address, hrp, run, fundingNext) {
  container.replaceChildren(node("h3", null, "Bitcoin activity at this address"));
  const base = mempoolBase(hrp);
  if (!base) {
    container.append(
      emptyState("No public explorer for this network.", `The signer returned hrp ${hrp}, which has no mempool.space endpoint.`, "use a mainnet or testnet signer to read public Bitcoin activity."),
    );
    return;
  }
  const status = reading("Reading mempool.space...");
  container.append(status);
  try {
    const [blocks, stats] = await Promise.all([
      mempoolJson(base, "/blocks"),
      mempoolJson(base, `/address/${encodeURIComponent(address)}`),
    ]);
    if (run !== currentRun) return;
    status.remove();
    const tip = Array.isArray(blocks) && blocks[0] ? blocks[0] : null;
    const chain = stats.chain_stats || {};
    const mempool = stats.mempool_stats || {};
    const received = (chain.funded_txo_sum || 0) + (mempool.funded_txo_sum || 0);
    const spent = (chain.spent_txo_sum || 0) + (mempool.spent_txo_sum || 0);
    const balance = received - spent;
    const transactionCount = (chain.tx_count || 0) + (mempool.tx_count || 0);
    const unconfirmed = mempool.tx_count || 0;
    container.append(
      record([
        ["Balance", mono(satsAndBtc(balance))],
        ["Transactions", mono(`${transactionCount}${unconfirmed ? `, ${unconfirmed} unconfirmed` : ""}`)],
        ["Received", mono(satsAndBtc(received))],
        ["Spent", mono(satsAndBtc(spent))],
      ]),
    );
    if (transactionCount === 0) {
      container.append(
        emptyState(
          "This address is empty at the Bitcoin tip.",
          "It has no funding transaction yet.",
          fundingNext,
        ),
      );
    }
    const tipLine = tip
      ? `Bitcoin tip ${tip.height}, ${formatUnixUtc(tip.timestamp)}. Page read ${nowUtc()}.`
      : `Bitcoin tip unavailable. Page read ${nowUtc()}.`;
    container.append(node("p", "meta", tipLine));
  } catch (error) {
    if (run !== currentRun) return;
    status.remove();
    container.append(errorState("Bitcoin activity could not be read.", error, adviceFor(error, "bitcoin")));
  }
}

function fundingGuidance(deployed, note, contract) {
  if (!deployed) return `do not send bitcoin here. No contract exists at ${contract} to sign for this address, so funds sent to it could not be moved.`;
  if (!note) return `call mint_note on ${contract} first. A note exists once the contract record for this token appears in panel 02; only then is this address spendable through the contract.`;
  return "fund the address, then attest the funding transaction to seal the note. An address alone is not a sealed note.";
}

async function renderAddress({ contract, path, signerId, hrp, confirmations, note, run, deployed = true }) {
  const body = document.getElementById("address-body");
  const meta = document.getElementById("address-meta");
  body.replaceChildren(reading(`Reading ${signerId}.derived_public_key...`));
  meta.textContent = "";
  let response;
  try {
    response = await callView(signerId, "derived_public_key", {
      path,
      predecessor: contract,
      domain_id: 0,
    });
  } catch (error) {
    if (run !== currentRun) return;
    renderError(body, "The signer key could not be read.", error, "signer");
    meta.textContent = `source: ${signerId}.derived_public_key`;
    return;
  }
  if (run !== currentRun) return; 

  const signerKey = response.value;
  let derived;
  try {
    if (typeof signerKey !== "string") throw new Error(`The signer returned ${JSON.stringify(signerKey)} instead of a key string.`);
    derived = pubkeyToAddress(signerKey, hrp);
  } catch (error) {
    renderError(body, "The signer key could not be turned into an address.", error, "signer");
    meta.textContent = `source: ${signerId}.derived_public_key`;
    return;
  }

  body.replaceChildren();
  const addressBlock = node("div", "address-block");
  addressBlock.append(node("p", "address-label", "P2WPKH address"));
  const addressLine = node("p", "address");
  const addressUrl = mempoolAddressUrl(derived.address, hrp);
  if (addressUrl) addressLine.append(externalLink(addressUrl, derived.address));
  else addressLine.textContent = derived.address;
  addressBlock.append(addressLine);
  addressBlock.append(node("p", "address-action", addressUrl ? "The address links to mempool.space." : "This network has no public explorer link."));
  body.append(addressBlock);

  const network = hrp === "bc" ? "Bitcoin mainnet (bc)" : hrp === "tb" ? "Bitcoin testnet (tb)" : `Bitcoin regtest (${hrp})`;
  const rows = [
    ["Path", mono(path)],
    ["Signer", accountLink(signerId)],
    ["MPC public key", mono(signerKey, "wrap")],
    ["Compressed key", mono(derived.compressedHex, "wrap")],
    ["HASH160", mono(derived.hash160)],
    ["Address type", `P2WPKH, bech32 version 0`],
    ["Network", network],
  ];
  if (confirmations != null) rows.push(["Confirmations", mono(String(confirmations))]);
  body.append(record(rows));

  if (note) {
    const keyMatches = String(note.pubkey).toLowerCase() === derived.compressedHex;
    const addressMatches = note.address === derived.address;
    if (keyMatches && addressMatches) {
      body.append(notice("The derivation matches the note record.", "The compressed key and address stored by the contract are the same values this page derived from the signer.", "ok"));
    } else {
      body.append(
        notice(
          "The note record does not match this derivation.",
          `Derived address ${derived.address}. Stored address ${note.address}. Derived key ${derived.compressedHex}. Stored key ${note.pubkey}.`,
          "warn",
        ),
      );
    }
  }

  body.append(node("p", "fine", "This page derives the address locally from the signer key. It does not copy the address from the contract."));
  meta.textContent = `read at NEAR block ${response.blockHeight}. source: ${signerId}.derived_public_key(path, predecessor, 0).`;

  const activity = node("div", "activity");
  body.append(activity);
  await renderBitcoinActivity(activity, derived.address, hrp, run, fundingGuidance(deployed, note, contract));
}

function resetPanels() {
  document.getElementById("address-body").replaceChildren(reading("Reading v1.signer derived_public_key..."));
  document.getElementById("address-meta").textContent = "";
  document.getElementById("note-body").replaceChildren(reading("Reading the note record..."));
  document.getElementById("note-meta").textContent = "";
  document.getElementById("keys-body").replaceChildren(reading("Reading the access key list..."));
  document.getElementById("keys-meta").textContent = "";
  const banner = document.getElementById("contract-banner");
  banner.hidden = true;
  banner.replaceChildren();
}

function setControlStatus(text, tone) {
  const status = document.getElementById("control-status");
  status.textContent = text || "";
  status.className = `control-status${tone ? ` ${tone}` : ""}`;
  status.setAttribute("role", tone === "error" ? "alert" : "status");
}

function setBusy(busy) {
  const button = document.getElementById("read-button");
  button.disabled = busy;
  button.textContent = busy ? "Reading..." : "Read live";
  document.getElementById("read-form").setAttribute("aria-busy", busy ? "true" : "false");
}

function updatePathPreview() {
  const token = document.getElementById("token-input").value.trim() || "1";
  const slot = document.getElementById("slot-input").value.trim() || "0";
  document.getElementById("path-preview").textContent = `cachet/${token}/${slot}`;
}

function syncUrl(contract, tokenId, slot) {
  const url = new URL(window.location.href);
  url.searchParams.set("contract", contract);
  url.searchParams.set("token", tokenId);
  url.searchParams.set("slot", slot);
  window.history.replaceState(null, "", url);
}

async function readAll() {
  const run = ++currentRun;
  const contract = document.getElementById("contract-input").value.trim().toLowerCase();
  const tokenId = document.getElementById("token-input").value.trim();
  const slot = document.getElementById("slot-input").value.trim();
  const errors = [];
  if (!isAccountId(contract)) errors.push("Enter a NEAR account id, for example cachet.near.");
  if (!isTokenId(tokenId)) errors.push("Enter a token id using letters, numbers, dots, colons, hyphens, or underscores.");
  if (!isSlot(slot)) errors.push("Slot must be a whole number from 0 to 4294967295.");
  if (errors.length > 0) {
    setControlStatus(errors.join(" "), "error");
    return;
  }

  setControlStatus("");
  setBusy(true);
  document.getElementById("contract-input").value = contract;
  syncUrl(contract, tokenId, slot);
  resetPanels();

  try {
    const [configResult, noteResult, keysResult] = await Promise.allSettled([
      callView(contract, "config", {}),
      callView(contract, "note", { token_id: tokenId }),
      viewAccessKeys(contract),
    ]);
    if (run !== currentRun) return;

    const config = configResult.status === "fulfilled" ? configResult.value : null;
    const configError = configResult.status === "rejected" ? configResult.reason : null;
    const note = noteResult.status === "fulfilled" ? noteResult.value : null;
    const noteError = noteResult.status === "rejected" ? noteResult.reason : null;
    const keys = keysResult.status === "fulfilled" ? keysResult.value : null;
    const keysError = keysResult.status === "rejected" ? keysResult.reason : null;

    const configValue = config && config.value && typeof config.value === "object" ? config.value : null;
    const signerId = configValue && configValue.signer_id ? configValue.signer_id : DEFAULT_SIGNER;
    const hrp = configValue && configValue.hrp ? configValue.hrp : DEFAULT_HRP;
    const confirmations = configValue && configValue.confirmations != null ? configValue.confirmations : null;
    const noteView = note && note.value && typeof note.value === "object" ? note.value : null;
    const path = noteView && noteView.path ? noteView.path : `cachet/${tokenId}/${slot}`;

    renderBanner(contract, config, configError);
    renderNote(document.getElementById("note-body"), document.getElementById("note-meta"), note, noteError, contract, tokenId, hrp, run);
    const deployed = !(configError && isUnknownAccount(configError));
    renderKeys(document.getElementById("keys-body"), document.getElementById("keys-meta"), keys, keysError, contract, run, deployed);
    await renderAddress({ contract, path, signerId, hrp, confirmations, note: noteView, run, deployed });
  } catch (error) {
    if (run !== currentRun) return;
    renderError(document.getElementById("address-body"), "The read stopped unexpectedly.", error, "address");
    renderError(document.getElementById("note-body"), "The read stopped unexpectedly.", error, "note");
    renderError(document.getElementById("keys-body"), "The read stopped unexpectedly.", error, "keys");
    setControlStatus(`The read stopped unexpectedly. ${formatError(error)}`, "error");
  } finally {
    if (run === currentRun) setBusy(false);
  }
}

function init() {
  const params = new URLSearchParams(window.location.search);
  const contract = params.get("contract");
  const token = params.get("token");
  const slot = params.get("slot");
  document.getElementById("contract-input").value = contract && isAccountId(contract.trim().toLowerCase()) ? contract.trim().toLowerCase() : DEFAULT_CONTRACT;
  document.getElementById("token-input").value = token && isTokenId(token.trim()) ? token.trim() : "1";
  document.getElementById("slot-input").value = slot && isSlot(slot.trim()) ? slot.trim() : "0";
  updatePathPreview();

  for (const id of ["contract-input", "token-input", "slot-input"]) {
    document.getElementById(id).addEventListener("input", updatePathPreview);
  }
  document.getElementById("read-form").addEventListener("submit", (event) => {
    event.preventDefault();
    readAll();
  });
  readAll();
}

if (typeof document !== "undefined") init();

if (typeof globalThis !== "undefined") {
  globalThis.cachetInternals = {
    sha256,
    ripemd160,
    base58Decode,
    bech32Encode,
    convertBits,
    pubkeyToAddress,
    bytesToHex,
    hexToBytes,
  };
}
