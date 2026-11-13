#!/usr/bin/env node
// UI e2e against live testnet. Serves web/ (or --web DIR) locally, drives the real pages in the
// signed-in `deepsurge` Brave over CDP (one tab, closed on exit), and compares what the DOM shows
// with direct RPC reads made here. Fails on any console error, any horizontal overflow, a missing
// headline, a first screen whose claim button is not in the first viewport and first in tab order, a pool with fewer
// than 3 open shares, a 64-hex string on the first screen, an element crossing the card edge, or a share count that
// differs from the chain. With --claim it also claims one share cold and checks nft_token and the URL.
// usage: node scripts/e2e-ui.mjs [--web DIR | --base URL] [--shots DIR] [--contract cachet.testnet]
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));
const WEB = path.resolve(args.web || path.join(root, "web"));
const SHOTS = args.shots ? path.resolve(args.shots) : null;
const CONTRACT = args.contract || "heir.cachet-ops.testnet";
const RPCS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];
const TX_API = "https://tx.test.fastnear.com";

const HEADLINE = "A Bitcoin note that pays one person only.";
const ACTION = "Claim my share";
const MIN_OPEN = Number(args["min-open"] ?? 3); // the pool must never run dry during judging
const DO_UNSEAL = args.unseal === true; // claim, fund the claim account for gas, break the seal through the page (implies --claim)
const DO_PASS = args.pass === true; // after the claim: Pass it on, take it from the link in a clean browser, then replay the spent link (must fail)
const DO_HEIR = args.heir === true; // claim, press Steal this link (the contract must refuse), press Open as the named heir, broadcast, read the sweep on Bitcoin testnet
const DO_CLAIM = (args.claim === true || DO_UNSEAL || DO_PASS || DO_HEIR) && args.keep !== true; // spends one share of the pool: one cold walletless claim through the real page

