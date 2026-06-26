import type { BrowserContext, Locator, Page } from 'playwright';
import { SELECTORS, MAX_PAGES } from './config.ts';
import { buildListUrl } from './url.ts';
import { parseMapsCoordinate } from './coords.ts';
import { ensureLoggedIn } from './session.ts';
import type { Listing } from './types.ts';

const ORIGIN = 'https://www.ibigfun.com';

/** Trimmed text of the first match of `selector` within `card`, or null. */
async function textOf(card: Locator, selector: string): Promise<string | null> {
  const loc = card.locator(selector).first();
  if ((await loc.count()) === 0) return null;
  const text = (await loc.textContent())?.trim();
  return text ? text : null;
}

/** Absolute href of the first match of `selector` within `card`, or null. */
async function hrefOf(card: Locator, selector: string): Promise<string | null> {
  const loc = card.locator(selector).first();
  if ((await loc.count()) === 0) return null;
  const href = await loc.getAttribute('href');
  if (!href) return null;
  try {
    return new URL(href, ORIGIN).toString();
  } catch {
    return null;
  }
}

/** Extract one normalized listing from a card locator. */
async function extractCard(card: Locator): Promise<Listing> {
  const mapHref = await hrefOf(card, SELECTORS.list.mapLink);
  return {
    title: (await textOf(card, SELECTORS.list.title)) ?? '',
    url: await hrefOf(card, SELECTORS.list.link),
    addressOrArea: await textOf(card, SELECTORS.list.address),
    coordinate: parseMapsCoordinate(mapHref),
    publishedDate: await textOf(card, SELECTORS.list.publishedDate),
    totalPrice: await textOf(card, SELECTORS.list.totalPrice),
    totalPing: await textOf(card, SELECTORS.list.totalPing),
    unitPrice: await textOf(card, SELECTORS.list.unitPrice),
    floor: await textOf(card, SELECTORS.list.floor),
    totalFloors: await textOf(card, SELECTORS.list.totalFloors),
    typeLayout: await textOf(card, SELECTORS.list.typeLayout),
    age: await textOf(card, SELECTORS.list.age),
    parking: await textOf(card, SELECTORS.list.parking),
    realPriceUrl: await hrefOf(card, SELECTORS.list.realPriceLink),
  };
}

/** All listing cards rendered on the current page. */
export async function extractListingsOnPage(page: Page): Promise<Listing[]> {
  const cards = page.locator(SELECTORS.list.card);
  const count = await cards.count();
  const listings: Listing[] = [];
  for (let i = 0; i < count; i++) {
    listings.push(await extractCard(cards.nth(i)));
  }
  return listings;
}

/**
 * Navigate the filtered target-date view (logging in on the first page if
 * needed) and collect listings across all result pages. Stops at the first
 * empty page or at MAX_PAGES.
 */
export async function collectListings(
  page: Page,
  context: BrowserContext,
  date: string,
): Promise<Listing[]> {
  // Prime page 1 and handle a possible login bounce before collecting.
  await page.goto(buildListUrl(date, 1), { waitUntil: 'networkidle' });
  await ensureLoggedIn(page, context);

  const all: Listing[] = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    await page.goto(buildListUrl(date, pageNum), { waitUntil: 'networkidle' });
    const onPage = await extractListingsOnPage(page);
    if (onPage.length === 0) break;
    all.push(...onPage);
  }
  return all;
}
