/**
 * Target-MRT region gate for the investment profile. The 35-station allowlist
 * is the human-described core of Taipei (see data/region-allowlist.md and
 * docs/profiles/investment.md). Membership is tested against the nearest
 * walking station the enrich step already picked.
 *
 * Precedence (mutually exclusive): unreliable walk -> review; else a station
 * outside the allowlist -> out-of-region (distance is irrelevant once outside);
 * else withinWalk decides in vs in-region-too-far.
 */
export type RegionGate = 'in' | 'out-of-region' | 'in-region-too-far' | 'review';

export const REGION_ALLOWLIST: ReadonlySet<string> = new Set([
  // 紅線（淡水信義線）石牌～象山，排除圓山
  '石牌', '明德', '芝山', '士林', '劍潭', '民權西路', '雙連', '中山',
  '台北車站', '台大醫院', '中正紀念堂', '東門', '大安森林公園', '大安',
  '信義安和', '象山',
  // 藍線（板南線）西門～永春
  '西門', '善導寺', '忠孝新生', '忠孝復興', '忠孝敦化', '國父紀念館',
  '市政府', '永春',
  // 綠線（松山新店線）台北小巨蛋～公館
  '台北小巨蛋', '南京復興', '松江南京', '北門', '小南門', '古亭', '台電大樓', '公館',
  // 橘線（中和新蘆線）台北市段獨有站
  '行天宮', '中山國小', '大橋頭',
]);

export function classifyRegion(
  stationZh: string | null,
  withinWalk: boolean | null,
): RegionGate {
  if (withinWalk === null) return 'review';
  if (!stationZh || !REGION_ALLOWLIST.has(stationZh)) return 'out-of-region';
  return withinWalk ? 'in' : 'in-region-too-far';
}
