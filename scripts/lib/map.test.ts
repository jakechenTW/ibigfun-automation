import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiItemToListing, o2oToRawHistory, onMarketToRows, offMarketToRows, mergeHistory } from './map.ts';
import { computeTenure } from './tenure.ts';
import type { ListItem, O2oForId, HistoryEntry, OffMarketEntry } from './api.ts';
import type { ListingHistoryEntry } from './types.ts';

const ITEM: ListItem = {
  id: 53199422,
  subject: '國語實小學區低總首購美寓',
  source: '樂屋',
  link: 'https://www.rakuya.com.tw/sell_item/info?ehid=051d9a345427898',
  address: '台北市中正區汀州路一段',
  mrt: '植物園站(施工中)',
  lat: 25.0271901,
  lng: 121.5108709,
  add_time: '2026-06-26 23:34:22',
  total: 1588,
  price_ave: 90.2,
  total_ping: 17.61,
  floor: 4,
  total_floor: 4,
  pattern: '3房2廳1衛',
  house_age_x: 49.4,
  parking_type: '無車位',
  room: 3,
  living_room: 2,
  bathroom: 1,
  id_encode: '2lrnjfzqiahur',
  uuid: 'A_1FF424',
};

const HISTORY: O2oForId = {
  '591': { source_id: '20167211', link: 'x', total: 1790, add_date: '2026-05-09' },
  '中信房屋': { source_id: '2036990', link: 'y', total: 1790, add_date: '2025-06-21' },
};

const MERGED: ListingHistoryEntry[] = [
  { date: '2026-05-09', source: '591', price: '1790', active: true },
  { date: '2025-06-21', source: '中信房屋', price: '1790', active: false },
];

test('apiItemToListing maps core fields from typed JSON', () => {
  const l = apiItemToListing(ITEM, []);
  assert.equal(l.title, '國語實小學區低總首購美寓');
  assert.equal(l.url, 'https://www.rakuya.com.tw/sell_item/info?ehid=051d9a345427898');
  assert.equal(l.addressOrArea, '台北市中正區汀州路一段');
  assert.equal(l.nearbyStation, '植物園站(施工中)');
  assert.deepEqual(l.coordinate, { lat: 25.0271901, lng: 121.5108709 });
  assert.equal(l.publishedDate, '2026-06-26'); // date only
  assert.equal(l.totalPrice, '1588');
  assert.equal(l.unitPrice, '90.2');
  assert.equal(l.totalPing, '17.61');
  assert.equal(l.floor, '4');
  assert.equal(l.totalFloors, '4');
  assert.equal(l.typeLayout, '3房2廳1衛');
  assert.equal(l.age, '49.4');
  assert.equal(l.parking, '無車位');
  assert.equal(l.realPriceUrl, null);
});

test('apiItemToListing fills the new structured fields', () => {
  const l = apiItemToListing(ITEM, []);
  assert.equal(l.id, 53199422);
  assert.equal(l.source, '樂屋');
  assert.equal(l.sourceLink, ITEM.link);
  assert.equal(l.room, 3);
  assert.equal(l.livingRoom, 2);
  assert.equal(l.bathroom, 1);
});

test('o2oToRawHistory turns each source into a raw history row', () => {
  const rows = o2oToRawHistory(HISTORY);
  assert.equal(rows.length, 2);
  const cic = rows.find((r) => r.source === '中信房屋');
  assert.deepEqual(cic, { price: '1790', source: '中信房屋', date: '2025-06-21', active: true });
});

test('listingHistory feeds tenure: earliest record is first listed', () => {
  const l = apiItemToListing(ITEM, MERGED);
  assert.equal(l.listingHistory.length, 2);
  const t = computeTenure(l.listingHistory, '2026-06-26');
  assert.equal(t.firstListedDate, '2025-06-21');
  assert.equal(t.sourceCount, 2);
});

test('empty history maps to an empty listingHistory array', () => {
  assert.deepEqual(apiItemToListing(ITEM, []).listingHistory, []);
});

test('apiItemToListing coerces a numeric source to a string', () => {
  const l = apiItemToListing({ ...ITEM, source: 591 as unknown as string }, []);
  assert.equal(l.source, '591');
  assert.equal(typeof l.source, 'string');
});

const ON: HistoryEntry[] = [
  { source: '樂屋網', source_id: 'a', total: 1688, subject: 's', add_time: '2026-06-27', link: 'x' },
];
const OFF: OffMarketEntry[] = [
  { source: '住商', source_id: 'b', total: '1,234', subject: 's', add_time: '2025-12-01', link: 'y' },
];

test('onMarketToRows maps numeric total to a string price, active:true', () => {
  assert.deepEqual(onMarketToRows(ON), [
    { price: '1688', source: '樂屋網', date: '2026-06-27', active: true },
  ]);
});

test('offMarketToRows keeps the comma-string total, active:false', () => {
  assert.deepEqual(offMarketToRows(OFF), [
    { price: '1,234', source: '住商', date: '2025-12-01', active: false },
  ]);
});

test('mergeHistory normalizes on+off and keeps same source/date when active differs', () => {
  const on = onMarketToRows([{ source: 'A', source_id: '1', total: 100, subject: '', add_time: '2026-01-01', link: '' }]);
  const off = offMarketToRows([{ source: 'A', source_id: '1', total: '100', subject: '', add_time: '2026-01-01', link: '' }]);
  assert.equal(mergeHistory(on, off).length, 2); // active true vs false -> distinct
});

test('mergeHistory dedupes identical rows', () => {
  assert.equal(mergeHistory(onMarketToRows(ON), onMarketToRows(ON)).length, 1);
});

test('mergeHistory of empty inputs is empty', () => {
  assert.deepEqual(mergeHistory([], []), []);
});
