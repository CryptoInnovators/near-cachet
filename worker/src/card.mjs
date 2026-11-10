export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

export function formatSats(sats) {
  return new Intl.NumberFormat("en-US").format(sats);
}

export function cardSvg(note) {
  const sats = Number(note?.utxo?.sats || 0);
  const state = String(note?.state || "Unknown");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Bitcoin red envelope: ${escapeHtml(formatSats(sats))} sats, ${escapeHtml(state)}"><rect width="1200" height="630" fill="#B3121B"/><path d="M0 490 600 235l600 255v140H0z" fill="#9D0D17"/><rect x="105" y="100" width="990" height="430" rx="28" fill="#C51A22" stroke="#E2B860" stroke-width="3"/><path d="m106 124 494 280 494-280M106 529l356-260m632 260L738 269" fill="none" stroke="#E2B860" stroke-width="3" opacity=".8"/><circle cx="600" cy="315" r="71" fill="#D7AA4B"/><circle cx="600" cy="315" r="59" fill="#B3121B" stroke="#F3D48A" stroke-width="3"/><path d="M578 286h31c27 0 27 29 0 29h-22m0 0h25c28 0 27 30-1 30h-31m15-76v94m-31-71h18m-18 47h18" fill="none" stroke="#F3D48A" stroke-width="5" stroke-linecap="round"/><text x="600" y="166" text-anchor="middle" fill="#F3D48A" font-family="Arial,sans-serif" font-size="22" letter-spacing="7">A BITCOIN RED ENVELOPE</text><text x="600" y="464" text-anchor="middle" fill="#FFF8E8" font-family="Arial,sans-serif" font-size="48" font-weight="700">${escapeHtml(formatSats(sats))} sats</text><text x="600" y="501" text-anchor="middle" fill="#F3D48A" font-family="Arial,sans-serif" font-size="23">${(sats / 100_000_000).toFixed(8)} BTC · ${escapeHtml(state)}</text></svg>`;
}

export function envelopeHtml({ id, note, origin }) {
  const sats = Number(note?.utxo?.sats || 0);
  const title = "A Bitcoin red envelope";
  const description = `${formatSats(sats)} sats · ${note?.state || "Unknown"}`;
  const image = `${origin}/og/${encodeURIComponent(id)}.svg`;
  const target = new URL(`/claim?note=${encodeURIComponent(id)}`, origin);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><meta name="description" content="${escapeHtml(description)}"><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(origin)}/e/${encodeURIComponent(id)}"><meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(image)}"><meta http-equiv="refresh" content="0;url=${escapeHtml(target)}"></head><body><a href="${escapeHtml(target)}">Open your Bitcoin red envelope</a></body></html>`;
}
