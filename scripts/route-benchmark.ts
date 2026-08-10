#!/usr/bin/env node
import * as path from 'node:path';
import { resolveProfileFromArgs } from './lib/profiles.ts';
import { resolveRange } from './lib/range.ts';
import {
  parseBenchmarkLimit,
  runRouteBenchmark,
  type RouteBenchmarkOptions,
} from './lib/route-benchmark-run.ts';
import { DEFAULT_VALHALLA_URL } from './lib/valhalla-routing.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeFailure(prefix: 'BAD INPUT' | 'ERROR', error: unknown, exitCode: 1 | 2): void {
  process.stderr.write(`${prefix}: ${errorMessage(error)}\n`);
  process.exitCode = exitCode;
}

async function main(argv: string[]): Promise<void> {
  let options: RouteBenchmarkOptions;
  try {
    const profile = resolveProfileFromArgs(argv);
    const range = resolveRange(argv, new Date());
    const limit = parseBenchmarkLimit(argv);
    options = {
      rootDir: process.cwd(),
      profileId: profile.id,
      range,
      limit,
      valhallaBaseUrl: process.env.VALHALLA_URL ?? DEFAULT_VALHALLA_URL,
      requestDelayMs: 1000,
    };
  } catch (error) {
    writeFailure('BAD INPUT', error, 2);
    return;
  }

  try {
    const { artifactPath, artifact } = await runRouteBenchmark(options, {
      progress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify({
      artifact: path.relative(process.cwd(), artifactPath),
      summary: artifact.summary,
    }, null, 2)}\n`);
  } catch (error) {
    if (/^missing (?:listing|MRT exits|route cache) input\b/.test(errorMessage(error))) {
      writeFailure('BAD INPUT', error, 2);
      return;
    }
    writeFailure('ERROR', error, 1);
  }
}

await main(process.argv.slice(2));
