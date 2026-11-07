"use strict";

(() => {
const TAU = Math.PI * 2;
const round = (n) => Number(n.toFixed(2));
const fmt = (n) => round(n).toFixed(2);
const validHex = (s) => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);

function nibbles(blockHash) {
  if (!validHex(blockHash)) throw new Error("blockHash must be 64 hex characters");
  return Array.from(blockHash.toLowerCase(), (c) => parseInt(c, 16));
}
function leadingZeros(blockHash) { return (blockHash.match(/^0*/)?.[0] || "").length; }
function rim(txid) {
  if (!validHex(txid)) throw new Error("txid must be 64 hex characters");
  let x = (parseInt(txid.slice(0, 8), 16) ^ parseInt(txid.slice(-8), 16)) >>> 0;
  if (!x) x = 0x9e3779b9;
  return Array.from({ length: 48 }, () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return 104 + (x / 0xffffffff) * 12;
  });
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function waxPath(txid) {
  const rs = rim(txid), pts = rs.map((r, i) => { const a = i * TAU / 48; return [120 + r * Math.cos(a), 120 + r * Math.sin(a)]; });
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 0; i < 48; i++) {
    const p0 = pts[(i + 47) % 48], p1 = pts[i], p2 = pts[(i + 1) % 48], p3 = pts[(i + 2) % 48];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d + " Z";
}
function seal({ blockHash, txid, state, token }) {
  const known = ["Minted", "Attesting", "Sealed", "Unsealing", "Unsealed", "Resigning", "Finalizing"];
  if (!known.includes(state)) throw new Error(`unknown state: ${state}`);
  const id = String(txid || "");
  const label = state === "Minted" ? "No seal yet, waiting for funding" : state === "Unsealed" ? "Seal broken, the sweep is signed" : `Sealed in Bitcoin block ${String(blockHash).slice(0, 12)}, ${leadingZeros(blockHash)} leading zeros`;
  const pending = ["Attesting", "Unsealing", "Resigning", "Finalizing"].includes(state);
  const root = `class="seal seal-${state.toLowerCase()}${pending ? " seal-pending" : ""}"`;
  const text = `<text class="seal-token${state === "Minted" ? " seal-token-die" : ""}" x="120" y="132" text-anchor="middle">#${esc(token)}</text>`;
  if (state === "Minted") return `<svg viewBox="0 0 240 240" role="img" aria-label="${esc(label)}" ${root}><circle class="seal-die" cx="120" cy="120" r="112"/>${text}</svg>`;
  const ticks = nibbles(blockHash).map((n, i) => {
    if (!n) return "";
    const a = (i * 360 / 64 - 90) * Math.PI / 180, r2 = 70 + n * 1.1;
    return `<line class="seal-tick" stroke-width="2.4" stroke-linecap="butt" data-i="${i}" data-n="${n}" x1="${fmt(120 + 70 * Math.cos(a))}" y1="${fmt(120 + 70 * Math.sin(a))}" x2="${fmt(120 + r2 * Math.cos(a))}" y2="${fmt(120 + r2 * Math.sin(a))}"/>`;
  }).join("");
  const art = `<path class="seal-wax" d="${waxPath(id)}"/><circle class="seal-wax-hi" cx="120" cy="120" r="86"/><circle class="seal-wax-lo" cx="120" cy="120" r="66"/>${ticks}`;
  if (state !== "Unsealed") return `<svg viewBox="0 0 240 240" role="img" aria-label="${esc(label)}" ${root}>${art}${text}</svg>`;
  const suffix = id.slice(0, 8);
  const clips = `<defs><clipPath id="seal-clip-a${suffix}"><path d="M 122 -20 L 120 10 L 108 60 L 130 100 L 112 150 L 128 190 L 120 230 L 118 260 L -20 260 L -20 -20 Z"/></clipPath><clipPath id="seal-clip-b${suffix}"><path d="M 122 -20 L 120 10 L 108 60 L 130 100 L 112 150 L 128 190 L 120 230 L 118 260 L 260 260 L 260 -20 Z"/></clipPath></defs>`;
  return `<svg viewBox="0 0 240 240" role="img" aria-label="${esc(label)}" ${root}>${clips}<g class="seal-half seal-half-a" clip-path="url(#seal-clip-a${suffix})">${art}${text}</g><g class="seal-half seal-half-b" clip-path="url(#seal-clip-b${suffix})">${art}</g></svg>`;
}
const lib = { seal, nibbles, leadingZeros, rim };
if (typeof module !== "undefined" && module.exports) module.exports = lib;
globalThis.cachetSeal = lib;
})();
