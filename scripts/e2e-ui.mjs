#!/usr/bin/env node
// UI e2e against live testnet. Serves web/ (or --web DIR) locally, drives the real pages in the
// signed-in `deepsurge` Brave over CDP (one tab, closed on exit), and compares what the DOM shows
// with direct RPC reads made here. Fails on any console error, any horizontal overflow, a missing
// headline, a hero without live chain data above the fold, or a gift claim flow whose sealed state,
// satoshi amount, funding txid or holder differ from the chain.
// usage: node scripts/e2e-ui.mjs [--web DIR] [--shots DIR] [--contract cachet.testnet]
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
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
const CONTRACT = args.contract || "cachet.testnet";
const RPCS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];
const TX_API = "https://tx.test.fastnear.com";

const HEADLINE = "Give a child Bitcoin they can claim when ready.";
const SUBHEAD = "Fund one sealed Bitcoin note, then hand over its claim link. The recipient claims it with a NEAR account; your seed phrase never leaves your wallet.";
const ACTION = "Claim a Bitcoin gift";

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
const port = await new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn("python3", [path.join(root, "scripts/serve-web.py"), String(port), WEB], { stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {} await sleep(100); }
// "localhost" and not 127.0.0.1: the profile keeps a browser zoom for 127.0.0.1 that shrinks emulated desktop viewports
const BASE = `http://localhost:${port}`;

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
    if (Date.now() > end) { check(`waited for ${what}`, false, "timeout"); return false; }
    await sleep(500);
  }
}
async function open(url, width) {
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
  const r = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(height, 12000), scale: 1 } });
  writeFileSync(`${SHOTS}/${name}-${width}.png`, Buffer.from(r.data, "base64"));
  console.log(`shot ${SHOTS}/${name}-${width}.png`);
}
const overflow = () => evalJs("document.documentElement.scrollWidth - document.documentElement.clientWidth");
const text = (sel) => evalJs(`(document.querySelector(${JSON.stringify(sel)})?.innerText || "").replace(/\\s+/g, " ").trim()`);

