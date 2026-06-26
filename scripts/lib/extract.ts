import type { BrowserContext, Page } from 'playwright';
import { SELECTORS, MAX_PAGES } from './config.ts';
import { buildListUrl } from './url.ts';
import { parseMapsCoordinate } from './coords.ts';
import { parseFloorField } from './floor.ts';
import { ensureLoggedIn } from './session.ts';
import type { Listing } from './types.ts';

/** Raw per-row data pulled from the DOM, before Node-side normalization. */
interface RawCard {
  title: string;
  url: string | null;
  addressOrArea: string | null;
  nearbyStation: string | null;
  mapHref: string | null;
  publishedDate: string | null;
  priceLines: string[];
  pingLines: string[];
  landFloor: string[];
  typePattern: string[];
  ageParking: string[];
  realPriceUrl: string | null;
}

/** Normalize one raw row into a Listing. */
function toListing(r: RawCard): Listing {
  const { floor, totalFloors } = parseFloorField(r.landFloor[1] ?? null);
  const typeLayout =
    [r.typePattern[0], r.typePattern[1]].filter(Boolean).join(' ') || null;
  return {
    title: r.title,
    url: r.url,
    addressOrArea: r.addressOrArea,
    nearbyStation: r.nearbyStation,
    coordinate: parseMapsCoordinate(r.mapHref),
    publishedDate: r.publishedDate,
    totalPrice: r.priceLines[0] ?? null,
    totalPing: r.pingLines[0] ?? null,
    unitPrice: r.priceLines[1] ?? null,
    floor,
    totalFloors,
    typeLayout,
    age: r.ageParking[0] ?? null,
    parking: r.ageParking[1] ?? null,
    realPriceUrl: r.realPriceUrl,
  };
}

/** All listing rows rendered on the current page, normalized. */
export async function extractListingsOnPage(page: Page): Promise<Listing[]> {
  const raw: RawCard[] = await page.$$eval(
    SELECTORS.list.cardRow,
    (rows, s) => {
      const txt = (el: Element | null) =>
        el ? (el as HTMLElement).innerText.trim() || null : null;
      const lines = (el: Element | null) =>
        el
          ? (el as HTMLElement).innerText
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean)
          : [];
      return rows
        .filter((r) => r.querySelector(s.titleLink))
        .map((r) => {
          const subj = r.querySelector(s.titleLink) as HTMLAnchorElement | null;
          const map = r.querySelector(s.mapLink) as HTMLAnchorElement | null;
          const real = r.querySelector(
            s.realPriceLink,
          ) as HTMLAnchorElement | null;
          const trainIcon = r.querySelector(s.nearbyStationIcon);
          const tds = Array.from(r.querySelectorAll(':scope > td'));
          const td = (i: number) => tds[i] ?? null;
          return {
            title: txt(subj) ?? '',
            url: subj ? subj.href : null,
            addressOrArea: txt(map),
            nearbyStation:
              trainIcon && trainIcon.parentElement
                ? trainIcon.parentElement.innerText.trim() || null
                : null,
            mapHref: map ? map.getAttribute('href') : null,
            publishedDate: txt(td(s.td.date)),
            priceLines: lines(td(s.td.price)),
            pingLines: lines(td(s.td.ping)),
            landFloor: lines(td(s.td.landFloor)),
            typePattern: lines(td(s.td.typePattern)),
            ageParking: lines(td(s.td.ageParking)),
            realPriceUrl: real ? real.href : null,
          };
        });
    },
    SELECTORS.list,
  );
  return raw.map(toListing);
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
  // 'networkidle' is unreliable here (the SPA holds a connection open), so wait
  // for DOM + the results to render instead.
  await page.goto(buildListUrl(date, 1), { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn(page, context);

  const all: Listing[] = [];
  let prevSignature = '';
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    await page.goto(buildListUrl(date, pageNum), { waitUntil: 'domcontentloaded' });
    // Wait for listing rows to render; a timeout (empty/last page) ends paging.
    await page
      .waitForSelector(SELECTORS.list.cardRow, { timeout: 20000 })
      .catch(() => {});
    const onPage = await extractListingsOnPage(page);
    if (onPage.length === 0) break;

    // Guard against a view that ignores ?page= and re-serves the same rows:
    // stop if this page's listings match the previous page's.
    const signature = onPage.map((l) => l.url ?? l.title).join('|');
    if (signature === prevSignature) break;
    prevSignature = signature;

    all.push(...onPage);
  }
  return all;
}
