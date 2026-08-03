import assert from 'node:assert/strict';
import { test } from 'node:test';
import { officialComparableLocator } from './evidence.ts';
import type { MarketTransaction } from './types.ts';

const transaction: MarketTransaction = {
  id: 'official-locator-fixture',
  transactionDate: '2025-12-15',
  sourceVersion: 'synthetic-fixture',
  originalAddress: '台北市信義區測試路10號',
  location: {
    method: 'exact-doorplate',
    coordinate: { lat: 25.033, lng: 121.565 },
    normalizedAddress: '台北市信義區測試路10號',
    matchedAddress: '台北市信義區測試路10號',
    uncertaintyMeters: 0,
    confidence: 'high',
    datasetVersion: 'synthetic-fixture',
  },
  district: '信義區',
  ownership: 'freehold',
  buildingType: 'midrise',
  totalPriceNtd: 30_000_000,
  totalAreaPing: 30,
  buildingPriceNtd: 30_000_000,
  buildingAreaPing: 30,
  parkingPriceNtd: 0,
  parkingAreaPing: 0,
  buildingUnitPriceWan: 100,
  parkingEvidence: {
    grade: 'A',
    family: 'none',
    originalType: '無車位',
    officialPriceNtd: 0,
    officialAreaPing: 0,
    imputation: null,
    reasons: [],
  },
  floor: 5,
  totalFloors: 10,
  floorGroup: 'middle',
  completionDate: '2011-01-01',
  notes: '',
  exclusionFlags: [],
  eligibility: 'reliable-eligible',
  eligibilityReasons: [],
  originalPrimaryUse: '住家用',
  primaryUse: 'residential',
  transferredBuildingCount: 1,
};

test('builds an auditable official query locator without claiming a transaction deep link', () => {
  assert.deepEqual(officialComparableLocator(transaction), {
    queryUrl: 'https://lvr.land.moi.gov.tw/',
    district: '信義區',
    addressOrRoad: transaction.originalAddress,
    transactionMonth: '2025-12',
    floor: transaction.floor,
    totalPriceNtd: transaction.totalPriceNtd,
    totalAreaPing: transaction.totalAreaPing,
  });
});
