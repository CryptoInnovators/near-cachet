import { cardSvg, envelopeHtml } from "./card.mjs";

const RPC = "https://rpc.testnet.near.org";
const CONTRACT = "cachet.testnet";
const isId = (id) => /^\d+$/.test(id);

async function getNote(id) {
  const args = btoa(JSON.stringify({ token_id: id }));
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-card", method: "query", params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: "note", args_base64: args } }),
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "NEAR RPC error");
  const raw = new Uint8Array(payload.result.result);
  const note = JSON.parse(new TextDecoder().decode(raw));
  if (!note) throw new Error("Note not found");
  return note;
}

const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" } });
const errorResponse = (error) => new Response(error, { status: error === "Note not found" ? 404 : 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/hongbao" || url.pathname === "/hongbao/") {
      const target = new URL("/hongbao.html", url.origin);
      target.search = url.search;
      return Response.redirect(target, 302);
    }
    let match = url.pathname.match(/^\/e\/(\d+)\/?$/);
    if (match) {
      try {
        const id = match[1];
        const note = await getNote(id);
        const isCrawler = /bot|crawler|spider|facebookexternalhit|twitterbot|whatsapp|telegrambot|slackbot|discordbot|preview/i.test(request.headers.get("user-agent") || "");
        if (isCrawler) return html(envelopeHtml({ id, note, origin: url.origin }));
        const target = new URL("/claim", url.origin);
        target.searchParams.set("network", "testnet");
        target.searchParams.set("note", id);
        for (const [key, value] of url.searchParams) if (key !== "note") target.searchParams.append(key, value);
        return Response.redirect(target, 302);
      } catch (error) { return errorResponse(error.message); }
    }
    match = url.pathname.match(/^\/og\/(\d+)\.(svg|png)$/);
    if (match) {
      if (match[2] === "png") return new Response(null, { status: 302, headers: { location: `/og/${match[1]}.svg`, "x-cachet-image-fallback": "SVG; PNG rendering is not bundled" } });
      try {
        return new Response(cardSvg(await getNote(match[1])), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=30" } });
      } catch (error) { return errorResponse(error.message); }
    }
    if (url.pathname === "/claim") return env.ASSETS.fetch(new Request(new URL("/claim.html", url.origin), request));
    return env.ASSETS.fetch(request);
  },
};
