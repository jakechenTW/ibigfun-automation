import type { LatLng } from './geo.ts';

export const DEFAULT_VALHALLA_URL = 'https://valhalla1.openstreetmap.de';
export const DEFAULT_VALHALLA_TIMEOUT_MS = 15_000;
export const DEFAULT_VALHALLA_CLIENT_ID = 'ibigfun-automation-route-benchmark/0.4';
const MAX_VALHALLA_RETRY_DELAY_MS = 10_000;
const MIN_VALHALLA_RETRY_DELAY_MS = 1_000;
const INVALID_BASE_URL_MESSAGE = 'Invalid Valhalla base URL; expected an absolute HTTP(S) URL without credentials, query, or hash.';

export interface ValhallaRouteOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetryDelayMs?: number;
}

class ValhallaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`Valhalla matrix HTTP ${status}`);
  }
}

class ValhallaMatrixShapeError extends Error {
  constructor() {
    super('Valhalla matrix invalid matrix shape');
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

function retryDelayMs(retryAfter: string | null, maxDelayMs: number): number {
  const validDelaySeconds = retryAfter !== null && /^(0|[1-9][0-9]*)$/.test(retryAfter);
  const seconds = validDelaySeconds ? Number(retryAfter) : Number.NaN;
  const requestedMs = Number.isSafeInteger(seconds)
    ? seconds * 1000
    : MIN_VALHALLA_RETRY_DELAY_MS;
  return Math.min(Math.max(requestedMs, MIN_VALHALLA_RETRY_DELAY_MS), maxDelayMs);
}

export function normalizeValhallaBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    if (raw.trim() !== raw) throw new Error(INVALID_BASE_URL_MESSAGE);
    parsed = new URL(raw);
  } catch {
    throw new Error(INVALID_BASE_URL_MESSAGE);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.href.includes('?')
    || parsed.href.includes('#')
  ) {
    throw new Error(INVALID_BASE_URL_MESSAGE);
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname === '' ? '' : pathname}`;
}

export function valhallaEndpointIdentifier(baseUrl: string): string {
  return new URL(normalizeValhallaBaseUrl(baseUrl)).origin;
}

export function safeValhallaErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (
    /^Valhalla matrix HTTP \d{3}$/.test(message)
    || /^Valhalla matrix timeout after \d+ms$/.test(message)
    || message === 'Valhalla matrix invalid matrix shape'
    || message === 'Valhalla matrix transport failure'
  ) {
    return message;
  }
  return 'Valhalla matrix transport failure';
}

export async function routeValhallaWalkDistances(
  origin: LatLng,
  dests: LatLng[],
  options: ValhallaRouteOptions = {},
): Promise<(number | null)[]> {
  const baseUrl = normalizeValhallaBaseUrl(options.baseUrl ?? DEFAULT_VALHALLA_URL);
  if (dests.length === 0) return [];

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VALHALLA_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const configuredRetryDelayMs = options.maxRetryDelayMs ?? MAX_VALHALLA_RETRY_DELAY_MS;
  const maxRetryDelayMs = Number.isFinite(configuredRetryDelayMs)
    ? Math.min(
      Math.max(configuredRetryDelayMs, MIN_VALHALLA_RETRY_DELAY_MS),
      MAX_VALHALLA_RETRY_DELAY_MS,
    )
    : MAX_VALHALLA_RETRY_DELAY_MS;
  const body = {
    sources: [{ lat: origin.lat, lon: origin.lng }],
    targets: dests.map((dest) => ({ lat: dest.lat, lon: dest.lng })),
    costing: 'pedestrian',
    costing_options: { pedestrian: { walking_speed: 4.8 } },
    units: 'kilometers',
    verbose: false,
  };

  const attempt = async (): Promise<(number | null)[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/sources_to_targets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': DEFAULT_VALHALLA_CLIENT_ID,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new ValhallaHttpError(res.status, res.headers.get('Retry-After'));

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new ValhallaMatrixShapeError();
      }
      if (
        json === null
        || typeof json !== 'object'
        || Array.isArray(json)
        || !('sources_to_targets' in json)
      ) {
        throw new ValhallaMatrixShapeError();
      }
      const matrix = json.sources_to_targets;
      if (
        matrix === null
        || typeof matrix !== 'object'
        || Array.isArray(matrix)
        || !('distances' in matrix)
        || !Array.isArray(matrix.distances)
        || matrix.distances.length !== 1
      ) {
        throw new ValhallaMatrixShapeError();
      }
      const row = matrix.distances[0];
      if (!Array.isArray(row) || row.length !== dests.length) {
        throw new ValhallaMatrixShapeError();
      }
      return row.map((distance) => {
        if (distance === null) return null;
        if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) {
          throw new ValhallaMatrixShapeError();
        }
        const meters = Math.round(distance * 1000);
        if (!Number.isFinite(meters)) throw new ValhallaMatrixShapeError();
        return meters;
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Valhalla matrix timeout after ${timeoutMs}ms`);
      }
      if (error instanceof ValhallaHttpError || error instanceof ValhallaMatrixShapeError) {
        throw error;
      }
      throw new Error('Valhalla matrix transport failure');
    } finally {
      clearTimeout(timer);
    }
  };

  for (let tries = 0; tries < 2; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const retryable = error instanceof ValhallaHttpError
        && (error.status === 429 || (error.status >= 500 && error.status <= 599));
      if (!retryable || tries === 1) throw error;
      await sleep(retryDelayMs(error.retryAfter, maxRetryDelayMs));
    }
  }
  throw new Error('Valhalla matrix request failed');
}