const failures = [];
const passes = [];
const check = (name, ok, detail = "") => { (ok ? passes : failures).push(ok ? name : `${name}${detail ? `: ${detail}` : ""}`); console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- direct chain reads (the system of record) ----
async function rpc(method, params) {
  let last;
  for (const url of [...RPCS, ...RPCS]) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const body = await res.json();
      if (body.result) return body.result;
      last = new Error(JSON.stringify(body.error));
    } catch (e) { last = e; }
  }
  throw last;
}
async function view(account, method, argsObj) {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(argsObj)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
}
async function latestTx(account) {
  const r = await fetch(`${TX_API}/v0/account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: account, limit: 1 }), signal: AbortSignal.timeout(15000) });
  return (await r.json()).account_txs?.[0]?.transaction_hash;
}

// ---- local static server on a free port ----
const LIVE = typeof args.base === "string" ? args.base.replace(/\/$/, "") : null; // --base URL drives a deployed site instead of the local copy
const port = LIVE ? 0 : await new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = LIVE ? { kill() {} } : spawn("python3", [path.join(root, "scripts/serve-web.py"), String(port), WEB], { stdio: "ignore" });
for (let i = 0; !LIVE && i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {} await sleep(100); }
// "localhost" and not 127.0.0.1: the profile keeps a browser zoom for 127.0.0.1 that shrinks emulated desktop viewports
const BASE = LIVE || `http://localhost:${port}`;

// ---- CDP into the deepsurge profile ----
const ports = JSON.parse(readFileSync(`${homedir()}/.local/share/bhn/ports.json`, "utf8"));
const version = await (await fetch(`http://127.0.0.1:${ports.deepsurge.port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp connect failed")); });
let id = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else listeners.forEach((l) => l(msg));
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const errors = [];
listeners.push((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (JSON.stringify(msg.params || {}).includes("chrome-extension://")) return; // the shared profile's extensions, not the page
  if (msg.method === "Runtime.exceptionThrown") errors.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ""}`);
});
await S("Page.enable"); await S("Runtime.enable"); await S("Log.enable"); await S("Network.enable"); await S("Network.setCacheDisabled", { cacheDisabled: true });
const motion = (on) => S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "no-preference" : "reduce" }] });
const evalJs = async (expression) => {
  const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function waitFor(expr, what, timeout = 90000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await evalJs(`!!(${expr})`)) return true; } catch {}
    if (Date.now() > end) { check(`waited for ${what}`, false, `timeout; page shows: ${await evalJs("document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) + ' || ACT: ' + (document.querySelector('.panel-act')?.innerHTML || 'none').slice(0, 300) + ' || TG: ' + [!!globalThis.Telegram?.WebApp?.initData, globalThis.Telegram?.WebApp?.version, location.search.slice(0, 40)].join(',')").catch(() => "")}`); return false; }
    await sleep(500);
  }
}
async function open_(url, width) {
  const mobile = width < 600;
  await S("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await S("Page.navigate", { url });
  await sleep(800);
  check(`viewport is ${width} css px wide`, (await evalJs("innerWidth")) === width, String(await evalJs("innerWidth")));
}
async function shot(name, width) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const total = await evalJs("document.documentElement.scrollHeight");
  for (let y = 0; y < total; y += 500) { await evalJs(`window.scrollTo({ top: ${y}, behavior: "instant" })`); await sleep(120); }
  await evalJs(`window.scrollTo({ top: 0, behavior: "instant" })`);
  await sleep(700);
  const height = Math.ceil(await evalJs("document.documentElement.scrollHeight"));
  // tall captures past Chrome's 16384px texture limit repeat the top of the page, so capture in slices and stitch with PIL
  const slice = 4000, parts = [];
  for (let y = 0; y < height; y += slice) {
    const r = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width, height: Math.min(slice, height - y), scale: 1 } });
    const part = `${SHOTS}/.part-${name}-${width}-${y}.png`;
    writeFileSync(part, Buffer.from(r.data, "base64"));
    parts.push(part);
  }
  const out = `${SHOTS}/${name}-${width}.png`;
  const stitch = spawnSync("/usr/bin/python3", ["-c", "import sys\nfrom PIL import Image\nps=[Image.open(p) for p in sys.argv[2:]]\nim=Image.new('RGB',(ps[0].width,sum(p.height for p in ps)))\ny=0\nfor p in ps:\n im.paste(p,(0,y)); y+=p.height\nim.save(sys.argv[1])", out, ...parts]);
  if (stitch.status !== 0) throw new Error(`stitch failed: ${stitch.stderr}`);
  for (const p of parts) unlinkSync(p);
  console.log(`shot ${SHOTS}/${name}-${width}.png`);
}
const overflow = () => evalJs("document.documentElement.scrollWidth - document.documentElement.clientWidth");
const text = (sel) => evalJs(`(document.querySelector(${JSON.stringify(sel)})?.innerText || "").replace(/\\s+/g, " ").trim()`);

// Tab order in document order: what a keyboard reaches, skipping hidden controls (display none, tabindex -1).
const tabOrder = (stopAt) => evalJs(`(() => {
  const seen = [];
  for (const e of document.querySelectorAll('a[href], button, summary, input, select, textarea, [tabindex]')) {
    const r = e.getBoundingClientRect();
    if (e.disabled || e.tabIndex < 0 || getComputedStyle(e).display === "none" || (!r.width && !r.height) || e.closest("[hidden], details:not([open]) > :not(summary)")) continue;
    const label = (e.id || e.textContent).trim().split("\\n")[0].slice(0, 40);
    seen.push(label);
    if (label === ${JSON.stringify(stopAt)}) break;
  }
  return seen;
})()`);
const click = async (selector) => {
  const r = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center", behavior: "instant" }); const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
  await send("Target.activateTarget", { targetId }); // the profile is shared: another session may have raised its own tab, and a background tab drops synthetic mouse input
  for (const type of ["mousePressed", "mouseReleased"]) await S("Input.dispatchMouseEvent", { type, x: r[0], y: r[1], button: "left", clickCount: 1 });
};

