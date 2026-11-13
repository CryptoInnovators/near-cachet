import test from 'node:test';
import assert from 'node:assert/strict';
import { buttonFor, envelopeText, nearBlockHeight, nearView, parseClaimUrl, parseCommand, statusFromNote } from '../lib.mjs';

test('parses the supported commands and rejects invalid amounts', () => {
  assert.deepEqual(parseCommand('/hongbao 50000 4'), { command: 'envelope', sats: 50000, shares: 4 });
  assert.deepEqual(parseCommand('/envelope'), { command: 'invalid' });
  assert.deepEqual(parseCommand('/envelope 0'), { command: 'invalid' });
  assert.deepEqual(parseCommand('/status@cachetbot 2'), { command: 'status', tokenId: '2' });
});

test('builds private Mini App and group deep-link buttons', () => {
  const input = { claimUrl: 'https://example.test/claim', botUsername: 'cachetbot', appShortname: 'claim', chatType: 'private' };
  assert.deepEqual(buttonFor(input), { text: 'Open the red envelope', web_app: { url: input.claimUrl } });
  assert.match(buttonFor({ ...input, chatType: 'group' }).url, /^https:\/\/t\.me\/cachetbot\/claim\?startapp=/);
});

test('group start param is Telegram-safe and decodes to the claim fragment', async () => {
  const fragment = 'v=2&contract=heir.cachet-ops.testnet&token=3&key=' + 'ab'.repeat(32) + '&sender=cachet-ops.testnet';
  const { url } = buttonFor({ claimUrl: `https://example.test/claim#${fragment}`, botUsername: 'cachetbot', appShortname: 'claim', chatType: 'group' });
  const startapp = new URL(url).searchParams.get('startapp');
  assert.match(startapp, /^[A-Za-z0-9_-]{1,512}$/);
  const { createRequire } = await import('node:module');
  const claimLib = createRequire(import.meta.url)('../../web/claim-lib.js');
  assert.equal(claimLib.parseMiniAppStartParam(startapp), fragment);
});

test('preserves existing claim fragments and formats live note status', () => {
  const fragment = 'v=1&contract=heir.cachet-ops.testnet&token=2&key=' + 'a'.repeat(64);
  const parsed = parseClaimUrl(fragment);
  assert.equal(parsed.tokenId, '2');
  assert.match(parsed.claimUrl, /\?note=2&key=/);
  assert.match(parsed.claimUrl, /#v=1&contract=heir\.cachet-ops\.testnet&token=2&key=/);
  assert.match(envelopeText({ sats: 50000, shares: 2, giver: 'Lin' }), /0\.00050000 BTC[\s\S]*2 shares[\s\S]*Lin/);
  assert.match(statusFromNote({ state: 'Sealed', utxo: { sats: 50000, txid: 'abc' }, claim: { expires_at_block: 200 } }, 201), /^Expired/);
  assert.match(statusFromNote({ state: 'Sealed', utxo: { sats: 50000, txid: 'abc' }, claim: null }, 201), /^Claimed/);
});

test('reads existing note 1 from real NEAR testnet RPC', async () => {
  const [note, height] = await Promise.all([nearView('note', { token_id: '1' }), nearBlockHeight()]);
  assert.ok(note && note.token_id === '1', 'note 1 must exist on Cachet testnet');
  assert.ok(['Minted', 'Attesting', 'Sealed', 'Unsealing', 'Unsealed', 'Resigning', 'Finalizing'].includes(note.state));
  assert.ok(Number.isSafeInteger(height) && height > 0, 'final NEAR block height must be live');
  if (note.state === 'Sealed') assert.ok(Number(note.utxo?.sats) > 0 && note.utxo?.txid, 'sealed note must expose real Bitcoin funding');
});
