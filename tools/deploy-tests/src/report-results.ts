import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { describe, type ShardVerdict } from './verdicts.ts';

/**
 * What a run on this machine's targets came to: the verdict of every shard (`verdict.json`, which
 * `judge-results.ts` wrote and the shard's artifact kept), downloaded into `--dir` one artifact a
 * directory, summed for each target into the job's summary. The shards the run was cut into, from
 * the plan's matrix (`MATRIX`), name those that left no verdict. It reports and judges nothing: each
 * shard failed for itself.
 */
const { values } = parseArgs({ options: { dir: { type: 'string' } } });
const dir = values.dir;
if (dir === undefined) {
  throw new Error('report-results: --dir is required');
}

const matrix = JSON.parse(process.env['MATRIX'] ?? '{"include":[]}') as {
  readonly include?: readonly { readonly target?: unknown; readonly shard?: unknown }[];
};
const expected = new Map<string, number[]>();
const shards = matrix.include ?? [];
for (const { target, shard } of shards) {
  if (typeof target === 'string' && typeof shard === 'number') {
    expected.set(target, [...(expected.get(target) ?? []), shard]);
  }
}

const verdicts: ShardVerdict[] = [];
const artifacts = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
for (const entry of artifacts) {
  const file = path.join(dir, entry.name, 'verdict.json');
  if (entry.isDirectory() && existsSync(file)) {
    verdicts.push(JSON.parse(readFileSync(file, 'utf8')) as ShardVerdict);
  }
}

const targets = new Set(expected.keys());
for (const { target } of verdicts) {
  targets.add(target);
}
const text = [...targets]
  .toSorted((a, b) => a.localeCompare(b))
  .map((target) => {
    const own = verdicts
      .filter((verdict) => verdict.target === target)
      .toSorted((a, b) => a.shard - b.shard);
    return describe(target, own, expected.get(target) ?? []);
  })
  .join('\n');
console.log(text);
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary !== undefined && summary !== '') {
  appendFileSync(summary, text);
}