try {
  const links = JSON.parse(readFileSync(path.join(WEB, "judge-links.json"), "utf8"));
  const frag = new URLSearchParams(links[0].fragment);
  const TOKEN = frag.get("token");
  const note = await view(CONTRACT, "note", { token_id: TOKEN });
  const config = await view(CONTRACT, "config", {});
  const nft = await view(CONTRACT, "nft_token", { token_id: TOKEN });
  const head = (await rpc("block", { finality: "final" })).header.height;
  const tx = await latestTx(CONTRACT);
  check(`chain: note ${TOKEN} is Sealed and funded`, note?.state === "Sealed" && note.utxo?.sats > 0, JSON.stringify(note?.state));
  const fmt = new Intl.NumberFormat("en-US");
  const nonzero = [...note.utxo.block_hash].filter((c) => c !== "0").length;

  // ---- index at 1440, full motion ----
  await motion(false);
  await open(`${BASE}/index.html?network=testnet`, 1440);
  await waitFor(`document.querySelector("#strip")?.innerText.includes("NEAR block") && document.querySelector("#card-slot .card-state")`, "index strip and card");
  check("index headline", (await text("h1")) === HEADLINE, await text("h1"));
  check("index subhead", (await text("#hero-sub")) === SUBHEAD, await text("#hero-sub"));
  check("primary action label", (await text("#claim-cta")) === ACTION, await text("#claim-cta"));
  const gone = await evalJs(`[document.body.innerText.includes("Hand over Bitcoin by link"), document.body.innerText.includes("A seal has four lives"), !!document.querySelector(".ghost-mark")]`);
  check("cut: old headline, four-lives, giant wordmark are gone", gone.every((x) => x === false), JSON.stringify(gone));
  const above = await evalJs(`(() => { const fold = 900; const inFold = (el) => el && el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= fold; const s = document.querySelector("#strip"); const links = [...s.querySelectorAll("a")]; return { contract: links[0]?.textContent, contractIn: inFold(links[0]), txHref: links[1]?.href || "", txIn: inFold(links[1]), blockText: s.innerText, blockIn: inFold(s), cardIn: inFold(document.querySelector("#card-slot .card")), ctaIn: inFold(document.querySelector("#claim-cta")) }; })()`);
  check("contract account above the fold", above.contract === CONTRACT && above.contractIn, JSON.stringify(above.contract));
  check("latest tx hash above the fold equals the FastNear read", above.txIn && above.txHref.includes(tx), `${above.txHref} vs ${tx}`);
  const shownBlock = Number((above.blockText.match(/NEAR block ([\d,]+)/) || [])[1]?.replace(/,/g, ""));
  check("block height above the fold is live", above.blockIn && shownBlock <= head + 50 && head - shownBlock < 3000, `page ${shownBlock} head ${head}`);
  check("provenance card and primary action above the fold", above.cardIn && above.ctaIn, JSON.stringify({ card: above.cardIn, cta: above.ctaIn }));
  const card = await evalJs(`(() => { const c = document.querySelector("#card-slot .card"); return { state: c.querySelector(".card-state")?.textContent, sats: c.querySelector(".figure-n")?.textContent, body: c.innerText.replace(/\\s+/g, ""), ticks: c.querySelectorAll(".seal-tick").length, seal: c.querySelector(".card-seal")?.getBoundingClientRect().width }; })()`);
  check("card state equals chain", card.state === note.state, card.state);
  await waitFor(`document.querySelector("#card-slot .figure-n")?.textContent === ${JSON.stringify(fmt.format(note.utxo.sats))}`, "card satoshi amount");
  check("card satoshi amount equals chain", (await text("#card-slot .figure-n")) === fmt.format(note.utxo.sats), await text("#card-slot .figure-n"));
  check("card shows the funding txid and block hash", card.body.includes(note.utxo.txid) && card.body.includes(note.utxo.block_hash));
  check("seal ticks equal 64 minus the zero nibbles of the live block hash", card.ticks === nonzero, `${card.ticks} vs ${nonzero}`);
  check("seal is the hero object (at least 280px wide)", card.seal >= 280, String(card.seal));
  check("index 1440 has no horizontal overflow", (await overflow()) <= 0);
  await waitFor(`document.body.dataset.ready === "1"`, "index reads finished");
  const journey = await evalJs(`[...document.querySelectorAll("#journey > li, #journey li.step")].map((li) => li.innerText.replace(/\\s+/g, " "))`);
  const calls = ["config()", "note(token_id).address", "attest(", "create_claim(", "claim(token_id, new_owner", "unseal(", "finalize("];
  check("journey lists the seven gift steps in order, each naming its testnet call", journey.length === 7 && calls.every((c, i) => journey[i]?.includes(c)), `${journey.length} steps`);
  check("journey step 3 reads the live sealed state from chain", (journey[2] || "").includes("Sealed") && (journey[2] || "").includes(fmt.format(note.utxo.sats)), journey[2]);
  await shot("index", 1440);
  await motion(true);
  await open(`${BASE}/index.html?network=testnet`, 1440);
  await waitFor(`document.body.dataset.ready === "1"`, "index reads (motion on)");
  const total = await evalJs("document.documentElement.scrollHeight");
  for (let y = 0; y < total; y += 400) { await evalJs(`window.scrollTo({ top: ${y}, behavior: "instant" })`); await sleep(150); }
  await waitFor(`document.querySelectorAll(".rise:not(.in)").length === 0`, "every .rise element revealed", 4000);
  const hidden = await evalJs(`[...document.querySelectorAll(".rise:not(.in)")].map((e) => e.id || e.className)`);
  check("with motion on every .rise element ends visible", hidden.length === 0, hidden.join(", "));
  await motion(false);

  // ---- index at 390 ----
  await open(`${BASE}/index.html?network=testnet`, 390);
  await waitFor(`document.querySelector("#strip")?.innerText.includes("NEAR block") && document.querySelector("#card-slot .card-state")`, "index (390)");
  check("index 390 headline", (await text("h1")) === HEADLINE);
  const m = await evalJs(`(() => { const b = document.querySelector("#claim-cta").getBoundingClientRect(); return { w: b.width, top: b.top, bottom: b.bottom, h1: document.querySelector("h1").getBoundingClientRect().bottom }; })()`);
  check("390: primary action is full width and in the first screen", m.w >= 340 && m.bottom <= 844, JSON.stringify(m));
  check("index 390 has no horizontal overflow", (await overflow()) <= 0, String(await overflow()));
  await waitFor(`document.body.dataset.ready === "1"`, "index reads (390)");
  await shot("index", 390);

  // ---- gift claim flow: the primary action lands on the gift ----
  await open(`${BASE}/index.html?network=testnet`, 1440);
  await waitFor(`document.querySelector("#claim-cta") && document.body.dataset.ready === "1"`, "index before click");
  await evalJs(`document.querySelector("#claim-cta").click()`);
  await waitFor(`location.pathname.endsWith("claim.html") && location.hash.includes("token=")`, "claim page after primary action");
  await waitFor(`document.querySelector("#card-slot .card-state") && document.querySelector("#card-slot .figure-n") && document.body.dataset.ready === "1"`, "gift card");
  const landed = await evalJs(`location.hash`);
  const landedToken = new URLSearchParams(landed.slice(1)).get("token");
  const landedNote = landedToken === TOKEN ? note : await view(CONTRACT, "note", { token_id: landedToken });
  const landedNft = await view(CONTRACT, "nft_token", { token_id: landedToken });
  await waitFor(`document.querySelector("#card-slot .figure-n")?.textContent === ${JSON.stringify(fmt.format(landedNote.utxo.sats))}`, "gift satoshi amount");
  const gift = await evalJs(`(() => { const c = document.querySelector("#card-slot .card"); return { state: c.querySelector(".card-state")?.textContent, sats: c.querySelector(".figure-n")?.textContent, body: c.innerText.replace(/\\s+/g, ""), ticks: c.querySelectorAll(".seal-tick").length, page: document.body.innerText.replace(/\\s+/g, " "), claimBtn: document.querySelector("#claim-go")?.textContent, claimDisabled: document.querySelector("#claim-go")?.disabled, stations: [...document.querySelectorAll("#stations > li")].map((li) => li.querySelector("h3")?.textContent) }; })()`);
  check("gift page h1 names the gift", /gift/i.test(await text("h1")), await text("h1"));
  check("gift card shows the live sealed state read from chain", gift.state === landedNote.state && gift.state === "Sealed", gift.state);
  check("gift card shows the funded satoshi amount read from chain", gift.sats === fmt.format(landedNote.utxo.sats), gift.sats);
  check("gift card shows the Bitcoin funding txid", gift.body.includes(landedNote.utxo.txid));
  check("gift page shows the holder from nft_token", gift.body.includes(landedNft.owner_id), landedNft.owner_id);
  check("gift seal is drawn from the live block hash", gift.ticks === [...landedNote.utxo.block_hash].filter((c) => c !== "0").length, String(gift.ticks));
  check("gift page has a claim button, enabled for a live link", gift.claimBtn === "Claim this gift" && gift.claimDisabled === false, `${gift.claimBtn} ${gift.claimDisabled}`);
  check("gift journey stations are Claim, Unseal, Broadcast, Finalize", JSON.stringify(gift.stations) === JSON.stringify(["Claim", "Unseal", "Broadcast", "Finalize"]), JSON.stringify(gift.stations));
  check("gift page says it read at a live NEAR block", /NEAR block [\d,]+/.test(gift.page));
  check("gift 1440 has no horizontal overflow", (await overflow()) <= 0);
  await shot("claim", 1440);
  await open(`${BASE}/claim.html?network=testnet${landed}`, 390);
  await waitFor(`document.querySelector("#card-slot .figure-n") && document.body.dataset.ready === "1"`, "gift card (390)");
  check("gift 390 has no horizontal overflow", (await overflow()) <= 0, String(await overflow()));
  const cb = await evalJs(`document.querySelector("#claim-go").getBoundingClientRect().width`);
  check("gift 390 claim button is a full width touch target", cb >= 300, String(cb));
  await shot("claim", 390);

  // ---- a bare claim page opens the gift on its own ----
  await open(`${BASE}/claim.html?network=testnet`, 1440);
  await waitFor(`location.hash.includes("token=")`, "bare claim page picks a gift");
  await waitFor(`document.querySelector("#card-slot .card-state")`, "bare claim page card");

  check("zero console errors on every page", errors.length === 0, [...new Set(errors)].join(" | ").slice(0, 600));
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
