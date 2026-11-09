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
