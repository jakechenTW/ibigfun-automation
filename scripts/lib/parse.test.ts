import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWan, parsePing, parseUnitPrice, parseNumber, wanToNtd } from './parse.ts';

test('parses prices, ping, and unit price out of display strings', () => {
  assert.equal(parseWan('1588萬'), 1588);
  assert.equal(parseWan('2,380萬'), 2380);
  assert.equal(parsePing('17.61坪'), 17.61);
  assert.equal(parseUnitPrice('90.2萬/坪'), 90.2);
  assert.equal(parseNumber('49.4'), 49.4);
});

test('returns null for non-numeric or empty input', () => {
  assert.equal(parseNumber('無車位'), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(''), null);
});

test('wanToNtd multiplies by 10,000', () => {
  assert.equal(wanToNtd(1588), 15880000);
  assert.equal(wanToNtd(null), null);
});
