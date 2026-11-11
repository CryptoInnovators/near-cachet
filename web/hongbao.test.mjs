import test from 'node:test';
import assert from 'node:assert/strict';
import hongbao from './hongbao.js';
import claim from './claim-lib.js';

test('satoshi split conserves the total and assigns remainder satoshis once', () => {
  assert.deepEqual(hongbao.splitSats(10003, 4), [2501, 2501, 2501, 2500]);
  assert.equal(hongbao.splitSats(10003, 4).reduce((sum, sats) => sum + sats, 0), 10003);
});

test('Telegram Mini App start parameter restores the matching v1 claim fragment', () => {
  const fragment = claim.buildFragment({ contract: 'cachet.testnet', token: '42', key: 'ab'.repeat(32) });
  assert.equal(claim.parseMiniAppStartParam(`https://near-cachet.example/claim?network=testnet#${fragment}`), fragment);
  assert.equal(claim.parseMiniAppStartParam('https://near-cachet.example/claim?network=testnet'), null);
});

test('satoshi split rejects unsafe, undersized and unsupported share counts', () => {
  for (const [total, count] of [[1, 2], [3, 4], [Number.MAX_SAFE_INTEGER + 1, 2], [100, 1], [100, 9]]) {
    assert.throws(() => hongbao.splitSats(total, count));
  }
});
