#!/usr/bin/env node
// Opens ONE tab in the running `deepsurge` browser over CDP, loads a page at each width,
// waits for a JS predicate, saves a full-page PNG per width and fails on any console error,
// uncaught exception or failed resource. Closes its tab on exit.
// usage: node scripts/shoot.mjs --url URL --out DIR --name NAME [--widths 390,1440] [--wait "JS"] [--then "JS"] [--timeout 90] [--viewport-only]
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));
const url = args.url, out = args.out || ".", name = args.name || "page";
if (!url) { console.error("--url required"); process.exit(2); }
const widths = String(args.widths || "390,1440").split(",").map(Number);
const timeout = Number(args.timeout || 90) * 1000;
mkdirSync(out, { recursive: true });

const ports = JSON.parse(readFileSync(`${homedir()}/.local/share/bhn/ports.json`, "utf8"));
const port = ports.deepsurge.port;
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
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
  if (msg.method === "Runtime.exceptionThrown") errors.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ""}`);
});
await S("Page.enable"); await S("Runtime.enable"); await S("Log.enable"); await S("Network.enable"); await S("Network.setCacheDisabled", { cacheDisabled: true });
await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: args.motion ? "no-preference" : "reduce" }] });

const evalJs = async (expression) => {
  const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const results = [];
try {
  for (const w of widths) {
    const mobile = w < 600;
    await S("Emulation.setDeviceMetricsOverride", { width: w, height: mobile ? 844 : 900, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await S("Page.navigate", { url });
    const end = Date.now() + timeout;
    if (args.wait) {
      for (;;) {
        let ok = false;
        try { ok = await evalJs(`!!(${args.wait})`); } catch {}
        if (ok) break;
        if (Date.now() > end) { errors.push(`timeout (${w}px) waiting for: ${args.wait}`); break; }
        await new Promise((r) => setTimeout(r, 500));
      }
    } else await new Promise((r) => setTimeout(r, 4000));
    if (args.then) await evalJs(args.then);
    if (args.scroll) {
      // walk the page so IntersectionObserver reveals fire, then come back to the top
      const total = await evalJs(`document.documentElement.scrollHeight`);
      for (let y = 0; y < total; y += 500) { await evalJs(`window.scrollTo({ top: ${y}, behavior: "instant" })`); await new Promise((r) => setTimeout(r, 140)); }
      await evalJs(`window.scrollTo({ top: 0, behavior: "instant" })`);
      await new Promise((r) => setTimeout(r, 900));
    }
    await new Promise((r) => setTimeout(r, 700));
    const probe = args.probe ? await evalJs(args.probe) : undefined;
    const overflow = await evalJs(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    const height = await evalJs(`Math.ceil(document.documentElement.scrollHeight)`);
    const shot = await S("Page.captureScreenshot", args["viewport-only"] ? { format: "png" } : { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(height, 12000), scale: 1 } });
    const file = `${out}/${name}-${w}.png`;
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    results.push({ width: w, file, height, horizontalOverflowPx: overflow, probe });
  }
} finally {
  await send("Target.closeTarget", { targetId }).catch(() => {});
  ws.close();
}
const report = { url, name, results, errors: [...new Set(errors)] };
console.log(JSON.stringify(report, null, 1));
const bad = report.errors.length || results.some((r) => r.horizontalOverflowPx > 0);
process.exit(bad ? 1 : 0);
