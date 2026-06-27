import type { BrowserContext, Page } from 'playwright';
import { SELECTORS, MAX_PAGES, SIGNIN_PATH_FRAGMENT } from './config.ts';
import { buildListUrl } from './url.ts';
import { parseMapsCoordinate } from './coords.ts';
import { parseFloorField } from './floor.ts';
import { logIn } from './session.ts';
import { openWithRelogin } from './relogin.ts';
import type { Listing } from './types.ts';
import { normalizeHistory, type RawHistoryRow } from './history.ts';

/** Max auto re-logins per page when the session is kicked mid-run. */
const MAX_RELOGIN = 2;

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
  historyRows: RawHistoryRow[];
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
    listingHistory: normalizeHistory(r.historyRows),
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
      // Columns read by fixed index (verified live DOM): [總價, 名稱, 來源, 刊登日].
      // If iBigFun reorders columns, normalizeHistory's date-validity filter drops
      // the rows, so the listing degrades gracefully to empty history rather than
      // emitting corrupted numbers.
      const parseHistory = (sub: Element) =>
        Array.from(sub.querySelectorAll('tr'))
          .filter((tr) => !tr.querySelector('th')) // skip the header row
          .map((tr) => {
            const c = tr.querySelectorAll('td');
            if (c.length < 4) return null;
            return {
              price: (c[0] as HTMLElement).innerText.trim() || null,
              source: (c[2] as HTMLElement).innerText.trim() || null,
              date: (c[3] as HTMLElement).innerText.trim() || null,
              active: !!c[1].querySelector('a'),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.querySelector(s.titleLink)) continue;
        // The history table sits in a sibling row before the next listing row.
        let historyRows: ReturnType<typeof parseHistory> = [];
        for (let j = i + 1; j < rows.length; j++) {
          if (rows[j].querySelector(s.titleLink)) break;
          const sub = rows[j].querySelector(s.historyTable);
          if (sub) {
            historyRows = parseHistory(sub);
            break;
          }
        }
        const subj = r.querySelector(s.titleLink) as HTMLAnchorElement | null;
        const map = r.querySelector(s.mapLink) as HTMLAnchorElement | null;
        const real = r.querySelector(s.realPriceLink) as HTMLAnchorElement | null;
        const trainIcon = r.querySelector(s.nearbyStationIcon);
        const tds = Array.from(r.querySelectorAll(':scope > td'));
        const td = (k: number) => tds[k] ?? null;
        out.push({
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
          historyRows,
        });
      }
      return out;
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
/**
 * Open one results page, logging in if we land on signin — whether that's the
 * first page or a mid-run kick. 'networkidle' is unreliable here (the SPA holds
 * a connection open), so we wait for DOM + the results rows to render.
 */
async function openListPage(
  page: Page,
  context: BrowserContext,
  date: string,
  pageNum: number,
  prevFirstHref: string,
): Promise<void> {
  await openWithRelogin({
    navigate: async () => {
      await page.goto(buildListUrl(date, pageNum), { waitUntil: 'domcontentloaded' });
      return page.url();
    },
    login: () => logIn(page, context),
    isSignin: (url) => url.includes(SIGNIN_PATH_FRAGMENT),
    maxRelogin: MAX_RELOGIN,
    onRelogin: () =>
      console.error(
        '  session was kicked (account logged in elsewhere); re-logging in ' +
          '— this logs out any other browser session.',
      ),
  });
  // The SPA renders listing rows via XHR after domcontentloaded, so a plain
  // "row exists" check can read the previous page's stale rows. Wait until the
  // first listing differs from the previous page's first listing. Times out on
  // an empty/last page, which then ends paging.
  const firstLink = `${SELECTORS.list.cardRow} ${SELECTORS.list.titleLink}`;
  await page
    .waitForFunction(
      ({ sel, prev }: { sel: string; prev: string }) => {
        const a = document.querySelector(sel) as HTMLAnchorElement | null;
        return !!(a && a.href && a.href !== prev);
      },
      { sel: firstLink, prev: prevFirstHref },
      { timeout: 15000 },
    )
    .catch(() => {});
}

export async function collectListings(
  page: Page,
  context: BrowserContext,
  date: string,
): Promise<Listing[]> {
  const all: Listing[] = [];
  let prevSignature = '';
  let prevFirstHref = '';
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    await openListPage(page, context, date, pageNum, prevFirstHref);
    const onPage = await extractListingsOnPage(page);
    if (onPage.length === 0) break;

    // Guard against a view that ignores ?page= and re-serves the same rows:
    // stop if this page's listings match the previous page's.
    const signature = onPage.map((l) => l.url ?? l.title).join('|');
    if (signature === prevSignature) break;
    prevSignature = signature;
    prevFirstHref = onPage[0].url ?? prevFirstHref;

    all.push(...onPage);
  }
  return all;
}
