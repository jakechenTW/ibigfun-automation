import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapsCoordinate } from './coords.ts';

test('parses q= query coordinate', () => {
  const c = parseMapsCoordinate('https://www.google.com/maps?q=25.0330,121.5654');
  assert.deepEqual(c, { lat: 25.033, lng: 121.5654 });
});

test('parses @lat,lng path coordinate', () => {
  const c = parseMapsCoordinate('https://www.google.com/maps/place/X/@25.0418,121.5320,17z');
  assert.deepEqual(c, { lat: 25.0418, lng: 121.532 });
});

test('parses !3d!4d data coordinate', () => {
  const c = parseMapsCoordinate('https://www.google.com/maps/...!3d25.0123!4d121.4567');
  assert.deepEqual(c, { lat: 25.0123, lng: 121.4567 });
});

test('returns null for non-map or coordinate-less urls', () => {
  assert.equal(parseMapsCoordinate('https://example.com/listing/123'), null);
  assert.equal(parseMapsCoordinate(''), null);
  assert.equal(parseMapsCoordinate(null), null);
});

test('rejects out-of-range coordinates', () => {
  assert.equal(parseMapsCoordinate('https://maps.google.com/?q=999,999'), null);
});
