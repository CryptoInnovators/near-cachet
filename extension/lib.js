(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CachetExtension = api;
})(globalThis, function () {
  const DEFAULT_WEB_URL = "https://near-cachet.nearlive.workers.dev";
  const CONTRACT = "cachet.testnet";
  const RPC = "https://rpc.testnet.near.org";

  function handleFromX(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const attribute = value.trim().replace(/^@/, "");
    if (/^[A-Za-z0-9_]{1,15}$/.test(attribute)) return attribute;
    try {
      const url = new URL(value.startsWith("/") ? `https://x.com${value}` : value);
      if (!/^(?:www\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)) return null;
      const handle = url.pathname.split("/").filter(Boolean)[0];
      return handle && !["home", "explore", "messages", "notifications", "search", "i", "settings", "compose"].includes(handle.toLowerCase())
        ? handle.replace(/^@/, "") : null;
    } catch { return null; }
  }

  function claimLink(value, webUrl = DEFAULT_WEB_URL) {
    if (typeof value !== "string") return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    const base = new URL(webUrl);
    if (url.origin !== base.origin || !/^\/?claim\/?$/.test(url.pathname)) return null;
    const id = url.searchParams.get("note");
    if (!id || !/^\d+$/.test(id)) return null;
    return { id, shareUrl: `${base.origin}/e/${encodeURIComponent(id)}` };
  }

  function formatState(note) {
    if (!note || typeof note.state !== "string") return "Unavailable";
    const sats = note.utxo && Number.isSafeInteger(note.utxo.sats) ? note.utxo.sats : null;
    return sats === null ? note.state : `${note.state} · ${sats.toLocaleString("en-US")} sats`;
  }

  async function fetchNote(id, fetchImpl = fetch) {
    const args = btoa(JSON.stringify({ token_id: String(id) }));
    const response = await fetchImpl(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-extension", method: "query", params: {
        request_type: "call_function", finality: "final", account_id: CONTRACT,
        method_name: "note", args_base64: args
      } })
    });
    if (!response.ok) throw new Error(`NEAR RPC returned ${response.status}`);
    const body = await response.json();
    if (body.error || !body.result || !Array.isArray(body.result.result)) throw new Error("NEAR note query failed");
    const bytes = Uint8Array.from(body.result.result);
    const note = JSON.parse(new TextDecoder().decode(bytes));
    if (!note || String(note.token_id) !== String(id)) throw new Error("NEAR returned a different note");
    return note;
  }

  return { DEFAULT_WEB_URL, CONTRACT, RPC, handleFromX, claimLink, formatState, fetchNote };
});
