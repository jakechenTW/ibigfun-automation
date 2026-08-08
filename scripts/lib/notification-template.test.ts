import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const investment = readFileSync(
  new URL('../../profiles/example-investment/notify-template.md', import.meta.url),
  'utf8',
);
const owner = readFileSync(
  new URL('../../profiles/example-owner-occupied/notify-template.md', import.meta.url),
  'utf8',
);
const sharedRules = readFileSync(
  new URL('../../docs/reporting-rules.md', import.meta.url),
  'utf8',
);
const investmentRules = readFileSync(
  new URL('../../profiles/example-investment/evaluation.md', import.meta.url),
  'utf8',
);
const ownerRules = readFileSync(
  new URL('../../profiles/example-owner-occupied/evaluation.md', import.meta.url),
  'utf8',
);
const agentsInstructions = readFileSync(
  new URL('../../AGENTS.md', import.meta.url),
  'utf8',
);
const notificationRules = readFileSync(
  new URL('../../docs/notifications.md', import.meta.url),
  'utf8',
);
const workerPrompt = readFileSync(
  new URL('../../prompts/daily-run.md', import.meta.url),
  'utf8',
);

function occurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

function bucketBody(template: string, bucket: string): string {
  const match = template.match(new RegExp(`\\{\\{#each ${bucket}\\}\\}([\\s\\S]*?)\\{\\{\\/each\\}\\}`));
  assert.ok(match, `missing action-bucket loop for ${bucket}`);
  return match[1];
}

