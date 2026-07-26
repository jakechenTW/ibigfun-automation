import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractTaipeiSalesCsv,
  moiSeasonUrl,
  quartersForLookback,
  resolveTaipeiDoorplateSource,
} from './sources.ts';

// Synthetic parser input: intentionally not a saved or downloaded source page.
const detailFixture = `<!doctype html><body>
  <a href="https://data.taipei/api/dataset/resource.download?rid=doorplate-202607">doorplates.csv</a>
  <time datetime="2026-07-02T09:47:33+08:00">2026-07-02 09:47:33</time>
</body>`;

test('36-month lookback enumerates every intersecting ROC quarter', () => {
  assert.deepEqual(quartersForLookback('2026-07-25', 36), [
    '112S3', '112S4', '113S1', '113S2', '113S3', '113S4',
    '114S1', '114S2', '114S3', '114S4', '115S1', '115S2', '115S3',
  ]);
});

test('MOI season URL uses official CSV ZIP shape', () => {
  assert.equal(
    moiSeasonUrl('115S3'),
    'https://plvr.land.moi.gov.tw/DownloadSeason?season=115S3&type=zip&fileName=lvr_landcsv.zip',
  );
});

test('doorplate detail parser resolves exactly one CSV resource', () => {
  const source = resolveTaipeiDoorplateSource(detailFixture);
  assert.match(source.url, /resource\.download\?rid=/);
  assert.equal(source.publishedAt, '2026-07-02T09:47:33+08:00');
});

test('doorplate source parser rejects missing or ambiguous CSV resources', () => {
  assert.throws(() => resolveTaipeiDoorplateSource('<html></html>'), /exactly one/i);
  assert.throws(
    () => resolveTaipeiDoorplateSource(detailFixture.replace('</body>', '<a href="/resource.download?rid=second">second.csv</a></body>')),
    /exactly one/i,
  );
});

test('ZIP extraction accepts only Taipei sale CSV and rejects traversal entries', async () => {
  const csv = await extractTaipeiSalesCsv([
    { path: 'a_lvr_land_a.csv', buffer: Buffer.from('交易年月日\n1150105\n') },
    { path: 'b_lvr_land_a.csv', buffer: Buffer.from('ignored') },
  ]);
  assert.equal(csv.toString('utf8'), '交易年月日\n1150105\n');

  await assert.rejects(
    () => extractTaipeiSalesCsv([{ path: '../a_lvr_land_a.csv', buffer: Buffer.from('bad') }]),
    /unsafe ZIP entry/i,
  );
  await assert.rejects(
    () => extractTaipeiSalesCsv([{ path: '/a_lvr_land_a.csv', buffer: Buffer.from('bad') }]),
    /unsafe ZIP entry/i,
  );
});
