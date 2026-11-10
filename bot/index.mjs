import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buttonFor, DEFAULT_WEB_URL, envelopeText, nearBlockHeight, nearView, parseClaimUrl, parseCommand, statusFromNote } from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const statePath = join(root, 'state', 'links.json');
const token = process.env.TELEGRAM_BOT_TOKEN;
const webUrl = process.env.CACHET_WEB_URL || DEFAULT_WEB_URL;
const appShortname = process.env.TELEGRAM_APP_SHORTNAME;
if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in the environment.');
if (!appShortname) throw new Error('Set TELEGRAM_APP_SHORTNAME to the configured Telegram Mini App short name.');
const api = `https://api.telegram.org/bot${token}`;

async function loadState() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
async function saveState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, statePath);
}
async function telegram(method, payload) {
  const response = await fetch(`${api}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed: ${result.description || response.status}`);
  return result.result;
}
const send = (chatId, text, replyMarkup) => telegram('sendMessage', { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });

async function handle(message) {
  if (!message?.text?.startsWith('/')) return;
  const parsed = parseCommand(message.text);
  if (!parsed) return;
  const chatId = message.chat.id;
  if (parsed.command === 'invalid') return send(chatId, 'Try /envelope <sats> [shares], /link <note id> <claim url>, or /status <note id>.');
  const state = await loadState();
  const giver = String(message.from.id);
  if (parsed.command === 'link') {
    const { tokenId, claimUrl } = parseClaimUrl(parsed.claimUrl, webUrl);
    if (parsed.tokenId !== tokenId) throw new Error('The note id in the URL must match the /link note id.');
    const note = await nearView('note', { token_id: tokenId });
    if (!note || note.state !== 'Sealed' || !note.claim) throw new Error('That note is not sealed with an active claim link.');
    const url = new URL(parsed.claimUrl);
    const params = new URLSearchParams(url.hash.slice(1));
    const seed = params.get('key');
    const privateDer = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]);
    const publicDer = createPublicKey(createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
    if (publicDer.subarray(-32).toString('hex') !== note.claim.key.toLowerCase()) throw new Error('Claim URL key does not match the live note claim.');
    const entries = state[giver] || {};
    entries[tokenId] = { claimUrl, sats: Number(note.utxo?.sats || 0), used: false };
    state[giver] = entries;
    await saveState(state);
    return send(chatId, `Linked sealed note ${tokenId} (${entries[tokenId].sats.toLocaleString('en-US')} sats) to your Telegram account.`);
  }
  if (parsed.command === 'status') {
    const [note, height] = await Promise.all([nearView('note', { token_id: parsed.tokenId }), nearBlockHeight()]);
    return send(chatId, statusFromNote(note, height));
  }
  const linked = Object.entries(state[giver] || {}).filter(([, item]) => !item.used && (!parsed.sats || item.sats === parsed.sats));
  if (!linked.length) return send(chatId, parsed.sats ? `No linked sealed note with ${parsed.sats.toLocaleString('en-US')} sats. Create and seal a note, then register it with /link <note id> <claim url>.` : 'No linked sealed note is ready. Create and seal a note, then register it with /link <note id> <claim url>.');
  const [tokenId, item] = linked[0];
  const claimUrl = parseClaimUrl(item.claimUrl, webUrl).claimUrl;
  const keyboard = buttonFor({ claimUrl, botUsername: botUsername, appShortname, chatType: message.chat.type });
  const text = envelopeText({ sats: item.sats, shares: parsed.shares || 1, giver: message.from.first_name || message.from.username || 'a friend' });
  await send(chatId, text, { inline_keyboard: [[keyboard]] });
  item.used = true;
  await saveState(state);
}

const me = await telegram('getMe', {});
const botUsername = me.username;
let offset = 0;
while (true) {
  try {
    const updates = await telegram('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
    for (const update of updates) {
      offset = update.update_id + 1;
      try { await handle(update.message); }
      catch (error) { console.error(`Update ${update.update_id} failed: ${error.message}`); await send(update.message.chat.id, `Could not complete that command: ${error.message}`); }
    }
  } catch (error) {
    console.error(`Telegram polling failed: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
