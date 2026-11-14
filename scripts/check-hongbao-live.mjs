import assert from 'node:assert/strict';
import { DEFAULT_WEB_URL } from '../bot/lib.mjs';

const id = '4';
const rpcs = ['https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org', 'https://archival-rpc.testnet.fastnear.com'];
const request = async (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
const rpcCall = async (options) => {
  let last;
  for (let round = 0; round < 4; round += 1) {
    for (const url of rpcs) {
      try { last = await request(url, options); if (last.status === 200) return last; } catch (error) { last = { status: String(error) }; }
    }
    await new Promise((done) => setTimeout(done, 1500 * (round + 1)));
  }
  return last;
};

const read = await rpcCall({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'hongbao-live-check', method: 'query', params: {
    request_type: 'call_function', finality: 'final', account_id: 'heir.cachet-ops.testnet', method_name: 'note',
    args_base64: Buffer.from(JSON.stringify({ token_id: id })).toString('base64'),
  } }),
});
assert.equal(read.status, 200, 'NEAR testnet RPC answers');
const rpcBody = await read.json();
assert.equal(rpcBody.error, undefined, 'NEAR testnet note view succeeds');
const note = JSON.parse(Buffer.from(rpcBody.result.result).toString('utf8'));
assert.equal(note?.token_id, id, 'note 4 exists on testnet');
assert.equal(note.state, 'Sealed', 'note 4 is Sealed');
assert.ok(Number.isSafeInteger(note.utxo?.sats) && note.utxo.sats > 0, 'live note has a positive satoshi amount');

const crawler = await request(`${DEFAULT_WEB_URL}/e/${id}`, { headers: { 'user-agent': 'TelegramBot (like TwitterBot)' } });
assert.equal(crawler.status, 200, 'crawler route returns metadata HTML');
const metadata = await crawler.text();
const amount = Number(note.utxo.sats).toLocaleString('en-US');
assert.ok(metadata.includes(`<title>Sealed Bitcoin red envelope #${id}</title>`), 'title names the live Sealed note');
assert.ok(metadata.includes(`content="${amount} sats · Sealed"`), 'metadata shows the live satoshi amount and Sealed state');
assert.ok(metadata.includes(`content="${DEFAULT_WEB_URL}/e/${id}"`), 'metadata canonical URL matches the share route');
assert.ok(metadata.includes(`content="${DEFAULT_WEB_URL}/og/${id}.svg"`), 'metadata points at its live note image');
assert.ok(metadata.includes(`/claim?network=testnet&amp;note=${id}`), 'metadata claim destination identifies the same testnet note');

const browser = await request(`${DEFAULT_WEB_URL}/e/${id}`, { redirect: 'manual' });
assert.equal(browser.status, 302, 'browser route redirects to the claim');
const destination = new URL(browser.headers.get('location'), DEFAULT_WEB_URL);
assert.equal(destination.pathname, '/claim', 'browser lands on the claim route');
assert.equal(destination.searchParams.get('network'), 'testnet', 'claim route stays on testnet');
assert.equal(destination.searchParams.get('note'), id, 'claim route names note 4');

const entry = await request(`${DEFAULT_WEB_URL}/hongbao`, { redirect: 'manual' });
assert.equal(entry.status, 200, 'Hongbao route serves the sender Mini App page');
const html = await entry.text();
assert.ok(html.includes('<title>Cachet: send a Bitcoin red envelope</title>'), 'sender route returns the Hongbao page');
assert.ok(html.includes('id="hongbao-form"'), 'sender route contains the note creation form');
assert.ok(html.includes('https://telegram.org/js/telegram-web-app.js'), 'sender page loads the Telegram Mini App SDK');
const app = await request(`${DEFAULT_WEB_URL}/hongbao.js`);
assert.equal(app.status, 200, 'sender application module is served');
const source = await app.text();
assert.ok(source.includes('WebApp?.ready()'), 'sender announces readiness to Telegram');
assert.ok(source.includes('t.me/share/url'), 'sender exposes Telegram share action');

console.log(`PASS: live note ${id}, ${amount} sats, Sealed; crawler metadata, claim route, and Telegram Mini App entry verified.`);
