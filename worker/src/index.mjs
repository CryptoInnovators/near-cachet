import { cardSvg, envelopeHtml } from "./card.mjs";
import { handleSponsor } from "./sponsor.mjs";
import { handleHeirName, handleTelegram } from "./telegram.mjs";
import { handleTmaSend, isTransientRpcError, validateInitData } from "./initdata.mjs";
import { handleHotChallenge, handleHotVerify } from "./hot.mjs";

const RPCS = ["https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"];
const CONTRACT = "heir.cachet-ops.testnet";
const isId = (id) => /^\d+$/.test(id);
const SEND_RPCS = ["https://archival-rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"];
async function sendRpc(method, params) {
  let failure;
  // The Cloudflare egress IP is shared, so every provider can rate limit at once for a second or two: go around again after a pause.
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, 900 * round));
    for (const url of SEND_RPCS) {
      try {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-tma", method, params }), signal: AbortSignal.timeout(20000) });
        const payload = await response.json();
        if (payload?.error) { failure = new Error((typeof payload.error.data === "string" && payload.error.data) || [payload.error.message, payload.error.cause?.name, payload.error.cause?.info?.error_message].filter(Boolean).join(": ") || "NEAR RPC error"); if (isTransientRpcError(payload.error)) continue; throw Object.assign(failure, { final: true }); }
        if (payload?.result) return payload.result;
        failure = new Error(`NEAR RPC HTTP ${response.status}`);
      } catch (error) { if (error.final) throw error; failure = error; }
    }
  }
  throw failure || new Error("No NEAR RPC answered.");
}

async function getNote(id) {
  const args = btoa(JSON.stringify({ token_id: id }));
  let failure;
  for (const rpc of RPCS) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "cachet-card", method: "query", params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: "note", args_base64: args } }),
      });
      if (!response.ok) { failure = new Error(`NEAR RPC HTTP ${response.status}`); continue; }
      const payload = await response.json();
      if (payload?.error?.code === -429 || [429,502,503,504].includes(response.status)) { failure = new Error(payload?.error?.message || `NEAR RPC HTTP ${response.status}`); continue; }
      if (payload?.error) throw new Error(payload.error.message || "NEAR RPC error");
      const raw = new Uint8Array(payload.result.result);
      const note = JSON.parse(new TextDecoder().decode(raw));
      if (!note) throw new Error("Note not found");
      return note;
    } catch (error) { failure = error; }
  }
  throw failure || new Error("No RPC provider answered.");
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
    if (url.pathname === "/api/sponsor") {
      if (request.method !== "POST") return handleSponsor(request, env);
      const text = await request.text();
      let initData = null;
      try { initData = JSON.parse(text)?.init_data; } catch { /* handleSponsor answers the bad body */ }
      const checked = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
      if (!checked.ok) return new Response(JSON.stringify({ error: checked.reason, code: "telegram_initdata_refused" }), { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      return handleSponsor(new Request(request.url, { method: "POST", headers: request.headers, body: text }), env);
    }
    if (url.pathname === "/api/hot/challenge") return handleHotChallenge(request, env);
    if (url.pathname === "/api/hot/verify") return handleHotVerify(request, env);
    if (url.pathname === "/api/tma/send") return handleTmaSend(request, env, { contract: CONTRACT, rpc: sendRpc });
    if (url.pathname === "/api/heir-name") return handleHeirName(request, env);
    if (url.pathname === "/api/telegram") return handleTelegram(request, env);
    if (url.pathname === "/claim") return env.ASSETS.fetch(new Request(new URL("/claim.html", url.origin), request));
    return env.ASSETS.fetch(request);
  },
};
