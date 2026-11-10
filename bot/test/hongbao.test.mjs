import test from 'node:test';
import assert from 'node:assert/strict';
import { liveEnvelopeNotes, parseCommand } from '../lib.mjs';

const key = 'a'.repeat(64);
const claimUrl = (token, claimKey = key) => `v=1&contract=cachet.testnet&token=${token}&key=${claimKey}`;
const entry = (token, sats, options = {}) => ({
  claimUrl: claimUrl(options.linkToken || token, options.linkKey || key),
  sats,
  used: options.used || false,
});
const note = (token, sats, options = {}) => ({
  token_id: token,
  owner_id: 'alice.testnet',
  state: options.state || 'Sealed',
  utxo: { sats },
  claim: { key: options.key || key, expires_at_block: options.expiry || 200 },
});

test('envelope requires a total and positive share count', () => {
  assert.deepEqual(parseCommand('/envelope 300 2'), { command: 'envelope', sats: 300, shares: 2 });
  assert.deepEqual(parseCommand('/envelope 300'), { command: 'invalid' });
  assert.deepEqual(parseCommand('/envelope 300 0'), { command: 'invalid' });
});

test('selects distinct live sealed notes with an exact sum', async () => {
  const entries = { 1: entry('1', 100), 2: entry('2', 200), 3: entry('3', 250) };
  const notes = { 1: note('1', 100), 2: note('2', 200), 3: note('3', 250) };
  const selected = await liveEnvelopeNotes(entries, 350, 2, async (id) => notes[id], 100);
  assert.deepEqual(selected.map(({ tokenId }) => tokenId), ['1', '3']);
  assert.equal(selected.reduce((sum, item) => sum + item.sats, 0), 350);
  assert.equal(Object.values(entries).some((item) => item.used), false);
});

test('excludes duplicate, used, expired, non-sealed, and mismatched links without consuming them', async () => {
  const entries = {
    1: entry('1', 100),
    2: entry('2', 100, { used: true }),
    3: entry('3', 100),
    4: entry('4', 100),
    5: entry('5', 100, { linkToken: '1' }),
  };
  const notes = {
    1: note('1', 100),
    2: note('2', 100),
    3: note('3', 100, { expiry: 100 }),
    4: note('4', 100, { state: 'Unsealed' }),
    5: note('5', 100),
  };
  const selected = await liveEnvelopeNotes(entries, 100, 1, async (id) => notes[id], 100);
  assert.deepEqual(selected.map(({ tokenId }) => tokenId), ['1']);
  assert.equal((await liveEnvelopeNotes(entries, 200, 2, async (id) => notes[id], 100)).length, 0);
  assert.equal(Object.values(entries).some((item) => item.used && item !== entries[2]), false);
});

test('rejects a live claim URL whose key does not match the contract', async () => {
  const entries = { 1: entry('1') };
  const selected = await liveEnvelopeNotes(entries, 100, 1, async () => note('1', 100, { key: 'b'.repeat(64) }), 100);
  assert.deepEqual(selected, []);
  assert.equal(entries[1].used, false);
});
