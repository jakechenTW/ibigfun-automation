const GOOGLE_MAP_COORDINATE_LINK = /\[地圖\]\(https:\/\/www\.google\.com\/maps\?q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\)/;

function validateConciseBody(lines: string[]): void {
  for (const [index, line] of lines.entries()) {
    // Property titles and listing URLs are source content, not report diagnostics.
    if (/^#{1,6}\s/.test(line.trim())) continue;
    if (/P25\s*[-–]\s*P75|\d+\s*筆\s*(?:行情可靠|review\b|unavailable\b)|官方行情.*\b(?:review|unavailable|high|medium|low)\b|https?:\/\/[^\s/]*valhalla[^\s]*|\d+\s*筆試行完成/i.test(line)) {
      throw new Error(`technical diagnostics on line ${index + 1}: use a concise limitation and keep technical evidence local`);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (!/^###\s+(?:推薦物件|符合條件|候選／資料待確認|(?:⚠️\s*)?風險物件／待查)\s*$/.test(lines[i].trim())) continue;
    let end = i + 1;
    while (end < lines.length && !/^#{1,3}\s/.test(lines[end].trim())) end++;
    const section = lines.slice(i + 1, end);
    const propertyStarts = section.flatMap((line, index) => /^####\s/.test(line.trim()) ? [index] : []);
    if (propertyStarts.length === 0) throw new Error('empty result section: omit its heading and no-result text');
    for (const [position, start] of propertyStarts.entries()) {
      const property = section.slice(start + 1, propertyStarts[position + 1] ?? section.length);
      const first = property.find((line) => line.trim())?.trim() ?? '';
      const reason = first.match(/^- (?:推薦|符合|下一步|風險)：(.+)$/)?.[1]?.trim();
      if (!reason || /^(?:區域[、，].*條件通過[。！]?|確認(?:低信心行情|官方行情|屋況|資料)(?:與屋況)?[。！]?|請自行確認[。！]?)$/.test(reason)) {
        throw new Error('listing reason or action: start each property with a specific reason, blocker, or next action');
      }
    }
  }
}

/** Bind the report totals to the input and reject overlapping exclusion counts. */
export function validateNotificationCounts(report: string, expectedCount: number): void {
  const lines = report.split(/\r?\n/).map((line) => line.trim().replace(/^\*\*(.*)\*\*$/, '$1'));
  const summaries = lines.filter((line) => /^本次取得.*[｜|]/.test(line));
  const summary = summaries[0]?.match(/^本次取得 (\d+)｜(?:推薦|符合) (\d+)｜候選 (\d+)｜風險 (\d+)｜排除 (\d+)$/);
  if (summaries.length !== 1 || !summary) {
    throw new Error('report requires one count line: 本次取得 N｜推薦 N｜候選 N｜風險 N｜排除 N (use 符合 for self-use)');
  }
  const counts = summary.slice(1).map(Number);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 ||
      counts.some((count) => !Number.isSafeInteger(count) || count > expectedCount)) {
    throw new Error('report counts must be safe non-negative integers within the enriched listing count');
  }
  const [fetched, positive, candidates, risks, excluded] = counts;
  if (fetched !== expectedCount || positive + candidates + risks + excluded !== fetched) {
    throw new Error('report bucket counts must sum to 本次取得 and match the enriched listing count');
  }

  const sections = lines.flatMap((line, index) => line === '### 排除摘要' ? [index] : []);
  if (sections.length !== (excluded > 0 ? 1 : 0)) {
    throw new Error('report requires one exclusion summary only when the excluded count is positive');
  }
  if (!excluded) return;
  const reasons = new Set<string>();
  let reasonTotal = 0;
  for (const line of lines.slice(sections[0] + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line || line.startsWith('- 主要原因：')) continue;
    const reason = line.match(/^- (目標捷運站外|站內走路過遠|刊登超過上限|自住硬性條件不符|其他硬性排除)：(\d+) 筆$/);
    if (!reason || reasons.has(reason[1])) {
      throw new Error('exclusion summary requires unique primary-reason rows: - <reason>：N 筆');
    }
    const count = Number(reason[2]);
    if (!Number.isSafeInteger(count) || count <= 0 || count > excluded) {
      throw new Error('exclusion reason counts must be positive integers within the excluded count');
    }
    reasons.add(reason[1]);
    reasonTotal += count;
  }
  if (reasonTotal !== excluded) {
    throw new Error('primary exclusion reason counts must sum to the excluded count without overlap');
  }
}

/** Validate the user-facing Markdown body before it is handed to ai-notify. */
export function validateNotificationReport(report: string): void {
  const lines = report.split(/\r?\n/);
  const firstContentLine = lines.find((line) => line.trim().length > 0)?.trim();
  if (!firstContentLine) throw new Error('report body must not be empty');
  if (/^#{1,6}\s/.test(firstContentLine)) {
    throw new Error('report body must start with the conclusion; --title owns the notification title');
  }

  validateConciseBody(lines);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!/^(?:-\s+)?🚶/.test(trimmed) || trimmed.replace(/^-\s+/, '') === '🚶 無位置資訊') continue;
    if (!GOOGLE_MAP_COORDINATE_LINK.test(trimmed)) {
      throw new Error(`walking line ${index + 1} must include a clickable Google Maps coordinate link`);
    }
    if (/ORS|Valhalla/i.test(trimmed) || !/🚶 (?:步行約 \d+ 分鐘｜[^｜]+｜|步行時間待確認｜)/.test(trimmed)) {
      throw new Error(`walking line ${index + 1} must use plain-language walking time`);
    }
  }
}
