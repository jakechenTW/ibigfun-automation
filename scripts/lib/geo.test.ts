import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from './geo.ts';

test('zero distance for the same point', () => {
  assert.equal(haversineMeters({ lat: 25, lng: 121 }, { lat: 25, lng: 121 }), 0);
});

test('one degree of latitude is ~111.2 km', () => {
  const d = haversineMeters({ lat: 25, lng: 121 }, { lat: 26, lng: 121 });
  assert.ok(Math.abs(d - 111195) < 600, `got ${d}`);
});

test('short distance is in a sane range', () => {
  // ~110 m apart in latitude (0.001 deg).
  const d = haversineMeters({ lat: 25.03, lng: 121.56 }, { lat: 25.031, lng: 121.56 });
  assert.ok(d > 100 && d < 120, `got ${d}`);
});
