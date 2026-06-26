import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAuctionKeyword } from './exclude.ts';

test('detects auction/special-disposition keywords', () => {
  assert.equal(hasAuctionKeyword('法拍屋整層'), true);
  assert.equal(hasAuctionKeyword('應買案件'), true);
  assert.equal(hasAuctionKeyword('🐳鯨魚法拍🐳內湖大土地持'), true);
});

test('ordinary titles are not flagged', () => {
  assert.equal(hasAuctionKeyword('溫馨美寓近公園'), false);
  assert.equal(hasAuctionKeyword('松山捷運五分埔面公園'), false);
});
