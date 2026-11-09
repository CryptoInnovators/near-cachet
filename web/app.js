"use strict";

(() => {
const activeNetwork = cachetChain.network();
const DEFAULT_CONTRACT = activeNetwork.contract;
const DEFAULT_SIGNER = activeNetwork.name === "testnet" ? "v1.signer-prod.testnet" : "v1.signer";
const DEFAULT_HRP = activeNetwork.name === "testnet" ? "tb" : "bc";
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

const fetchWithTimeout = cachetChain.fetchWithTimeout;

const rpc = (method, params) => cachetChain.rpc(method, params, activeNetwork);
const callView = (account, method, args) => cachetChain.callView(account, method, args, activeNetwork);
const mempoolBase = cachetChain.mempoolBase;
const mempoolJson = cachetChain.mempoolJson;

async function viewAccessKeys(account) {
  const result = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: account });
  return { keys: Array.isArray(result.keys) ? result.keys : [], blockHeight: result.block_height };
}

function formatError(error) {
  if (error && error.rpc) {
    const payload = error.rpc;
    const cause = payload.cause || {};
    const lines = [];
    if (payload.name || cause.name) lines.push(cause.name ? `${payload.name || "RPC"}: ${cause.name}` : payload.name);
    if (payload.data) lines.push(String(payload.data));
    if (cause.info && cause.info.block_height != null) lines.push(`block ${cause.info.block_height}`);
    if (lines.length === 0) lines.push(JSON.stringify(payload));
    return lines.join("\n");
  }
  if (error && error.message) return error.message;
  return String(error);
}

function isUnknownAccount(error) {
  return /UNKNOWN_ACCOUNT|does not exist while viewing/i.test(formatError(error));
}

function adviceFor(error, context) {
  const text = formatError(error);
  if (/UNKNOWN_ACCOUNT|does not exist while viewing/i.test(text)) {
    if (context === "signer") return `The configured signer account is not deployed on ${activeNetwork.name}.`;
    return `No account exists at this address on ${activeNetwork.name}. Enter a deployed Cachet contract.`;
  }
  if (/MethodNotFound|does not have a method|Method not found/i.test(text)) return "The account exists but does not expose this view. Confirm it is a Cachet contract.";
  if (/FunctionCallError|ExecutionError|panicked|HostError|wasm execution/i.test(text)) return "The contract rejected the view call. Check the token id.";
  if (/timed out|Failed to fetch|NetworkError|Load failed|rate limited/i.test(text)) return "No provider answered in time. Read again in a moment.";
  if (context === "bitcoin") return "Open the address on mempool.space, or read again when the API responds.";
  return "Read again, or enter another contract account.";
}

function isAccountId(value) {
  return value.length >= 2 && value.length <= 64 && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value) && !value.includes("..");
}

