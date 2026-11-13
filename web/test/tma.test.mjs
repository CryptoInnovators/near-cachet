import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const tma = require("../tma.js");

test("themeVars maps Telegram themeParams to CSS variables and reads the scheme from the background", () => {
  const dark = tma.themeVars({ bg_color: "#17212b", text_color: "#f5f5f5", button_color: "#5288c1", hint_color: "bad" });
  assert.equal(dark.dark, true);
  assert.equal(dark.vars["--tg-bg"], "#17212b");
  assert.equal(dark.vars["--tg-button"], "#5288c1");
  assert.equal("--tg-hint" in dark.vars, false, "a value that is not #rrggbb is dropped");
  assert.equal(tma.themeVars({ bg_color: "#ffffff" }).dark, false);
  assert.equal(tma.themeVars({}).dark, null);
});

test("status gives one plain word per contract state and never the word Sealed", () => {
  for (const state of ["Minted", "Attesting", "Sealed", "Unsealing", "Unsealed", "Resigning", "Finalizing", "Claimed", "Mystery"]) {
    const s = tma.status(state);
    assert.match(s.word, /^[A-Z][a-z]+$/, state);
    assert.doesNotMatch(s.word, /seal/i);
    assert.ok(s.icon);
  }
  assert.equal(tma.status("Sealed").word, "Ready");
});

test("tileFor is deterministic per address and differs between addresses", () => {
  const a = tma.tileFor("tb1qjq6uvyjkdz08224h8tpsdte8hryazzjmrq50v9");
  assert.deepEqual(a, tma.tileFor("tb1qjq6uvyjkdz08224h8tpsdte8hryazzjmrq50v9"));
  assert.notEqual(a.hue, tma.tileFor("tb1qzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").hue);
  assert.equal(a.label, "QJ");
});

test("initials", () => {
  assert.equal(tma.initials("Kamal Singh"), "KA");
  assert.equal(tma.initials(""), "?");
});
