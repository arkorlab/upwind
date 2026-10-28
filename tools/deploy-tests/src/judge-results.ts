import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { fails, judge } from './judge.ts';
import { type JestSuite, jestSuite, listedSuites } from './results.ts';
import { REVIEWED } from './reviewed.ts';
import { describe, type ShardVerdict, shardFails } from './verdicts.ts';

/**
 * Judges a shard of a run on this machine's targets (`judge.ts`) where it ran: the suites it was to
 * run (`expected-tests.txt` in `--results`, written before it ran them) by what each left in
 * `--next-dir` (`<suite>.results.json`), against the reviewed cases of the Next.js release checked
 * out there. The verdict goes beside the shard's results (`verdict.json`) and into the job's summary,
 * and the shard fails where it holds a failure the reviewed cases do not account for, a suite that
 * left no result, or a runner that did not finish: one that wrote no exit code beside the results
 * (`runner-exit-code.txt`), stopped at its step's time limit or never started.
 *
 * Where it ran, from the environment: the target (`TARGET`), the shard (`SHARD`) and the commit of
 * Next.js (`NEXT_COMMIT`).
 */
const { values } = parseArgs({
  options: {
    'next-dir': { type: 'string' },
    results: { type: 'string' },
  },
});
const nextDir = values['next-dir'];
const resultsDir = values.results;
if (nextDir === undefined || resultsDir === undefined) {
  throw new Error('judge-results: --next-dir and --results are both required');
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`judge-results: ${name} is required`);
  }
  return value;
}

const target = required('TARGET');
if (target !== 'cloudflare' && target !== 'node') {
  throw new Error(
    `judge-results: TARGET is one of this machine's, cloudflare or node, not ${target}`,
  );
}
const shard = Number(required('SHARD'));
if (!Number.isSafeInteger(shard) || shard < 1) {
  throw new Error('judge-results: SHARD must be a positive whole number');
}
const next = JSON.parse(readFileSync(path.join(nextDir, 'packages/next/package.json'), 'utf8')) as {
  readonly version?: unknown;
};
if (typeof next.version !== 'string') {
  throw new TypeError("judge-results: Next.js's package.json names no version");
}

const listed = listedSuites(readFileSync(path.join(resultsDir, 'expected-tests.txt'), 'utf8'));
const results = new Map<string, JestSuite | 'unreadable'>();
for (const suite of listed) {
  const file = path.join(nextDir, `${suite}.results.json`);
  if (!existsSync(file)) {
    continue;
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    results.set(suite, jestSuite(suite, raw));
  } catch {
    results.set(suite, 'unreadable');
  }
}

/** The suites the watchdog ended a Jest process of (`runner-watchdog.ts`), where it ended any. */
function endedByWatchdog(): string[] {
  const file = path.join(resultsDir ?? '.', 'watchdog.json');
  if (!existsSync(file)) {
    return [];
  }
  const { ended } = JSON.parse(readFileSync(file, 'utf8')) as { readonly ended?: unknown };
  return Array.isArray(ended) ? ended.filter((suite) => typeof suite === 'string') : [];
}

const verdict: ShardVerdict = {
  ...judge(
    { target, next: { version: next.version, commit: required('NEXT_COMMIT') } },
    listed,
    results,
    REVIEWED,
  ),
  shard,
  runnerFinished: existsSync(path.join(resultsDir, 'runner-exit-code.txt')),
  ended: endedByWatchdog(),
};
writeFileSync(path.join(resultsDir, 'verdict.json'), `${JSON.stringify(verdict, undefined, 2)}\n`);
const text = describe(target, [verdict]);
console.log(text);
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary !== undefined && summary !== '') {
  appendFileSync(summary, text);
}
if (shardFails(verdict, fails)) {
  process.exitCode = 1;
}
