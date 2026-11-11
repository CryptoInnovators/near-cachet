import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("claim.js reveals .rise elements", () => {
  const src = readFileSync(new URL("../claim.js", import.meta.url), "utf8");
  const count = (src.match(/cachetUi\.reveal\(document\)/g) || []).length;
  assert.ok(count >= 2, `expected at least 2 reveal calls, got ${count}`);
});

test("ui reveal adds in class to all rise elements without IntersectionObserver", () => {
  const els = [
    { classes: [], style: { props: {}, getPropertyValue(k) { return this.props[k] || ""; }, setProperty(k, v) { this.props[k] = v; } } },
    { classes: [], style: { props: {}, getPropertyValue(k) { return this.props[k] || ""; }, setProperty(k, v) { this.props[k] = v; } } },
  ];
  for (const el of els) {
    el.classList = { add(c) { el.classes.push(c); } };
  }
  const doc = { querySelectorAll() { return els; } };
  globalThis.document = doc;
  delete globalThis.IntersectionObserver;
  globalThis.matchMedia = undefined;
  const ui = require("../ui.js");
  ui.reveal();
  for (const el of els) {
    assert.ok(el.classes.includes("in"), "element should get class in");
  }
});
