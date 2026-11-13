"use strict";

(() => {
// DOM and formatting helpers shared by index, claim, card and owner scripts. Node-loadable (the DOM helpers need a document).

const INT = new Intl.NumberFormat("en-US");

function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    element.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return element;
}

const int = (value) => INT.format(value);
const sats = (value) => `${INT.format(value)} sats`;

function btc(value) {
  const whole = Math.floor(value / 100000000);
  return `${INT.format(whole)}.${String(value % 100000000).padStart(8, "0")} BTC`;
}

// Full value in blocks of eight, e.g. "35784fb7 705de7a4". Blocks are separate inline elements so a copy of the selection has no spaces.
function groupHex(value, size = 8) {
  const wrap = h("span", { class: "hex" });
  for (let i = 0; i < value.length; i += size) wrap.append(h("span", { class: "blk" }, value.slice(i, i + size)));
  return wrap;
}

const short = (value, head = 8, tail = 6) => (value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`);

function ago(ms, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function link(href, text, className) {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer", class: className }, text);
}

// Copies the raw value, not the grouped rendering.
function copyButton(value, label = "Copy") {
  const button = h("button", { type: "button", class: "copy", "aria-label": `${label} ${short(value)}` }, label);
  button.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(value); button.textContent = "Copied"; }
    catch { button.textContent = "Select and copy"; }
    setTimeout(() => { button.textContent = label; }, 1600);
  });
  return button;
}

const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Counts an integer up inside `element`. With reduced motion it writes the final value at once.
function countUp(element, to, { delay = 0, duration = 600 } = {}) {
  const write = (value) => { element.textContent = INT.format(Math.round(value)); };
  if (reducedMotion() || !to) return write(to);
  write(0);
  const start = performance.now() + delay;
  const frame = (now) => {
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    write(to * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setTimeout(() => write(to), delay + duration + 50); // rAF pauses in background tabs; the true figure still lands
}

// Marks .rise elements as .in when they scroll into view, staggered by --d (index in the batch unless the element sets its own).
function reveal(root = document) {
  const items = [...root.querySelectorAll(".rise:not(.in)")];
  if (!items.length) return;
  items.forEach((el, i) => { if (!el.style.getPropertyValue("--d")) el.style.setProperty("--d", String(Math.min(i, 5))); });
  if (reducedMotion() || typeof IntersectionObserver === "undefined") return items.forEach((el) => el.classList.add("in"));
  const io = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add("in"); io.unobserve(entry.target); } }), { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
  items.forEach((el) => io.observe(el));
}

// The footer's one provenance line: contract, signer, light client and the NEAR block the page was read at.
function provenance(el, { net, contract, config, block }) {
  const account = (name) => link(`${net.nearExplorer}/address/${encodeURIComponent(name)}`, name);
  const part = (label, value) => h("span", { class: "prov-part" }, `${label} `, value);
  el.replaceChildren(
    part("Contract", account(contract)),
    config ? part("Signer", account(config.signer_id)) : null,
    config ? part("Bitcoin light client", account(config.btc_light_client)) : null,
    part("Read at", block ? `NEAR block ${INT.format(block)}` : "not read"),
  );
}

const lib = { h, provenance, int, sats, btc, groupHex, short, ago, link, copyButton, reducedMotion, countUp, reveal };
if (typeof module !== "undefined" && module.exports) module.exports = lib;
if (typeof globalThis !== "undefined") globalThis.cachetUi = lib;

})();
