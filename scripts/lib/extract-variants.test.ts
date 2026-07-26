import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchVariants, mergeVariantListings } from './extract.ts';
import type { FetchMap } from './api.ts';
import type { Listing } from './types.ts';

function listing(over: Pick<Listing, 'id' | 'queryHouseType' | 'buildingType'>): Listing {
  return {
    title: 'listing', url: null, addressOrArea: null, nearbyStation: null, coordinate: null,
    publishedDate: null, totalPrice: null, totalPing: null, unitPrice: null, floor: null,
    totalFloors: null, typeLayout: null, age: null, parking: null, realPriceUrl: null,
    listingHistory: [], source: null, sourceLink: null, room: null, livingRoom: null,
    bathroom: null, ...over,
  };
}

test('house_type array becomes separate typed fetches', () => {
  assert.deepEqual(fetchVariants({ city: '1', house_type: ['16', '17'] } as FetchMap), [
    { filters: { city: '1', house_type: ['16'] }, queryHouseType: '16' },
    { filters: { city: '1', house_type: ['17'] }, queryHouseType: '17' },
  ]);
});

test('cross-variant duplicate ids are counted and conflicting provenance becomes untyped', () => {
  const events: string[] = [];
  const result = mergeVariantListings([
    { queryHouseType: '16', listings: [listing({ id: 7, queryHouseType: '16', buildingType: 'apartment' })] },
    { queryHouseType: '17', listings: [listing({ id: 7, queryHouseType: '17', buildingType: 'midrise' })] },
  ], { event: (_level: string, event: string) => events.push(event) } as any);
  assert.equal(result.listings[0].queryHouseType, null);
  assert.equal(result.listings[0].buildingType, null);
  assert.equal(result.provenanceConflicts, 1);
  assert.ok(events.includes('fetch.provenance-conflict'));
});
