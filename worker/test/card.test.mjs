import test from "node:test";
import assert from "node:assert/strict";
import { cardSvg, envelopeHtml, escapeHtml, formatSats } from "../src/card.mjs";

test("card and metadata render a live sealed testnet judge note", async () => {
  const links = await import("../../web/judge-links.json", { with: { type: "json" } });
  const ids = [...new Set(links.default.map(({ fragment }) => new URLSearchParams(fragment).get("token")))];
  assert.ok(ids.length >= 1, "judge links provide at least one real note id");
  for (const id of ids) {
    const args = btoa(JSON.stringify({ token_id: id }));
    const response = await fetch("https://near-testnet.drpc.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-test", method: "query", params: { request_type: "call_function", finality: "final", account_id: "heir.cachet-ops.testnet", method_name: "note", args_base64: args } }),
    });
    assert.equal(response.status, 200, `NEAR RPC returned HTTP 200 for live note ${id}`);
    const payload = await response.json();
    assert.equal(payload.error, undefined, `NEAR RPC returned note ${id}`);
    const note = JSON.parse(new TextDecoder().decode(new Uint8Array(payload.result.result)));
    assert.ok(note, `note ${id} exists on testnet`);
    assert.equal(note.token_id, id);
    const svg = cardSvg(note);
    const page = envelopeHtml({ id, note, origin: "https://cachet.example" });
    assert.match(svg, /width="1200" height="630"/);
    assert.match(svg, /Bitcoin red envelope/i);
    assert.match(svg, new RegExp(`${formatSats(note.utxo?.sats || 0)} sats`));
    assert.match(page, new RegExp(`<title>${note.state === "Sealed" ? "Sealed " : ""}Bitcoin red envelope #${id}</title>`));
    assert.match(page, new RegExp(`property="og:description" content="${formatSats(note.utxo?.sats || 0)} sats · ${note.state}"`));
    assert.match(page, new RegExp(`claim\\?network=testnet&amp;note=${id}`));
    assert.match(page, new RegExp(`og:image" content="https://cachet\\.example/og/${id}\\.svg`));
    assert.match(page, new RegExp(`${note.state}`));
  }
});

test("escaping and satoshi formatting handle hostile values", () => {
  assert.equal(escapeHtml(`<"&'>`), "&lt;&quot;&amp;&#39;&gt;");
  assert.equal(formatSats(50000), "50,000");
  assert.doesNotMatch(cardSvg({ state: `<script>`, utxo: { sats: 50000 } }), /<script>/);
});
