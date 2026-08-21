#!/usr/bin/env node
import * as path from 'node:path';
import { resolveProfileFromArgs } from './lib/profiles.ts';
import { resolveRange } from './lib/range.ts';
import {
  ROUTE_TRIAL_PERSISTENCE_ERROR,
  runRouteTrial,
  type RouteTrialOptions,
} from './lib/route-trial-run.ts';
import { DEFAULT_VALHALLA_URL, normalizeValhallaBaseUrl } from './lib/valhalla-routing.ts';

const LOCAL_INPUT_ERRORS = new Set([
  'Valhalla trial request is missing or invalid',
  'Valhalla trial listings input is missing or invalid',
  'Valhalla trial enriched input is missing or invalid',
  'Valhalla trial MRT input is missing or invalid',
  'Valhalla trial cache is invalid',
]);

function fail(prefix: 'BAD INPUT' | 'ERROR', message: string, exitCode: 1 | 2): void {
  process.stderr.write(`${prefix}: ${message}\n`);
  process.exitCode = exitCode;
}

function validateGrammar(argv: string[]): void {
  const allowed = new Set(['--profile', '--date', '--from', '--to']);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const name = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (!allowed.has(name) || seen.has(name)) throw new Error('invalid grammar');
    seen.add(name);
    if (equalsIndex !== -1) {
      if (token.slice(equalsIndex + 1) === '') throw new Error('missing value');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('missing value');
    index += 1;
  }
}

async function main(argv: string[]): Promise<void> {
  try { process.loadEnvFile('.env'); } catch { /* environment may already be exported */ }

  try {
    validateGrammar(argv);
  } catch {
    fail('BAD INPUT', 'Invalid route trial arguments', 2);
    return;
  }

  let profileId: string;
  try {
    profileId = resolveProfileFromArgs(argv).id;
  } catch {
    fail('BAD INPUT', 'Invalid route trial profile', 2);
    return;
  }

  let range;
  try {
    range = resolveRange(argv, new Date());
  } catch {
    fail('BAD INPUT', 'Invalid route trial range', 2);
    return;
  }

  let valhallaBaseUrl: string;
  try {
    valhallaBaseUrl = normalizeValhallaBaseUrl(
      process.env.VALHALLA_URL || DEFAULT_VALHALLA_URL,
    );
  } catch {
    fail(
      'BAD INPUT',
      'Invalid Valhalla base URL; expected an absolute HTTP(S) URL without credentials, query, or hash.',
      2,
    );
    return;
  }

  const options: RouteTrialOptions = {
    rootDir: process.cwd(),
    profileId,
    range,
    valhallaBaseUrl,
    requestDelayMs: 1000,
  };
  try {
    const { artifactPath, artifact } = await runRouteTrial(options, {
      progress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify({
      artifact: path.relative(process.cwd(), artifactPath),
      summary: artifact.summary,
    }, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (LOCAL_INPUT_ERRORS.has(message)) {
      fail('BAD INPUT', message, 2);
      return;
    }
    if (message === ROUTE_TRIAL_PERSISTENCE_ERROR
      || message === 'Valhalla trial cache persistence failed') {
      fail('ERROR', message, 1);
      return;
    }
    fail('ERROR', 'Valhalla trial failed', 1);
  }
}

await main(process.argv.slice(2));
