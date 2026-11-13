import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("the envelope screen never hides content behind .rise", () => {
  for (const page of ["../claim.html", "../index.html"]) {
    const html = readFileSync(new URL(page, import.meta.url), "utf8");
    const gift = html.slice(html.indexOf('<section class="gift"'), html.indexOf("</section>", html.indexOf('<section class="gift"')));
    assert.ok(gift.length > 200 && !/class="[^"]*\brise\b/.test(gift), page + " first screen must render without a reveal step");
  }
  const src = readFileSync(new URL("../claim.js", import.meta.url), "utf8");
  assert.ok(!/class: "[^"]*\brise\b/.test(src), "claim.js must not create .rise elements");
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