function assertCommonContract(template: string, buckets: string[]): void {
  assert.match(template, /^\{\{conclusion\}\}/);
  assert.doesNotMatch(template, /\{\{status_icon\}\}|\{\{date\}\}|\{\{headline\}\}/);
  assert.match(template, /\{\{data_warning\}\}/);
  for (const bucket of buckets) {
    const body = bucketBody(template, bucket);
    for (const placeholder of [
      'rank',
      'title',
      'url',
      'price',
      'ping',
      'unit_price',
      'floor',
      'total_floor',
      'age',
      'address_or_area',
      'walk_line',
      'tenure_line',
      'market_summary_line',
    ]) {
      assert.match(body, new RegExp(`\\{\\{${placeholder}\\}\\}`), `${bucket} missing ${placeholder}`);
    }
    assert.match(body, /\{\{#if valuation_review_line\}\}[\s\S]*\{\{valuation_review_line\}\}[\s\S]*\{\{\/if\}\}/);
  }
  assert.equal(occurrences(template, '{{walk_line}}'), buckets.length);
  assert.equal(occurrences(template, '{{tenure_line}}'), buckets.length);
  assert.equal(occurrences(template, '{{market_summary_line}}'), buckets.length);
  assert.match(template, /\{\{unit_price\}\} 萬\/坪/);
  assert.match(template, /### 排除摘要/);
  assert.doesNotMatch(template, /\{\{#each excluded\}\}/);
  assert.doesNotMatch(
    template,
    /monthly_mortgage|estimated_rent|monthly_cash_flow|房貸|月租|現金流|租金覆蓋率|market_p25_wan|market_p75_wan|selected_stage|market_confidence|official_source_date|ORS|cache|enrich/i,
  );
}

function assertConditionalExclusionRows(template: string, counts: string[]): void {
  for (const count of counts) {
    assert.match(
      template,
      new RegExp(`\\{\\{#if ${count}\\}\\}\\s*\\n- [^\\n]*\\{\\{${count}\\}\\} 筆\\s*\\n\\{\\{\\/if\\}\\}`),
      `${count} exclusion row must be conditional`,
    );
  }
  assert.match(
    template,
    /\{\{#if main_exclusion_reasons\}\}\s*\n- 主要原因：\{\{main_exclusion_reasons\}\}\s*\n\{\{\/if\}\}/,
  );
}

test('investment notification template is concise and decision-first', () => {
  assertCommonContract(investment, ['recommended', 'candidates', 'suspicious']);
  assert.match(investment, /### 推薦物件/);
  assert.match(investment, /### 候選／資料待確認/);
  assert.match(investment, /### ⚠️ 風險物件／待查/);
  assert.match(bucketBody(investment, 'recommended'), /\{\{recommendation_reason\}\}/);
  assert.match(bucketBody(investment, 'recommended'), /\{\{risks_or_manual_checks\}\}/);
  assert.match(bucketBody(investment, 'candidates'), /\{\{manual_checks\}\}/);
  assert.match(bucketBody(investment, 'suspicious'), /\{\{suspicious_reason\}\}/);
  assert.match(bucketBody(investment, 'suspicious'), /\{\{suspicious_label\}\}/);
  assert.match(bucketBody(investment, 'suspicious'), /\{\{suspicious_confidence\}\}/);
  assert.match(bucketBody(investment, 'suspicious'), /\{\{detail_page_checked\}\}/);
  assertConditionalExclusionRows(investment, [
    'out_of_region_count',
    'in_region_too_far_count',
    'tenure_expired_count',
    'other_hard_exclusion_count',
  ]);
  assert.match(investment, /目標捷運站外.*out_of_region_count/s);
  assert.match(investment, /站內走路過遠.*in_region_too_far_count/s);
  assert.doesNotMatch(investment, /開價溢價|保守行情|p\*/i);
});

test('owner-occupied notification template keeps self-use decision fields', () => {
  const buckets = ['matched', 'candidates', 'risks'];
  assertCommonContract(owner, buckets);
  assert.match(owner, /### 符合條件/);
  assert.match(owner, /### 候選／資料待確認/);
  assert.match(owner, /### ⚠️ 風險物件／待查/);
  for (const bucket of buckets) {
    const body = bucketBody(owner, bucket);
    for (const placeholder of ['room', 'living_room', 'bathroom', 'parking', 'type_layout']) {
      assert.match(body, new RegExp(`\\{\\{${placeholder}\\}\\}`), `${bucket} missing ${placeholder}`);
    }
  }
  assert.match(bucketBody(owner, 'matched'), /\{\{strengths\}\}/);
  assert.match(bucketBody(owner, 'matched'), /\{\{manual_checks\}\}/);
  assert.match(bucketBody(owner, 'candidates'), /\{\{manual_checks\}\}/);
  assert.match(bucketBody(owner, 'risks'), /\{\{risk_reason\}\}/);
  assert.match(bucketBody(owner, 'risks'), /\{\{risk_label\}\}/);
  assert.match(bucketBody(owner, 'risks'), /\{\{risk_confidence\}\}/);
  assert.match(bucketBody(owner, 'risks'), /\{\{detail_page_checked\}\}/);
  assertConditionalExclusionRows(owner, [
    'tenure_expired_count',
    'hard_criteria_excluded_count',
    'other_hard_exclusion_count',
  ]);
  assert.match(owner, /格局 \{\{room\}\}房\{\{living_room\}\}廳\{\{bathroom\}\}衛/);
  assert.match(owner, /車位 \{\{parking\}\}/);
  assert.match(owner, /類型 \{\{type_layout\}\}/);
});

test('active report instructions retain full evidence locally and render only concise fields', () => {
  const activeInstructions = [sharedRules, investmentRules, ownerRules, workerPrompt].join('\n');
  assert.doesNotMatch(activeInstructions, /行情一律先讀[^。]*：顯示 reliable\/review\/unavailable/);
  assert.doesNotMatch(activeInstructions, /快速摘要(?:必須|須)[^。]*(?:資料偏舊|稽核計數)/);
  assert.doesNotMatch(activeInstructions, /Keep the official source date\/freshness[^.]*visible/i);
  assert.doesNotMatch(activeInstructions, /report\.md[^。\n]*(?:顯示|輸出)[^。\n]*(?:P25[–-]P75|選用階段|資料日期)/i);
  assert.match(workerPrompt, /market_summary_line/);
  assert.match(workerPrompt, /完整[^。\n]*(?:本地|本機|local)[^。\n]*(?:evidence|證據)/i);
  assert.match(sharedRules, /Do not print raw status syntax, P25-P75, internal stage, raw confidence enum, source-check date/i);
  assert.match(sharedRules, /Do not show mortgage, rent, cash flow[^.]*\./i);
  assert.match(workerPrompt, /`--title`[^。\n]*唯一[^。\n]*標題/);
  assert.match(workerPrompt, /有座標[^。\n]*\[地圖\]\(https:\/\/www\.google\.com\/maps\?q=<lat>,<lng>\)/);
});

test('shared rules preserve known tenure without inventing an unknown price trend', () => {
  assert.match(sharedRules, /daysOnMarket === 0[^\n]*`🕒 今日上架`/);
  assert.match(sharedRules, /known positive days[^\n]*unknown price trend[^\n]*`🕒 已刊登 \{daysOnMarket\} 天`/i);
  assert.match(sharedRules, /only unknown days[^\n]*`🕒 刊登天數待確認`/i);
  assert.match(sharedRules, /never invent a price-history value/i);
});

test('region exclusions, anomalies, and stale evidence use the concise summary contract', () => {
  assert.match(sharedRules, /Region Gate[\s\S]*排除摘要/);
  assert.match(sharedRules, /進入評估[\s\S]{0,100}?0[\s\S]{0,100}?data_warning/);
  assert.match(sharedRules, /(?:stale|過期|偏舊)[^\n]*data_warning[^\n]*market_summary_line/i);
  assert.match(investmentRules, /區域閘門[\s\S]*排除摘要/);
  assert.match(investmentRules, /進入評估[\s\S]{0,100}?0[\s\S]{0,100}?data_warning/);
});

test('active notification policy separates result presence from warning conditions', () => {
  const statusRules = [agentsInstructions, notificationRules, ownerRules, workerPrompt].join('\n');
  assert.match(statusRules, /recommendations? or matches? may use `ok`/i);
  assert.match(statusRules, /candidate[^\n]*risk[^\n]*manual[^\n]*stale/i);
  assert.match(statusRules, /hard exclusion[^\n]*(?:does not|doesn't)[^\n]*(?:force|require) `warn`/i);
  assert.doesNotMatch(statusRules, /`warn`[^\n]*(?:recommendations?\/matches?|有推薦\/符合條件)/i);
});
