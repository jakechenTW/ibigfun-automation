import type { LatLng } from './geo.ts';

export const DEFAULT_VALHALLA_URL = 'https://valhalla1.openstreetmap.de';
export const DEFAULT_VALHALLA_TIMEOUT_MS = 15_000;
export const DEFAULT_VALHALLA_CLIENT_ID = 'ibigfun-automation-route-benchmark/0.4';
const MAX_VALHALLA_RETRY_DELAY_MS = 10_000;

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

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

function retryDelayMs(retryAfter: string | null, maxDelayMs: number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const requestedMs = Number.isInteger(seconds) && seconds >= 0
    ? seconds * 1000
    : 1000;
  return Math.min(requestedMs, maxDelayMs);
}

export async function routeValhallaWalkDistances(
  origin: LatLng,
  dests: LatLng[],
  options: ValhallaRouteOptions = {},
): Promise<(number | null)[]> {
  if (dests.length === 0) return [];

  const baseUrl = options.baseUrl ?? DEFAULT_VALHALLA_URL;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VALHALLA_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const configuredRetryDelayMs = options.maxRetryDelayMs ?? MAX_VALHALLA_RETRY_DELAY_MS;
  const maxRetryDelayMs = Number.isFinite(configuredRetryDelayMs)
    ? Math.min(Math.max(configuredRetryDelayMs, 0), MAX_VALHALLA_RETRY_DELAY_MS)
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
        throw new Error('Valhalla matrix invalid matrix shape');
      }
      if (
        json === null
        || typeof json !== 'object'
        || Array.isArray(json)
        || !('sources_to_targets' in json)
      ) {
        throw new Error('Valhalla matrix invalid matrix shape');
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
        throw new Error('Valhalla matrix invalid matrix shape');
      }
      const row = matrix.distances[0];
      if (!Array.isArray(row) || row.length !== dests.length) {
        throw new Error('Valhalla matrix invalid matrix shape');
      }
      return row.map((distance) => {
        if (distance === null) return null;
        if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) {
          throw new Error('Valhalla matrix invalid matrix shape');
        }
        return Math.round(distance * 1000);
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Valhalla matrix timeout after ${timeoutMs}ms`);
      }
      throw error;
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
