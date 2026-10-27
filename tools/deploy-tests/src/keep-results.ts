import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { keptSuite, listedSuites } from './results.ts';

/**
 * Keeps a shard's results for a compatibility record in `--output` (`results.ts`): who measured
 * what (`metadata.json`), beside the suites the shard was to run (`expected-tests.txt`) and the
 * runner's exit code (`runner-exit-code.txt`, where it ran), which the workflow wrote there before,
 * and for each of those suites that left a result, `results/<suite>.json`. A suite that left none —
 * the shard stopped, or the suite never started — has no file, which is how the record finds it
 * incomplete; so has one whose result cannot be read as Jest's, said here by its path alone.
 *
 * The identity is the workflow's, through the environment: the run and its attempt, when the plan
 * was made and when this shard ended, the selection and how many pieces it was cut into, this
 * shard, where each application was served and with which cache, and the commits of Next.js and of
 * this adapter.
 */
const { values } = parseArgs({
  options: {
    'next-dir': { type: 'string' },
    output: { type: 'string' },
  },
});
const nextDir = values['next-dir'];
const output = values.output;
if (nextDir === undefined || output === undefined) {
  throw new Error('keep-results: --next-dir and --output are both required');
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`keep-results: ${name} is required`);
  }
  return value;
}

function whole(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`keep-results: ${name} must be a positive whole number`);
  }
  return value;
}

const tests = required('TESTS');
const next = JSON.parse(readFileSync(path.join(nextDir, 'packages/next/package.json'), 'utf8')) as {
  readonly version?: unknown;
};
if (typeof next.version !== 'string') {
  throw new TypeError("keep-results: Next.js's package.json names no version");
}
const metadata = {
  version: 1,
  target: required('TARGET'),
  cache: required('CACHE'),
  next: { version: next.version, commit: required('NEXT_COMMIT') },
  adapterCommit: required('ADAPTER_COMMIT'),
  run: {
    id: whole('RUN_ID'),
    attempt: whole('RUN_ATTEMPT'),
    startedAt: required('STARTED_AT'),
    finishedAt: required('FINISHED_AT'),
    selection: tests === 'all' ? 'all' : tests.split(/\s+/u).filter((entry) => entry !== ''),
    shards: whole('TOTAL'),
  },
  shard: whole('SHARD'),
};
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'metadata.json'), `${JSON.stringify(metadata, undefined, 2)}\n`);

const listing = path.join(output, 'expected-tests.txt');
const suites = existsSync(listing) ? listedSuites(readFileSync(listing, 'utf8')) : [];
let kept = 0;
for (const suite of suites) {
  const file = path.join(nextDir, `${suite}.results.json`);
  if (!existsSync(file)) {
    continue;
  }
  try {
    const result = keptSuite(suite, JSON.parse(readFileSync(file, 'utf8')));
    const target = path.join(output, 'results', `${suite}.json`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(result)}\n`);
    kept += 1;
  } catch {
    // What it held is not repeated here: a result is only kept in the form above.
    console.error(`keep-results: the result of ${suite} could not be read as Jest's`);
  }
}
console.log(`keep-results: ${String(kept)} of ${String(suites.length)} suite(s) left a result`);
