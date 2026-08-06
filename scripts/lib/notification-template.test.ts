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

function occurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

function assertCommonContract(template: string): void {
  assert.match(template, /\{\{status_icon\}\}/);
  assert.match(template, /\{\{headline\}\}/);
  assert.match(template, /\{\{data_warning\}\}/);
  assert.equal(occurrences(template, '{{walk_line}}'), 3);
  assert.equal(occurrences(template, '{{tenure_line}}'), 3);
  assert.equal(occurrences(template, '{{market_summary_line}}'), 3);
  assert.match(template, /\{\{unit_price\}\} 萬\/坪/);
  assert.match(template, /### 排除摘要/);
  assert.doesNotMatch(template, /\{\{#each excluded\}\}/);
  assert.doesNotMatch(
    template,
    /monthly_mortgage|estimated_rent|monthly_cash_flow|房貸|月租|現金流|租金覆蓋率|market_p25_wan|market_p75_wan|selected_stage|market_confidence|official_source_date|ORS|cache|enrich/i,
  );
}

test('investment notification template is concise and decision-first', () => {
  assertCommonContract(investment);
  assert.match(investment, /### 推薦物件/);
  assert.match(investment, /### 候選／資料待確認/);
  assert.match(investment, /### ⚠️ 風險物件／待查/);
  assert.match(investment, /目標捷運站外.*out_of_region_count/s);
  assert.match(investment, /站內走路過遠.*in_region_too_far_count/s);
  assert.doesNotMatch(investment, /開價溢價|保守行情|p\*/i);
});

test('owner-occupied notification template keeps self-use decision fields', () => {
  assertCommonContract(owner);
  assert.match(owner, /### 符合條件/);
  assert.match(owner, /### 候選／資料待確認/);
  assert.match(owner, /### ⚠️ 風險物件／待查/);
  assert.match(owner, /格局 \{\{room\}\}房\{\{living_room\}\}廳\{\{bathroom\}\}衛/);
  assert.match(owner, /車位 \{\{parking\}\}/);
  assert.match(owner, /類型 \{\{type_layout\}\}/);
});
