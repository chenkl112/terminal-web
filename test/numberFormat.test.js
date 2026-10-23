import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTokenCount } from '../shared/numberFormat.js';

test('token counts use 万 then 亿 and carry rounded values across unit boundaries', () => {
  assert.equal(formatTokenCount(null), '—');
  assert.equal(formatTokenCount(9999), '9,999');
  assert.equal(formatTokenCount(10000), '1 万');
  assert.equal(formatTokenCount(29200000), '2920 万');
  assert.equal(formatTokenCount(292000000), '2.9 亿');
  assert.equal(formatTokenCount(99999999), '1 亿');
});
