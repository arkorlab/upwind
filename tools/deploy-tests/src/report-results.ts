import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { describe, laneOf, type ShardVerdict } from './verdicts.ts';

/**
 * What a run on this machine's targets came to: the verdict of every shard (`verdict.json`, which
 * `judge-results.ts` wrote and the shard's artifact kept), downloaded into `--dir`, summed for each
 * lane — a target, under the Node.js the run names — into the job's summary. The shards the run was cut into, from
 * the plan's matrix (`MATRIX`), name those that left no verdict. It reports and judges nothing: each
 * shard failed for itself.
 */
const { values } = parseArgs({ options: { dir: { type: 'string' } } });
const dir = values.dir;
if (dir === undefined) {
  throw new Error('report-results: --dir is required');
}

const matrix = JSON.parse(process.env['MATRIX'] ?? '{"include":[]}') as {
  readonly include?: readonly {
    readonly target?: unknown;
    readonly node?: unknown;
    readonly shard?: unknown;
  }[];
};
const expected = new Map<string, number[]>();
const shards = matrix.include ?? [];
for (const { target, node, shard } of shards) {
  if (typeof target === 'string' && typeof shard === 'number') {
    const lane = laneOf(target, typeof node === 'string' ? node : undefined);
    expected.set(lane, [...(expected.get(lane) ?? []), shard]);
  }
}

// One artifact a directory where the run kept several, and its files in `--dir` itself where it kept
// one: the download action unpacks a single match without a directory of its own.
const verdicts: ShardVerdict[] = [];
const files = existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' }) : [];
for (const file of files) {
  if (path.basename(file) === 'verdict.json') {
    const text = readFileSync(path.join(dir, file), 'utf8');
    verdicts.push(JSON.parse(text) as ShardVerdict);
  }
}

const lanes = new Set(expected.keys());
for (const { target, node } of verdicts) {
  lanes.add(laneOf(target, node));
}
const text = [...lanes]
  .toSorted((a, b) => a.localeCompare(b))
  .map((lane) => {
    const own = verdicts
      .filter(({ target, node }) => laneOf(target, node) === lane)
      .toSorted((a, b) => a.shard - b.shard);
    return describe(lane, own, expected.get(lane) ?? []);
  })
  .join('\n');
console.log(text);
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary !== undefined && summary !== '') {
  appendFileSync(summary, text);
}