async function runPass(target) {
      const wait = (cond, label, ms = 90000) => waitFor(cond, label, ms);
      const nftBefore = await view(CONTRACT, "note", { token_id: target });
      await click("#pass-go");
      await wait(`document.querySelector("#pass-link")`, "pass link shown");
      if (!(await evalJs(`!!document.querySelector("#pass-link")`))) { console.log("pass page state:", JSON.stringify(await evalJs(`({ t: document.querySelector(".panel-title")?.textContent, say: document.querySelector(".panel-say")?.textContent, st: document.querySelector("#claim-status")?.textContent, btn: document.querySelector("#pass-go")?.textContent, err: document.body.innerText.slice(0, 600) })`))); return; }
      const passed = await evalJs(`({ title: document.querySelector(".panel-title")?.textContent, link: document.querySelector("#pass-link").dataset.link, rows: document.querySelector(".panel-rows").innerText.replace(/\\s+/g, " "), tg: document.querySelector("#pass-share")?.href, tx: [...document.querySelectorAll(".panel-rows a")].map((a) => a.href)[0] })`);
      check("pass: the panel says 'Send this link.' and the seal did not move", passed.title === "Send this link." && /did not move/.test(passed.rows), passed.rows);
      const passFrag = new URLSearchParams(passed.link.split("#")[1]);
      const passKey = passFrag.get("key");
      const passAccount = await evalJs(`cachetClaim.publicKeyHexFromSeed(${JSON.stringify(passKey)})`);
      const mid = await view(CONTRACT, "nft_token", { token_id: target });
      check("pass: nft_token owner on chain is the pass account named by the link key", mid?.owner_id === passAccount, `${mid?.owner_id} vs ${passAccount}`);
      const midNote = await view(CONTRACT, "note", { token_id: target });
      check("pass: the Bitcoin output is unchanged and the note is still Sealed", midNote.state === "Sealed" && midNote.utxo.txid === nftBefore.utxo.txid && midNote.utxo.vout === nftBefore.utxo.vout, JSON.stringify(midNote.utxo));
      console.log(`pass: hand-off tx ${passed.tx}\npass: link ${passed.link.replace(/key=[0-9a-f]+/, "key=<seed>")}`);
      await shot("passed", 1440);
      await S("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await shot("passed", 390);
      // a second, clean browser state opens the link
      const t1 = Date.now();
      await evalJs("localStorage.clear()");
      await S("Page.navigate", { url: passed.link });
      await sleep(500);
      await S("Page.reload");
      await wait(`document.querySelector("#take-go")`, "take it button");
      await wait(`!document.querySelector("#take-go").disabled`, "take it enabled");
      const rec = await evalJs(`({ h1: document.querySelector("h1")?.textContent, rows: document.querySelector(".panel-rows").innerText.replace(/\\s+/g, " ") })`);
      check("pass: the link opener sees 'A Bitcoin note was passed to you.' with seal and unspent checks", rec.h1 === "A Bitcoin note was passed to you." && /Sealed/.test(rec.rows) && /unspent/.test(rec.rows), `${rec.h1} | ${rec.rows}`);
      await shot("received", 390);
      check("pass: no horizontal overflow on the received page at 390", (await overflow()) <= 0, String(await overflow()));
      await click("#take-go");
      const stop = Date.now() + 120000;
      while (Date.now() < stop && (await evalJs("document.querySelector('.panel-title')?.textContent")) !== "The note is yours.") await sleep(400);
      const done2 = await evalJs(`({ title: document.querySelector(".panel-title")?.textContent, say: document.querySelector(".panel-say")?.textContent, href: document.querySelector(".panel-rows a")?.href, acct: JSON.parse(localStorage.getItem("cachet:claim-account:testnet") || "null")?.accountId })`);
      check("pass: the opener's panel ends on 'The note is yours.'", done2.title === "The note is yours.", `${done2.title} ${done2.say}`);
      const fin = await view(CONTRACT, "nft_token", { token_id: target });
      check("pass: nft_token owner on chain is the opener's new account", fin?.owner_id === done2.acct && fin?.owner_id !== passAccount, `${fin?.owner_id} vs ${done2.acct}`);
      const finNote = await view(CONTRACT, "note", { token_id: target });
      check("pass: after both hand-offs the Bitcoin output is unchanged and Sealed", finNote.state === "Sealed" && finNote.utxo.txid === nftBefore.utxo.txid && finNote.utxo.vout === nftBefore.utxo.vout);
      console.log(`pass: ${((Date.now() - t1) / 1000).toFixed(1)}s from opening the link to the confirmed owner. take tx ${done2.href}`);
      await shot("took", 390);
      // replay: the pass account no longer owns the note, so its signed transfer must be refused by the contract
      const replay = await evalJs(`(async () => { try { const r = await cachetLinkdrop.signAndSend({ signerId: ${JSON.stringify(passAccount)}, seedHex: ${JSON.stringify(passKey)}, contract: ${JSON.stringify(CONTRACT)}, args: { receiver_id: "cachet-ops.testnet", token_id: ${JSON.stringify(target)} }, net: cachetChain.network(), method: "nft_transfer", tgas: 30, restricted: false, deposit: 1n, waitForAccountMs: 20000 }); return { failure: cachetOutcome.failureText(r), hash: r?.transaction?.hash }; } catch (e) { return { thrown: String(e.message) }; } })()`);
      check("pass replay: the spent link's transfer is refused by the contract", !!(replay.failure || replay.thrown), JSON.stringify(replay));
      const stillMine = await view(CONTRACT, "nft_token", { token_id: target });
      check("pass replay: the owner on chain is still the opener", stillMine?.owner_id === done2.acct, stillMine?.owner_id);
      console.log(`pass replay: refused. ${replay.failure || replay.thrown} tx https://testnet.nearblocks.io/txns/${replay.hash || "(not broadcast)"}`);
}

try {
  const links = JSON.parse(readFileSync(path.join(WEB, "judge-links.json"), "utf8"));
  const reads = [];
  for (const entry of links) {
    const f = new URLSearchParams(entry.fragment);
    reads.push({ token: f.get("token"), note: await view(CONTRACT, "note", { token_id: f.get("token") }) });
  }
  const open = reads.filter((r) => r.note?.state === "Sealed" && r.note.claim);
  check(`chain: the pool has at least ${MIN_OPEN} open shares`, open.length >= MIN_OPEN, `${open.length} open of ${reads.length}: ${open.map((r) => r.token).join(",")}`);
  const first = open[0];
  const config = await view(CONTRACT, "config", {});
  const head = (await rpc("block", { finality: "final" })).header.height;
  const tx = await latestTx(CONTRACT);
  check("chain: first open share is Sealed and funded", first?.note?.utxo?.sats > 0, first?.token);
  const fmt = new Intl.NumberFormat("en-US");
  const left = `${open.length} of ${reads.length} shares left`;

  for (const [width, label] of args.keep === true || typeof args.miniapp === "string" ? [] : [[1440, "desktop"], [390, "mobile"]]) {
    await motion(false);
    await open_(`${BASE}/index.html?network=testnet`, width);
    await evalJs("localStorage.clear()"); // a first visit has no claim account from an earlier run in this shared profile
    await S("Page.reload");
    await waitFor(`document.querySelector("#claim-go") && document.querySelector(".gift-card .figure-n")`, `${label} first screen`);
    check(`${label}: h1 is the envelope headline`, (await text("h1")) === HEADLINE, await text("h1"));
    await waitFor(`document.querySelector("#gift-strip")?.innerText.includes("latest tx")`, "strip");
    const g = await evalJs(`(() => { const b = document.querySelector("#claim-go").getBoundingClientRect(); const card = document.querySelector(".gift-card .card"); const c = card.getBoundingClientRect(); const out = [...card.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().width && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.className || e.tagName); return { label: document.querySelector("#claim-go").textContent, bottom: b.bottom, top: b.top, width: b.width, out, giftText: document.querySelector(".gift").innerText, sub: document.querySelector("#gift-sub").textContent, state: card.querySelector(".card-state")?.textContent, sats: card.querySelector(".figure-n")?.textContent, strip: document.querySelector("#gift-strip").innerText, title: card.querySelector(".card-title")?.textContent }; })()`);
    check(`${label}: the claim button reads "${ACTION}"`, g.label === ACTION, g.label);
    check(`${label}: the claim button is inside the first viewport`, g.top >= 0 && g.bottom <= (width < 600 ? 844 : 900), `${g.top}..${g.bottom}`);
    if (width < 600) check("mobile: the claim button is a full width touch target", g.width >= 330, String(g.width));
    check(`${label}: no 64-hex string on the first screen`, !/[0-9a-f]{64}/i.test(g.giftText), (g.giftText.match(/[0-9a-f]{64}/i) || [""])[0].slice(0, 20));
    check(`${label}: nothing crosses the card's right edge`, g.out.length === 0, g.out.join(","));
    check(`${label}: shares left equals the chain`, g.sub.includes(left), `${g.sub} vs ${left}`);
    const token = g.title.match(/#(\d+)/)?.[1];
    const shown = await view(CONTRACT, "note", { token_id: token });
    check(`${label}: card state and amount equal the chain for note ${token}`, g.state === shown.state && (await waitFor(`document.querySelector(".gift-card .figure-n")?.textContent === ${JSON.stringify(fmt.format(shown.utxo.sats))}`, "amount")), `${g.state} ${g.sats}`);
    check(`${label}: the shown note is an open share`, open.some((r) => r.token === token), token);
    check(`${label}: strip names the contract, a read block and the latest tx`, g.strip.includes(CONTRACT) && /NEAR block [\d,]+/.test(g.strip) && g.strip.includes(tx.slice(0, 4)), g.strip);
    const order = await tabOrder("claim-go");
    const want = width < 600 ? 5 : 6; // skip link, wordmark, then the header links (3 wide, 1 and Menu narrow), then the button
    check(`${label}: the claim button is first in tab order after the header`, order.at(-1) === "claim-go" && order.length === want, JSON.stringify(order));
    check(`${label}: no horizontal overflow`, (await overflow()) <= 0, String(await overflow()));
    await waitFor(`document.body.dataset.ready === "1"`, "reads finished");
    await shot("index", width);
  }
  const ready = await evalJs("!!document.querySelector('.send') && !!document.querySelector('#record')");
  if (args.keep !== true && typeof args.miniapp !== "string") check("below the fold: send, how it works and the proof view remain", ready);

  // ---- empty pool: a copy of the site whose pool lists only claimed shares ----
  const claimed = reads.filter((r) => !(r.note?.state === "Sealed" && r.note.claim));
  if (claimed.length) {
    const tmp = mkdtempSync(path.join(tmpdir(), "cachet-empty-"));
    cpSync(WEB, tmp, { recursive: true });
    writeFileSync(path.join(tmp, "judge-links.json"), JSON.stringify(links.filter((e) => claimed.some((r) => r.token === new URLSearchParams(e.fragment).get("token")))));
    const port2 = await new Promise((res) => { const s2 = createServer().listen(0, "127.0.0.1", () => { const p = s2.address().port; s2.close(() => res(p)); }); });
    const server2 = spawn("python3", [path.join(root, "scripts/serve-web.py"), String(port2), tmp], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port2}/`)).ok) break; } catch {} await sleep(100); }
    await open_(`http://localhost:${port2}/index.html?network=testnet`, 1440);
    await waitFor(`document.querySelector("#panel-body a.btn")`, "empty pool example");
    const e = await evalJs(`({ h1: document.querySelector("h1").textContent, sub: document.querySelector("#gift-sub").textContent, panel: document.querySelector("#panel-body").innerText, cta: document.querySelector("#panel-body a.btn")?.textContent, page: document.body.innerText, card: !!document.querySelector(".gift-card .figure-n") })`);
    check("empty pool: headline says every share is claimed", e.h1 === "Every share is claimed.", e.h1);
    check("empty pool: the last claimed share is shown as a real example with its owner", e.card && /Owner: /.test(e.panel) && /Here is the last one/.test(e.sub), `${e.sub} | ${e.panel.slice(0, 80)}`);
    check("empty pool: the primary action sends an envelope", e.cta === "Send an envelope", e.cta);
    check("empty pool: no dash placeholders or read failures", !/READ FAILED|Failed to fetch|HTTP \d{3}/.test(e.page) && !/\n-\n/.test(e.page));
    await shot("index-empty", 1440);
    server2.kill();
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---- --keep: continue from the claim account already saved in this browser (Pass it on only) ----
  if (DO_PASS && args.keep === true) {
    await open_(`${BASE}/index.html?network=testnet`, 1440);
    await waitFor(`document.querySelector("#pass-go")`, "pass button on an owned note");
    await runPass((await text(".gift-card .card-title")).match(/#(\d+)/)[1]);
  } else
  // ---- one cold walletless claim through the real page ----
  if (DO_CLAIM) {
    await open_(`${BASE}/index.html?network=testnet`, 1440);
    await evalJs("localStorage.clear()");
    const t0 = Date.now();
    const pin = args.token ? links.find((e) => new URLSearchParams(e.fragment).get("token") === String(args.token)) : null;
    const MINI = typeof args.miniapp === "string" ? readFileSync(args.miniapp, "utf8").trim() : null; // a Telegram web-app launch URL (RequestAppWebView), opened as Telegram opens the Mini App
    if (MINI) await S("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { // the native-client side of Telegram CloudStorage (TelegramWebviewProxy), answering custom method calls from this page
      const store = new Map();
      window.TelegramWebviewProxy = { postEvent(type, data) {
        if (type !== "web_app_invoke_custom_method") return;
        const call = JSON.parse(data || "{}");
        const params = call.params || {};
        let result = true;
        if (call.method === "saveStorageValue") store.set(params.key, params.value);
        if (call.method === "getStorageValues") result = Object.fromEntries((params.keys || []).filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
        setTimeout(() => window.Telegram.WebView.receiveEvent("custom_method_invoked", { req_id: call.req_id, result }), 30);
      } };
    })()` });
    await S("Page.navigate", { url: MINI || `${BASE}/index.html?network=testnet${pin ? `#${pin.fragment}` : ""}` });
    if (pin) { await sleep(500); await S("Page.reload"); } // a hash-only navigation does not reload the page
    await waitFor(`document.querySelector("#claim-go") && document.querySelector(".gift-card .figure-n")`, "cold first screen");
    if (MINI) check("miniapp: Telegram.WebApp.initData is present in the page", await evalJs("!!globalThis.Telegram?.WebApp?.initData"), "no initData");
    const target = (await text(".gift-card .card-title")).match(/#(\d+)/)[1];
    await waitFor(`document.body.dataset.ready === "1"`, "first draw finished");
    await sleep(1000);
    const before = await evalJs("location.href");
    console.log("pre-click", JSON.stringify(await evalJs("({ y: scrollY, w: innerWidth, h: innerHeight, r: JSON.stringify(document.querySelector('#claim-go').getBoundingClientRect()), hash: location.hash.slice(0, 40) })")));
    if (MINI) {
      const mb = await evalJs(`({ visible: Telegram.WebApp.MainButton.isVisible, text: Telegram.WebApp.MainButton.text, inPage: getComputedStyle(document.querySelector("#claim-go")).display, wallet: document.querySelector("#tma-wallet")?.innerText.replace(/\\s+/g, " "), lock: document.querySelector(".env-lock")?.innerText.replace(/\\s+/g, " "), status: document.querySelector(".env .card-state")?.innerText, sealedWord: /\\bseal(ed)?\\b/i.test(document.querySelector(".gift")?.innerText || "") })`);
      check("miniapp: the claim action is the Telegram MainButton labelled Claim my share", mb.visible === true && mb.text === ACTION && mb.inPage === "none", JSON.stringify(mb));
      check("miniapp: the wallet header shows the Telegram user and a Bitcoin balance", /^Hi, \S+/.test(mb.wallet || "") && /Bitcoin balance/.test(mb.wallet || ""), mb.wallet);
      check("miniapp: the envelope says who alone can open it, and the status is one plain word", /^Only .+ can open this$/.test(mb.lock || "") && /^[A-Z][a-z]+$/.test((mb.status || "").trim()), `${mb.lock} / ${mb.status}`);
      check("miniapp: primary copy never says sealed", mb.sealedWord === false, "the word seal appears on the first screen");
      await evalJs(`Telegram.WebView.receiveEvent("main_button_pressed")`); // what the Telegram client sends when the native MainButton is tapped
    } else await click("#claim-go");
    await sleep(1500);
    console.log("post-click", JSON.stringify(await evalJs("({ btn: document.querySelector('#claim-go')?.textContent, say: document.querySelector('.panel-say')?.textContent, st: document.querySelector('#claim-status').textContent })")));
    const labels = new Set();
    const end = Date.now() + 120000;
    while (Date.now() < end && !(await evalJs("document.querySelector('.panel-title')?.textContent === 'Your share is yours.'"))) {
      labels.add(await evalJs("document.querySelector('#claim-go')?.textContent || document.querySelector('.panel-say')?.textContent || ''"));
      if (await evalJs("document.querySelector('.panel-title')?.textContent === 'The claim did not go through.'")) break;
      await sleep(300);
    }
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const title = await text(".panel-title");
    if (title !== "Your share is yours.") console.log("claim page state", JSON.stringify(await evalJs("document.querySelector('.panel')?.innerText || document.body.innerText.slice(0, 600)")), "errors", JSON.stringify([...new Set(errors)].slice(0, 6)));
    check("claim: the panel ends on 'Your share is yours.'", title === "Your share is yours.", `${title} ${await text(".panel-say")}`);
    check("claim: the URL is unchanged by the press", (await evalJs("location.href")) === before, `${before} -> ${await evalJs("location.href")}`);
    const account = await evalJs("JSON.parse(localStorage.getItem('cachet:claim-account:testnet')).accountId");
    const nft = await view(CONTRACT, "nft_token", { token_id: target });
    check("claim: nft_token owner on chain is the new claim account", nft?.owner_id === account, `${nft?.owner_id} vs ${account}`);
    await evalJs(`document.querySelector("#owner-details")?.setAttribute("open", "")`);
    const done = await evalJs(`({ rows: document.querySelector(".panel-rows")?.innerText.replace(/\\s+/g, " "), href: document.querySelector(".panel-rows a")?.href, holder: document.querySelector(".gift-card .holder")?.textContent, shares: document.querySelector(".shares-left")?.textContent, next: (document.querySelector("#heir-go") || document.querySelector("#move-go"))?.textContent })`);
    check("claim: the panel shows owner, claim transaction and key file", /Owner you, claim account/.test(done.rows || "") && (MINI ? /Saved as your Telegram cloud backup/ : /Saved as cachet-[0-9a-f]{8}\.key/).test(done.rows || "") && !!done.href, done.rows);
    check("claim: the card holder reads You", done.holder === "You", done.holder);
    check("claim: shares left dropped by one", done.shares === `${open.length - 1} of ${reads.length} shares left`, done.shares);
    check("claim: the next action is offered", /^(Open as the named heir|Checking Bitcoin…)$/.test(done.next || "") || done.next === "Move it to a Bitcoin address", done.next);
    console.log(`claim: ${seconds}s from page load to the confirmed owner. progress labels seen: ${[...labels].join(" | ")}. claim tx ${done.href}`);
    await shot("claimed", 1440);
    if (DO_PASS) await runPass(target);
    if (DO_HEIR) {
      const noteNow = async () => view(CONTRACT, "note", { token_id: target });
      const heir = (await noteNow())?.heir;
      check("heir: the note on chain names its heir", /^tb1q/.test(heir || ""), String(heir));
      check("heir: the headline names one address only", /pays one person only/i.test(await text("#gift-title")) || /one address/i.test(await text("#gift-title")), await text("#gift-title"));
      await waitFor("document.querySelector('#steal-go') && !document.querySelector('#steal-go').disabled", "Steal this link enabled", 90000);
      const tSteal = Date.now();
      await click("#steal-go");
      await waitFor("document.querySelector('#steal-result')?.dataset.state", "steal result", 120000);
      const stolen = await evalJs("({ state: document.querySelector('#steal-result').dataset.state, text: document.querySelector('#steal-result').innerText, href: document.querySelector('#steal-result a')?.href })");
      check("heir: Steal this link is refused by the contract with its reason", stolen.state === "refused" && /sweeps only to its heir/.test(stolen.text) && !!stolen.href, `${stolen.state} ${stolen.text} ${stolen.href}`);
      console.log(`heir: refusal in ${((Date.now() - tSteal) / 1000).toFixed(1)}s, tx ${stolen.href}`);
      const afterSteal = await noteNow();
      check("heir: after the refused theft the note is still Sealed and owned by the claim account", afterSteal?.state === "Sealed" && (await view(CONTRACT, "nft_token", { token_id: target }))?.owner_id === account, String(afterSteal?.state));
      await shot("steal-refused", 1440);
      await waitFor("document.querySelector('#heir-go') && !document.querySelector('#heir-go').disabled", "Open as the named heir enabled", 60000);
      const tHeir = Date.now();
      await click("#heir-go");
      const until = Date.now() + 240000;
      let state;
      while (Date.now() < until) { state = (await noteNow())?.state; if (state === "Unsealed") break; await sleep(4000); }
      check("heir: Open as the named heir signs the sweep, note is Unsealed", state === "Unsealed", String(state));
      console.log(`heir: sweep signed in ${((Date.now() - tHeir) / 1000).toFixed(1)}s`);
      await waitFor("[...document.querySelectorAll('.station')].some((s) => s.querySelector('h3')?.textContent === 'Broadcast' && s.dataset.state === 'current')", "broadcast station current", 60000);
      await click("#stations .station[data-state=current] .btn-primary");
      await waitFor("[...document.querySelectorAll('.station')].some((s) => s.querySelector('h3')?.textContent === 'Broadcast' && s.dataset.state === 'done')", "broadcast done", 120000);
      const sweepTxid = await evalJs("([...document.querySelectorAll('.station')].find((s) => s.querySelector('h3')?.textContent === 'Broadcast')?.querySelector('.station-tx a')?.href || '').split('/tx/')[1] || ''");
      let btcTx = null;
      for (let attempt = 0; sweepTxid && !btcTx && attempt < 12; attempt += 1) { btcTx = await (await fetch(`https://blockstream.info/testnet/api/tx/${sweepTxid}`).catch(() => ({ json: async () => null }))).json().catch(() => null); if (!btcTx?.vout) { btcTx = null; await sleep(5000); } }
      check("heir: the Bitcoin sweep pays only the bound heir address", !!btcTx && btcTx.vout.length === 1 && btcTx.vout[0].scriptpubkey_address === heir, `${sweepTxid} ${JSON.stringify(btcTx?.vout?.map((o) => o.scriptpubkey_address))}`);
      console.log(`heir: Bitcoin sweep https://blockstream.info/testnet/tx/${sweepTxid}`);
      await shot("heir-swept", 1440);
    }
    if (DO_UNSEAL) {
      const funded = spawnSync("near", ["tokens", "cachet-ops.testnet", "send-near", account, "0.1 NEAR", "network-config", process.env.NETCFG || "testnet-archfn", "sign-with-legacy-keychain", "send"], { encoding: "utf8" });
      check("unseal: the claim account is funded with 0.1 NEAR for gas", funded.status === 0, (funded.stderr || funded.stdout).split("\n").filter((l) => /Error|rate/.test(l)).join(" "));
      await click("#move-go");
      await waitFor("document.querySelector('#claim-destination')?.value && document.querySelector('#claim-fee')?.value", "destination and fee defaults");
      await waitFor("document.querySelector('#claim-funds')?.textContent.includes('pays the network fee')", "claim account balance read", 60000);
      check("unseal: the Unseal station is open with a Bitcoin destination and fee", await evalJs("!!document.querySelector('.tool-form button[type=submit]') && !document.querySelector('.tool-form button[type=submit]').disabled"));
      await click(".tool-form button[type=submit]");
      const noteNow = async () => view(CONTRACT, "note", { token_id: target });
      const until = Date.now() + 240000;
      let state;
      while (Date.now() < until) { state = (await noteNow())?.state; if (state === "Unsealed") break; await sleep(4000); }
      check("unseal: note state on chain is Unsealed, signed by the claim account", state === "Unsealed", String(state));
      await waitFor("[...document.querySelectorAll('.station')].some((s) => s.querySelector('h3')?.textContent === 'Broadcast' && s.dataset.state === 'current')", "broadcast station current", 60000);
      await shot("unsealed", 1440);
    }
  }

  // The public NEAR RPC providers answer 429, or a 429 without CORS headers, under shared load; chain.js fails over to the next provider.
  const real = errors.filter((e) => !/(408|429|blocked by CORS policy|ERR_FAILED).*(rpc|drpc)|(rpc|drpc).*(408|429|CORS|ERR_FAILED)|Failed to load resource: net::ERR_FAILED https:\/\/test\.rpc|404 \(Not Found\) https:\/\/blockstream\.info\/testnet\/api\/tx\//.test(e));
  check("zero console errors on every page (RPC provider failover noise excluded)", real.length === 0, [...new Set(real)].join(" | ").slice(0, 600));
} catch (error) {
  check("script ran to the end", false, String(error.message).split("\n")[0]);
} finally {
  await send("Target.closeTarget", { targetId }).catch(() => {});
  ws.close();
  server.kill();
}
console.log(`\n${failures.length ? "RED" : "GREEN"}: ${passes.length} ok, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
