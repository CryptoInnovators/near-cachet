import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.crypto ??= (await import("node:crypto")).webcrypto;
const lib = require("../claim-lib.js");

const sealedOpen = { state: "Sealed", claim: { key: "k" } };
const claimed = { state: "Sealed", claim: null };

test("tallyShares counts only Sealed notes with an open claim", () => {
  const t = lib.tallyShares([{ token: "1", note: sealedOpen }, { token: "2", note: claimed }, { token: "3", note: null }, { token: "4", note: { state: "Unsealed", claim: null } }, { token: "5", note: sealedOpen }]);
  assert.deepEqual(t, { total: 5, left: 2 });
});

test("an envelope with every share claimed has none left, and the picker finds no link", async () => {
  const entries = [2, 3].map((n) => ({ fragment: lib.buildFragment({ contract: "cachet.testnet", token: String(n), key: "a".repeat(64), sender: "cachet-ops.testnet" }) }));
  assert.equal(lib.tallyShares([{ token: "2", note: claimed }, { token: "3", note: null }]).left, 0);
  assert.equal(await lib.pickJudgeFragment({ contract: "cachet.testnet" }, async () => claimed, entries), null);
  assert.equal(await lib.pickJudgeFragment({ contract: "cachet.testnet" }, async (f) => (f.token === "3" ? sealedOpen : claimed), entries), entries[1].fragment);
});
