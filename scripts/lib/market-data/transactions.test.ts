import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateAddress } from './doorplates.ts';
import {
  isSaleTransactionDataRow,
  normalizeSaleTransaction,
  rocDateToIso,
  specialTransactionFlags,
  validateSaleTransactionHeaders,
} from './transactions.ts';
import type { DoorplateIndex } from './types.ts';

const index: DoorplateIndex = {
  schemaVersion: 1,
  datasetVersion: 'doorplates-fixture',
  byCanonicalAddress: {
    '台北市中正區測試路1段10號': [{
      canonicalAddress: '台北市中正區測試路1段10號',
      coordinate: { lat: 25.033964, lng: 121.564468 },
      district: '中正區',
      roadKey: '台北市中正區測試路1段',
      mainNumber: 10,
      subNumber: null,
    }],
  },
  byRoad: {},
  cells: {},
};

const context = { doorplates: index, sourceVersion: 'transactions-fixture' };

const BASE_ROW: Record<string, string> = {
  '交易標的': '房地(土地+建物)+車位',
  '土地位置建物門牌': '台北市中正區測試路1段10號',
  '交易年月日': '1150105',
  '移轉層次': '五層',
  '總樓層數': '十層',
  '建物型態': '華廈(10層含以下有電梯)',
  '建築完成年月': '1000101',
  '建物移轉總面積平方公尺': '100',
  '總價元': '30000000',
  '單價元平方公尺': '337500',
  '車位類別': '坡道平面',
  '車位移轉總面積平方公尺': '20',
  '車位總價元': '3000000',
  '備註': '',
  '編號': 'TX-001',
};

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ROW, ...overrides };
}

test('converts ROC dates and computes building-only unit price', () => {
  const tx = normalizeSaleTransaction(row({
    '交易年月日': '1150105',
    '建物移轉總面積平方公尺': '100',
    '總價元': '30000000',
    '車位移轉總面積平方公尺': '20',
    '車位總價元': '3000000',
  }), context);

  assert.equal(tx.kind, 'included');
  if (tx.kind !== 'included') return;
  assert.equal(tx.transaction.transactionDate, '2026-01-05');
  assert.ok(Math.abs(tx.transaction.buildingAreaPing - 24.2) < 0.1);
  assert.equal(tx.transaction.buildingPriceNtd, 27_000_000);
});

test('parking that cannot be fully separated is excluded', () => {
  const tx = normalizeSaleTransaction(row({
    '車位類別': '坡道平面',
    '車位移轉總面積平方公尺': '20',
    '車位總價元': '0',
  }), context);

  assert.equal(tx.kind, 'excluded');
  if (tx.kind !== 'excluded') return;
  assert.deepEqual(tx.reasons, ['parking-not-separable']);
});

test('treats conventional zero parking fields as no parking', () => {
  for (const parkingType of ['', '無車位']) {
    const tx = normalizeSaleTransaction(row({
      '交易標的': '房地(土地+建物)',
      '單價元平方公尺': '300000',
      '車位類別': parkingType,
      '車位移轉總面積平方公尺': '0',
      '車位總價元': '0',
    }), context);

    assert.equal(tx.kind, 'included', parkingType || 'empty parking type');
    if (tx.kind !== 'included') continue;
    assert.equal(tx.transaction.buildingPriceNtd, 30_000_000);
    assert.ok(Math.abs(tx.transaction.buildingAreaPing - 30.25) < 0.01);
    assert.equal(tx.transaction.parkingPriceNtd, 0);
    assert.equal(tx.transaction.parkingAreaPing, 0);
  }
});

test('rejects partial parking fields even when the other field is zero', () => {
  for (const partialParking of [
    { '車位類別': '坡道平面', '車位移轉總面積平方公尺': '20', '車位總價元': '0' },
    { '車位類別': '坡道平面', '車位移轉總面積平方公尺': '0', '車位總價元': '3000000' },
  ]) {
    const tx = normalizeSaleTransaction(row(partialParking), context);
    assert.equal(tx.kind, 'excluded');
    if (tx.kind !== 'excluded') continue;
    assert.deepEqual(tx.reasons, ['parking-not-separable']);
  }
});

test('explicit special relationship is excluded but ambiguous prose is reviewed', () => {
  assert.ok(specialTransactionFlags('親友、員工、共有人或其他特殊關係間之交易').includes('related-party'));
  assert.deepEqual(specialTransactionFlags('屋主誠意出售'), []);
});

test('rejects a derived price that conflicts with the official building unit price', () => {
  const tx = normalizeSaleTransaction(row({ '單價元平方公尺': '500000' }), context);

  assert.equal(tx.kind, 'excluded');
  if (tx.kind !== 'excluded') return;
  assert.deepEqual(tx.reasons, ['unit-price-conflict']);
});

test('does not classify marketing text as an official building type', () => {
  const tx = normalizeSaleTransaction(row({ '建物型態': '稀有電梯美宅' }), context);

  assert.equal(tx.kind, 'excluded');
  if (tx.kind !== 'excluded') return;
  assert.deepEqual(tx.reasons, ['unsupported-building-type']);
});

test('excludes explicit use-right transactions from automatic valuation', () => {
  const tx = normalizeSaleTransaction(row({ '備註': '地上權住宅' }), context);

  assert.equal(tx.kind, 'excluded');
  if (tx.kind !== 'excluded') return;
  assert.deepEqual(tx.reasons, ['non-freehold']);
});

test('rejects an invalid non-empty completion date instead of silently dropping it', () => {
  const tx = normalizeSaleTransaction(row({ '建築完成年月': '1000230' }), context);

  assert.equal(tx.kind, 'excluded');
  if (tx.kind !== 'excluded') return;
  assert.deepEqual(tx.reasons, ['invalid-completion-date']);
});

test('validates official schema before parsing a transaction row', () => {
  const { '總價元': _totalPrice, ...missingTotalPrice } = row();
  assert.throws(
    () => validateSaleTransactionHeaders(Object.keys(missingTotalPrice)),
    /總價元/,
  );
});

test('identifies the official explanatory row from non-data cells', () => {
  assert.equal(isSaleTransactionDataRow(row()), true);
  assert.equal(isSaleTransactionDataRow(row({ '交易年月日': '交易年月日', '總價元': '總價元' })), false);
  assert.equal(rocDateToIso('1150105'), '2026-01-05');
  assert.equal(rocDateToIso('1150230'), null);
});

test('uses the local doorplate evidence rather than a network geocoder', () => {
  const location = locateAddress(index, BASE_ROW['土地位置建物門牌']);
  assert.equal(location.method, 'exact-doorplate');
});
