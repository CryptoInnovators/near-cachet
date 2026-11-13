import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { outspendStatus } = require("./chain.js");

const fixtures = {
  spent: { spent: true },
  unspent: { spent: false },
  missingRead: null,
};

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`outpoint status: ${name}`, async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl;
    globalThis.fetch = async (url) => {
      requestedUrl = url;
      return fixture === null
        ? { ok: false, status: 503, text: async () => "unavailable" }
        : { ok: true, json: async () => fixture };
    };
    try {
      const result = await outspendStatus("https://mempool.space", "a1b2", 3);
      assert.match(requestedUrl, /\/api\/tx\/a1b2\/outspend\/3$/);
      assert.equal(result.spent, fixture?.spent ?? null);
      assert.ok(Number.isFinite(Date.parse(result.readAt)));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("a hung explorer is skipped after its first timeout, so later reads go straight to the twin", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith("https://mempool.space")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    return { ok: true, json: async () => ({ spent: false }) };
  };
  try {
    const first = await outspendStatus("https://mempool.space/testnet", "c3d4", 0);
    assert.equal(first.spent, false);
    calls.length = 0;
    const second = await outspendStatus("https://mempool.space/testnet", "c3d4", 1);
    assert.equal(second.spent, false);
    assert.deepEqual(calls, ["https://blockstream.info/testnet/api/tx/c3d4/outspend/1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