function isTokenId(value) {
  return value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function mountPage() {
  const { h, int, sats, short, ago, link, groupHex } = cachetUi;
  const $ = (id) => document.getElementById(id);
  const net = activeNetwork;
  const explorerAccount = (account) => `${net.nearExplorer}/address/${encodeURIComponent(account)}`;

  /* ---- the record: five tiles ---- */
  const VERDICT = { match: "Match", differs: "Differs", lag: "Lagging", wait: "Waiting", read: "Read", unread: "Not read", reading: "Reading" };

  function makeTile(claim) {
    const verdict = h("p", { class: "verdict", dataset: { v: "reading" } }, VERDICT.reading);
    const proof = h("div", { class: "tile-proof" }, h("p", { class: "reading" }, "Reading…"));
    const el = h("article", { class: "tile rise" }, h("div", { class: "tile-claim" }, h("h3", null, claim), verdict), proof);
    return { el, verdict, proof };
  }

  function fill(tile, { v, body, source }) {
    tile.verdict.dataset.v = v;
    tile.verdict.textContent = VERDICT[v] || v;
    tile.proof.replaceChildren(...body, source ? h("p", { class: "source" }, source) : null);
  }

  const dl = (pairs) => h("dl", null, pairs.filter(Boolean).map(([k, ...v]) => h("div", null, h("dt", null, k), h("dd", null, ...v))));

  function failTile(tile, error, context) {
    fill(tile, { v: "unread", body: [h("div", { class: "state-error", role: "alert" }, h("p", { class: "state-title" }, "This read did not finish."), h("pre", { class: "exact" }, formatError(error)), h("p", { class: "next" }, adviceFor(error, context)))] });
  }

  /* ---- reads ---- */
  async function bitcoinTx(base, note) {
    return mempoolJson(base, `/tx/${encodeURIComponent(note.utxo.txid)}`);
  }

  async function fundingTile(tile, ctx) {
    const { note, config, contract, tokenId, txRead } = ctx;
    if (!note) return fill(tile, { v: "wait", body: [h("p", null, `${contract} holds no note ${tokenId}.`)] });
    if (!note.utxo) return fill(tile, { v: "wait", body: [h("p", null, "No output is attested. Fund the address once with one output, then attest it."), h("p", { class: "source" }, `Read from ${contract}.note("${tokenId}") at NEAR block ${int(ctx.noteBlock)}.`)] });
    const base = mempoolBase(config.hrp);
    const tx = await txRead;
    const outspend = await ctx.outspendRead;
    const mismatch = cachetOutcome.blockHashMismatch(note, tx);
    const outputMismatch = cachetOutcome.outputMismatch(note, tx);
    const confirmed = Boolean(tx.status?.confirmed);
    fill(tile, {
      v: !confirmed || mismatch || outputMismatch ? "differs" : "match",
      body: [dl([
        ["The contract stores", groupHex(note.utxo.block_hash)],
        ["The explorer reports", confirmed ? [groupHex(tx.status.block_hash), ` at Bitcoin block ${int(tx.status.block_height)}`] : "The transaction is not in a block."],
        [`Output ${note.utxo.vout}`, `${sats(note.utxo.sats)} to the note's address`],
        ["Outpoint spend status", `${outspend.spent === true ? "Spent" : outspend.spent === false ? "Verified unspent" : "Status unavailable"}. Read ${outspend.readAt}.`],
      ])],
      source: `${contract}.note("${tokenId}") at NEAR block ${int(ctx.noteBlock)}, and ${base}/api/tx/${short(note.utxo.txid)}.`,
    });
  }

  async function depthTile(tile, ctx) {
    const { note, config } = ctx;
    const base = mempoolBase(config.hrp);
    const [tipText, header] = await Promise.all([cachetChain.mempoolText(base, "/blocks/tip/height"), callView(config.btc_light_client, "get_last_block_header", {})]);
    const tip = Number(tipText.trim());
    const lc = Number(header.value?.block_height);
    const required = Number(config.confirmations);
    const lines = [["Bitcoin tip", int(tip)], ["Light client tip", `${int(lc)} (${tip - lc <= 0 ? "level with Bitcoin" : `${int(tip - lc)} blocks behind`})`], ["Confirmations required", String(required)]];
    let v = Math.abs(tip - lc) <= 30 ? "match" : "lag";
    let claim = null;
    if (note?.utxo) {
      const tx = await ctx.txRead;
      if (tx.status?.confirmed) {
        const depth = tip - tx.status.block_height + 1;
        lines.unshift(["Blocks on top of the funding", `${int(depth)}`]);
        if (depth < required) v = "wait";
      }
    }
    fill(tile, { v, body: [dl(lines)], source: `${config.btc_light_client}.get_last_block_header at NEAR block ${int(header.blockHeight)}, and ${base}/api/blocks/tip/height. Page read ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC.` });
    return claim;
  }

  async function keyTile(tile, ctx) {
    const { note, config, contract, tokenId } = ctx;
    const path = note?.path || `cachet/${tokenId}/0`;
    const response = await callView(config.signer_id, "derived_public_key", { path, predecessor: contract, domain_id: 0 });
    if (typeof response.value !== "string") throw new Error(`The signer returned ${JSON.stringify(response.value)} instead of a key string.`);
    const derived = pubkeyToAddress(response.value, config.hrp);
    ctx.derived = derived;
    const matches = note ? String(note.pubkey).toLowerCase() === derived.compressedHex && note.address === derived.address : null;
    fill(tile, {
      v: note ? (matches ? "match" : "differs") : "read",
      body: [dl([
        ["Path under this contract", path],
        ["Derived in this page", groupHex(derived.compressedHex)],
        note ? ["Stored by the contract", matches ? "The same key, and the same address." : [groupHex(String(note.pubkey)), ". The contract's address differs from the derived one."]] : null,
      ])],
      source: `${config.signer_id}.derived_public_key(path, predecessor, 0) at NEAR block ${int(response.blockHeight)}, converted to ${config.hrp === "tb" ? "a Bitcoin testnet" : "a Bitcoin"} P2WPKH key in this page.`,
    });
  }

  function keysTile(tile, keysResult, error, ctx) {
    if (error) return failTile(tile, error, "keys");
    const keys = keysResult.keys;
    const full = keys.filter((entry) => entry.access_key?.permission === "FullAccess").length;
    const body = [h("p", { class: "numeral" }, String(keys.length))];
    if (keys.length === 0) body.push(h("p", null, "No key can sign for the contract account. No one can upgrade or empty it."));
    else {
      body.push(h("p", null, full ? `${full} full-access ${full === 1 ? "key can" : "keys can"} sign for this account.` : "Only function-call keys are attached."));
      body.push(h("ul", null, keys.map((entry) => h("li", { class: "source" }, `${short(entry.public_key, 16, 6)}, ${entry.access_key?.permission === "FullAccess" ? "full access" : "function call"}`))));
    }
    fill(tile, { v: full ? "differs" : "match", body, source: `${ctx.contract}.view_access_key_list at NEAR block ${int(keysResult.blockHeight)}.` });
  }

  function systemsTile(tile, ctx) {
    const { config } = ctx;
    fill(tile, {
      v: "read",
      body: [dl([
        ["Signs for the note", link(explorerAccount(config.signer_id), config.signer_id), " (NEAR MPC, domain 0)"],
        ["Proves Bitcoin blocks", link(explorerAccount(config.btc_light_client), config.btc_light_client)],
        ["Confirmations", String(config.confirmations)],
      ])],
      source: `${ctx.contract}.config() at NEAR block ${int(ctx.configBlock)}. Both are fixed at deploy; the contract has no key to change them.`,
    });
  }

  /* ---- strip, life, footer ---- */
  function renderStrip(contract, latest, latestError, block) {
    const strip = $("strip");
    const latestNode = latest
      ? h("dd", null, link(`${net.nearExplorer}/txns/${latest.hash}`, short(latest.hash, 10, 6)), h("span", { class: "dim" }, `${latest.success ? "" : "Failed. "}Block ${int(latest.blockHeight)}, ${ago(latest.timestampMs)}`))
      : h("dd", null, latestError ? `Not read: ${formatError(latestError)}` : "None yet");
    strip.replaceChildren(
      h("div", { class: "pair" }, h("dt", null, "Contract"), h("dd", null, link(explorerAccount(contract), contract))),
      h("div", { class: "pair" }, h("dt", null, "Latest transaction"), latestNode),
      h("div", { class: "pair" }, h("dt", null, "Read at"), h("dd", null, block ? `NEAR block ${int(block)}` : "Not read")),
    );
  }

  let exemplarCache;
  async function exemplar(note) {
    if (note?.utxo) return note;
    if (exemplarCache !== undefined) return exemplarCache;
    exemplarCache = null;
    try {
      const entries = await (await fetch("judge-links.json", { cache: "no-store" })).json();
      for (const entry of entries) {
        const fragment = cachetClaim.parseFragment(entry.fragment);
        if (!fragment || fragment.contract !== net.contract) continue;
        const read = (await callView(fragment.contract, "note", { token_id: fragment.token })).value;
        if (read?.utxo) { exemplarCache = read; break; }
      }
    } catch { exemplarCache = null; }
    return exemplarCache;
  }

  const LIVES = [
    { state: "Minted", name: "Minted", method: "mint_note", text: "The contract asks the signer for a Bitcoin address that belongs to this token. The die is empty." },
    { state: "Sealed", name: "Sealed", method: "attest", text: "The light client proves the funding output sits in a block. That block's hash becomes the die, and the wax goes on." },
    { state: "Unsealed", name: "Unsealed", method: "unseal", text: "The owner asks the signer for a signed sweep. The seal breaks and the Bitcoin can leave." },
    { state: "Finalized", name: "Finalized", method: "finalize", text: "The light client proves the sweep is in a block. The note is burned and the die is empty again." },
  ];

  async function renderLife(note, tokenId) {
    const sample = await exemplar(note);
    const token = sample?.token_id || tokenId;
    const items = LIVES.map((life) => {
      let svg;
      if (life.state === "Minted") svg = cachetSeal.seal({ state: "Minted", token });
      else if (life.state === "Finalized") svg = cachetSeal.seal({ state: "Minted", token }).replace(/<text[^>]*>.*?<\/text>/, "");
      else if (sample?.utxo) svg = cachetSeal.seal({ blockHash: sample.utxo.block_hash, txid: sample.utxo.txid, state: life.state, token });
      else svg = cachetSeal.seal({ state: "Minted", token });
      const art = h("div", { class: "seal-art", role: "presentation" });
      art.innerHTML = svg;
      art.querySelectorAll(".seal-tick").forEach((tick) => tick.style.setProperty("--i", tick.dataset.i));
      return h("li", { class: "stage rise" }, art, h("h3", null, life.name), h("p", { class: "method" }, life.method), h("p", null, life.text));
    });
    $("stages").replaceChildren(...items);
    cachetUi.reveal($("stages"));
  }

  function renderFoot(contract, config) {
    const pair = (k, v) => h("div", null, h("dt", null, k), h("dd", null, v));
    $("foot-facts").replaceChildren(
      pair("Contract", link(explorerAccount(contract), contract)),
      pair("Signer", config ? link(explorerAccount(config.signer_id), config.signer_id) : "Not read"),
      pair("Bitcoin light client", config ? link(explorerAccount(config.btc_light_client), config.btc_light_client) : "Not read"),
    );
  }

  /* ---- one read of a contract and token ---- */
  async function activityAt(address, hrp) {
    const stats = await mempoolJson(mempoolBase(hrp), `/address/${encodeURIComponent(address)}`);
    const chain = stats.chain_stats || {};
    const pool = stats.mempool_stats || {};
    return { received: (chain.funded_txo_sum || 0) + (pool.funded_txo_sum || 0), spent: (chain.spent_txo_sum || 0) + (pool.spent_txo_sum || 0), count: (chain.tx_count || 0) + (pool.tx_count || 0) };
  }

  function setBusy(busy) {
    const button = $("read-button");
    button.disabled = busy;
    button.textContent = busy ? "Reading…" : "Read live";
    $("read-form").setAttribute("aria-busy", busy ? "true" : "false");
  }

  async function readAll() {
    const run = ++currentRun;
    const contract = $("contract-input").value.trim().toLowerCase();
    const tokenId = $("token-input").value.trim();
    const problems = [];
    if (!isAccountId(contract)) problems.push("Enter a NEAR account id, for example cachet.testnet.");
    if (!isTokenId(tokenId)) problems.push("Enter a token id: letters, numbers, dots, colons, hyphens or underscores.");
    $("lookup-status").textContent = problems.join(" ");
    if (problems.length) return;

    setBusy(true);
    document.body.dataset.ready = "0";
    const url = new URL(location.href);
    url.searchParams.set("contract", contract);
    url.searchParams.set("token", tokenId);
    history.replaceState(null, "", url);

    const slot = $("card-slot");
    const tiles = [
      makeTile("The funding sits in the block it claims."),
      makeTile("Enough Bitcoin blocks sit on top of it."),
      makeTile("The note's key is the signer's key."),
      makeTile("No one holds a key to the contract."),
      makeTile("Two systems answer for it."),
    ];
    $("tiles").replaceChildren(...tiles.map((tile) => tile.el));
    cachetUi.reveal($("tiles"));
    cachetCard.loading(slot, tokenId);

    try {
      const [configR, noteR, keysR, latestR] = await Promise.allSettled([
        callView(contract, "config", {}),
        callView(contract, "note", { token_id: tokenId }),
        viewAccessKeys(contract),
        cachetChain.latestTx(contract, net),
      ]);
      if (run !== currentRun) return;
      const config = configR.status === "fulfilled" && typeof configR.value.value === "object" ? configR.value.value : null;
      const note = noteR.status === "fulfilled" && noteR.value.value && typeof noteR.value.value === "object" ? noteR.value.value : null;
      const ctx = { contract, tokenId, config, note, noteBlock: noteR.value?.blockHeight, configBlock: configR.value?.blockHeight };

      renderStrip(contract, latestR.value || null, latestR.status === "rejected" ? latestR.reason : null, noteR.value?.blockHeight || configR.value?.blockHeight);
      renderFoot(contract, config);

      if (!config) {
        const reason = configR.reason;
        const missing = reason && isUnknownAccount(reason);
        cachetCard.failed(slot, tokenId, missing ? `No Cachet contract exists at ${contract} on ${net.name}.` : `The contract config could not be read. ${formatError(reason)}`);
        for (const tile of tiles) fill(tile, { v: "unread", body: [h("p", null, missing ? `${contract} does not exist on ${net.name}, so there is nothing to check.` : formatError(reason))] });
        await renderLife(null, tokenId);
        if (globalThis.cachetOwner) globalThis.cachetOwner.refresh(contract, tokenId, null, null);
        return;
      }

      if (noteR.status === "rejected") cachetCard.failed(slot, tokenId, formatError(noteR.reason));
      else if (!note) cachetCard.none(slot, tokenId, contract);
      else cachetCard.render(slot, note, { net, hrp: config.hrp, contract });

      ctx.txRead = note?.utxo ? bitcoinTx(mempoolBase(config.hrp), note) : Promise.resolve(null);
      ctx.txRead.catch(() => {});
      ctx.outspendRead = note?.utxo ? cachetChain.outspendStatus(mempoolBase(config.hrp), note.utxo.txid, note.utxo.vout) : Promise.resolve({ spent: null, readAt: "not read" });
      const jobs = [
        fundingTile(tiles[0], ctx).catch((e) => failTile(tiles[0], e, "bitcoin")),
        depthTile(tiles[1], ctx).catch((e) => failTile(tiles[1], e, "bitcoin")),
        keyTile(tiles[2], ctx).catch((e) => failTile(tiles[2], e, "signer")),
        Promise.resolve(keysTile(tiles[3], keysR.value, keysR.reason, ctx)),
        Promise.resolve(systemsTile(tiles[4], ctx)),
        renderLife(note, tokenId),
      ];
      await Promise.all(jobs);
      if (run !== currentRun) return;
      if (note && cachetOutcome.fundingAddressVisible(note) && ctx.derived) {
        let activity = null;
        try { activity = await activityAt(ctx.derived.address, config.hrp); } catch {}
        if (run === currentRun) cachetCard.render(slot, note, { net, hrp: config.hrp, contract, funding: { address: ctx.derived.address, activity } });
      }
      if (globalThis.cachetOwner) await globalThis.cachetOwner.refresh(contract, tokenId, note, config);
    } catch (error) {
      if (run !== currentRun) return;
      cachetCard.failed(slot, tokenId, formatError(error));
    } finally {
      if (run === currentRun) { setBusy(false); document.body.dataset.ready = "1"; }
    }
  }

  async function judgeDefaults() {
    try {
      const entries = await (await fetch("judge-links.json", { cache: "no-store" })).json();
      for (const entry of entries) {
        const fragment = cachetClaim.parseFragment(entry.fragment);
        if (fragment && fragment.contract === net.contract) return fragment;
      }
    } catch {}
    return null;
  }

  async function init() {
    const params = new URLSearchParams(location.search);
    for (const a of [$("net-testnet"), $("net-mainnet")]) {
      const target = a.id === "net-testnet" ? "testnet" : "mainnet";
      a.setAttribute("aria-current", String(net.name === target));
    }
    $("network-input").value = net.name;
    $("network-input").addEventListener("change", (event) => { const next = new URL(location.href); next.searchParams.set("network", event.target.value); next.searchParams.delete("contract"); next.searchParams.delete("token"); location.assign(next); });
    const wantContract = (params.get("contract") || "").trim().toLowerCase();
    const wantToken = (params.get("token") || "").trim();
    const defaults = wantToken ? null : await judgeDefaults();
    $("contract-input").value = isAccountId(wantContract) ? wantContract : net.contract;
    $("token-input").value = isTokenId(wantToken) ? wantToken : defaults?.token || "1";
    $("read-form").addEventListener("submit", (event) => { event.preventDefault(); readAll(); });
    $("claim-cta").href = `claim.html${location.search ? `?network=${net.name}` : ""}`;
    $("claim-cta").addEventListener("click", async (event) => {
      event.preventDefault();
      const note = $("cta-note");
      note.textContent = "Picking a funded note from the judge pool…";
      try {
        const fragment = await cachetClaim.pickJudgeFragment(net, (f) => callView(f.contract, "note", { token_id: f.token }).then((r) => r.value));
        if (!fragment) { note.textContent = "No sealed judge note with an open claim link is available right now."; return; }
        location.assign(`claim.html?network=${net.name}#${fragment}`);
      } catch (error) { note.textContent = formatError(error); }
    });
    cachetUi.reveal(document);
    readAll();
  }

  init();
}

if (typeof document !== "undefined") mountPage();

if (typeof globalThis !== "undefined") {
  globalThis.cachetInternals = { sha256, ripemd160, base58Decode, bech32Encode, convertBits, pubkeyToAddress, bytesToHex, hexToBytes };
}

})();
