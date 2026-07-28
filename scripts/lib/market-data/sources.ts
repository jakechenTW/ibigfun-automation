import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

export const TAIPEI_DOORPLATE_DETAIL_URL =
  'https://data.taipei/dataset/detail?id=b7c8e724-1e98-45ee-a0bd-f3840623ed97';

export interface TaipeiDoorplateSource {
  url: string;
  publishedAt: string | null;
}

export interface ConditionalSource {
  etag?: string | null;
  lastModified?: string | null;
}

export type ConditionalDownload =
  | { kind: 'not-modified'; etag: string | null; lastModified: string | null }
  | { kind: 'downloaded'; etag: string | null; lastModified: string | null };

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ZipEntry {
  path: string;
  stream: () => Readable;
}

function quarter(year: number, month: number): string {
  return `${year - 1911}S${Math.floor(month / 3) + 1}`;
}

/** Enumerates calendar quarters touched by a lookback window, oldest first. */
export function quartersForLookback(asOf: string, months: number): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!match || !Number.isInteger(months) || months < 0) {
    throw new RangeError('asOf must be YYYY-MM-DD and months must be a non-negative integer');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) {
    throw new RangeError('asOf must be a real ISO calendar date');
  }

  const currentMonth = year * 12 + month - 1;
  const firstMonth = currentMonth - months;
  const result: string[] = [];
  for (let value = firstMonth; value <= currentMonth; value += 1) {
    const itemYear = Math.floor(value / 12);
    const itemMonth = value % 12;
    const valueQuarter = quarter(itemYear, itemMonth);
    if (result.at(-1) !== valueQuarter) result.push(valueQuarter);
  }
  return result;
}

export function moiSeasonUrl(season: string): string {
  if (!/^\d{3}S[1-4]$/.test(season)) throw new RangeError(`Invalid MOI season: ${season}`);
  return `https://plvr.land.moi.gov.tw/DownloadSeason?season=${season}&type=zip&fileName=lvr_landcsv.zip`;
}

function htmlDecode(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&#x2F;', '/').replaceAll('&#47;', '/');
}

/** Resolves one current CSV resource; ambiguous markup is treated as source schema drift. */
export function resolveTaipeiDoorplateSource(html: string): TaipeiDoorplateSource {
  const candidates: Array<{ url: string; publishedAt: string | null }> = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const attributes = match[1] ?? '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    const download = /\bdownload\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    const text = (match[2] ?? '').replace(/<[^>]+>/g, ' ');
    const describesCsv = /\.csv\b/i.test(text) || /\.csv\b/i.test(href ?? '') ||
      /\.csv\b/i.test(download ?? '') || /(?:format|type)=csv\b/i.test(href ?? '');
    if (!href || !/resource\.download\?[^"']*\brid=/i.test(href) || !describesCsv) continue;
    const anchorIndex = match.index ?? 0;
    const surrounding = html.slice(Math.max(0, anchorIndex - 500), anchorIndex + match[0].length + 800);
    const timestamp = /(?:datetime\s*=\s*["']|發布(?:時間|日期)?\s*[:：]?\s*)(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)/i.exec(surrounding)?.[1] ?? null;
    candidates.push({
      url: new URL(htmlDecode(href), TAIPEI_DOORPLATE_DETAIL_URL).toString(),
      publishedAt: timestamp?.replace(' ', 'T') ?? null,
    });
  }
  if (candidates.length !== 1) {
    throw new Error(`Taipei doorplate source schema drift: expected exactly one CSV resource, found ${candidates.length}`);
  }
  return candidates[0]!;
}

/** Fetches a resource with persisted HTTP validators and never treats 304 as an error. */
export async function downloadConditional(
  fetcher: FetchLike,
  url: string,
  previous: ConditionalSource = {},
  destination: string,
): Promise<ConditionalDownload> {
  const headers = new Headers();
  if (previous.etag) headers.set('if-none-match', previous.etag);
  if (previous.lastModified) headers.set('if-modified-since', previous.lastModified);
  const response = await fetcher(url, { headers });
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  if (response.status === 304) return { kind: 'not-modified', etag, lastModified };
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  if (!response.body) throw new Error(`Download returned an empty body for ${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(destination));
  return { kind: 'downloaded', etag, lastModified };
}

function unsafeZipPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..');
}

/** Extracts only Taipei City's MOI sale CSV, rejecting zip-slip entries before use. */
export async function extractTaipeiSalesCsv(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  destination: string,
): Promise<void> {
  let selected: ZipEntry | null = null;
  for await (const entry of entries) {
    if (unsafeZipPath(entry.path)) throw new Error(`Unsafe ZIP entry path: ${entry.path}`);
    if (entry.path === 'a_lvr_land_a.csv') {
      if (selected) throw new Error('MOI ZIP schema drift: multiple a_lvr_land_a.csv entries');
      selected = entry;
    }
  }
  if (!selected) throw new Error('MOI ZIP schema drift: missing a_lvr_land_a.csv');
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(selected.stream(), createWriteStream(destination));
}

/** Adapts unzipper entries for the injection-friendly extractor above. */
export async function zipEntriesFromFile(file: string): Promise<ZipEntry[]> {
  const directory = await unzipper.Open.file(file);
  return directory.files.map((file) => ({ path: file.path, stream: () => file.stream() }));
}
