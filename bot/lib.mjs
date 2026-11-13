import { URL } from 'node:url';

export const DEFAULT_CONTRACT = 'heir.cachet-ops.testnet';
export const DEFAULT_WEB_URL = 'https://near-cachet.earn-shield-alerts.workers.dev';
export const RPC_URL = 'https://archival-rpc.testnet.fastnear.com';

export function parseCommand(text = '') {
  const [command = '', ...args] = text.trim().split(/\s+/);
  const name = command.split('@')[0].toLowerCase();
  if (name === '/envelope' || name === '/hongbao') {
    if (args.length !== 2) return { command: 'invalid' };
    if (!/^\d+$/.test(args[0]) || Number(args[0]) < 1 || Number(args[0]) > Number.MAX_SAFE_INTEGER) return { command: 'invalid' };
    if (!/^\d+$/.test(args[1])) return { command: 'invalid' };
    const shares = Number(args[1]);
    return Number.isSafeInteger(shares) && shares > 0 ? { command: 'envelope', sats: Number(args[0]), shares } : { command: 'invalid' };
  }
  if (name === '/link') return args.length === 2 ? { command: 'link', tokenId: args[0], claimUrl: args[1] } : { command: 'invalid' };
  if (name === '/heir') return args.length >= 2 && /^(tb1|bc1)[ac-hj-np-z02-9]{20,90}$/i.test(args[0]) ? { command: 'heir', address: args[0].toLowerCase(), name: args.slice(1).join(' ').slice(0, 40) } : { command: 'invalid' };
  if (name === '/status') return args.length === 1 ? { command: 'status', tokenId: args[0] } : { command: 'invalid' };
  return null;
}

export function parseClaimUrl(claimUrl, webUrl = DEFAULT_WEB_URL) {
  const u = new URL(claimUrl.startsWith('http') ? claimUrl : `/claim#${claimUrl.replace(/^#/, '')}`, webUrl);
  const fromHash = u.hash.match(/(?:^#|&)v=[12](?:&|$)/);
  const match = fromHash ? new URLSearchParams(u.hash.slice(1)) : u.searchParams;
  const tokenId = match.get('token') || match.get('note');
  const key = match.get('key');
  const contract = match.get('contract') || DEFAULT_CONTRACT;
  const sender = fromHash && match.get('v') === '2' ? match.get('sender') : null;
  if (!/^\d+$/.test(tokenId || '') || !/^[a-f0-9]{64}$/i.test(key || '') || contract !== DEFAULT_CONTRACT) throw new Error('Use a Cachet testnet claim link from the web claim-links file.');
  if (match.get('v') === '2' && !/^(?:[a-z0-9]+[._-])*[a-z0-9]+$/.test(sender || '')) throw new Error('The claim link names no sender account.');
  const destination = new URL('/claim', webUrl);
  destination.search = new URLSearchParams({ note: tokenId, key }).toString();
  // claim.js reads the fragment; query parameters also carry the bot deep-link payload.
  destination.hash = new URLSearchParams(sender ? { v: '2', contract, token: tokenId, key, sender } : { v: '1', contract, token: tokenId, key }).toString();
  return { tokenId, claimUrl: destination.href };
}

export function buttonFor({ claimUrl, botUsername, appShortname, chatType }) {
  const startapp = Buffer.from(new URL(claimUrl).hash.slice(1)).toString('base64url');
  if (startapp.length > 512) throw new Error('The claim link is too long for a Telegram start parameter.');
  const url = chatType === 'private' ? null : `https://t.me/${encodeURIComponent(botUsername)}/${encodeURIComponent(appShortname)}?startapp=${startapp}`;
  return { text: 'Open the red envelope', ...(url ? { url } : { web_app: { url: claimUrl } }) };
}

export function statusFromNote(note, blockHeight) {
  if (!note) return 'Note not found on Cachet testnet.';
  const sats = Number(note.utxo?.sats || 0);
  const txid = note.utxo?.txid || 'no funding transaction';
  let state = note.state;
  if (note.state === 'Sealed') {
    if (note.claim && blockHeight >= Number(note.claim.expires_at_block)) state = 'Expired';
    else if (!note.claim) state = 'Claimed';
  }
  return `${state} · ${sats.toLocaleString('en-US')} sats · BTC tx ${txid}`;
}

export async function nearView(method, args, fetchImpl = fetch) {
  const response = await fetchImpl(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cachet-telegram', method: 'query', params: {
      request_type: 'call_function', finality: 'final', account_id: DEFAULT_CONTRACT,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    } }),
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || 'NEAR RPC error');
  return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
}

export async function nearBlockHeight(fetchImpl = fetch) {
  const response = await fetchImpl(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cachet-telegram-height', method: 'block', params: { finality: 'final' } }),
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || 'NEAR RPC error');
  return body.result.header.height;
}

export function envelopeText({ sats, shares, giver }) {
  return `🧧 Bitcoin red envelope\n${sats.toLocaleString('en-US')} sats · ${(sats / 100_000_000).toFixed(8)} BTC\n${shares} ${shares === 1 ? 'share' : 'shares'}\nFrom ${giver}`;
}

// publicKeyOf turns the claim seed in a link into the public key the contract stores for the claim.
export async function liveEnvelopeNotes(entries, sats, shares, getNote, blockHeight, publicKeyOf = async (seed) => seed) {
  const candidates = await Promise.all(Object.entries(entries || {}).map(async ([tokenId, item]) => {
    if (item.used || !item.claimUrl) return null;
    let parsed;
    try {
      parsed = parseClaimUrl(item.claimUrl);
      if (parsed.tokenId !== tokenId) return null;
    } catch { return null; }
    const note = await getNote(tokenId);
    if (note?.token_id !== tokenId || note.owner_id == null || note.state !== 'Sealed' || !note.claim || Number(note.claim.expires_at_block) <= blockHeight) return null;
    const url = new URL(item.claimUrl.startsWith('http') ? item.claimUrl : `/claim#${item.claimUrl.replace(/^#/, '')}`, DEFAULT_WEB_URL);
    const key = (url.hash.match(/(?:^#|&)v=1(?:&|$)/) ? new URLSearchParams(url.hash.slice(1)) : url.searchParams).get('key');
    if (!key || (await publicKeyOf(key.toLowerCase())).toLowerCase() !== note.claim.key.toLowerCase()) return null;
    return { tokenId, item, sats: Number(note.utxo?.sats) };
  }));
  const valid = candidates.filter((candidate) => candidate && Number.isSafeInteger(candidate.sats) && candidate.sats > 0);
  const seen = new Set();
  const distinct = valid.filter(({ tokenId }) => !seen.has(tokenId) && seen.add(tokenId));
  const chosen = [];
  function find(start, sum) {
    if (chosen.length === shares) return sum === sats;
    for (let i = start; i <= distinct.length - (shares - chosen.length); i++) {
      chosen.push(distinct[i]);
      if (find(i + 1, sum + distinct[i].sats)) return true;
      chosen.pop();
    }
    return false;
  }
  return find(0, 0) ? chosen : [];
}
