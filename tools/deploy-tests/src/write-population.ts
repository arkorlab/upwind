import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { populationManifest, skippedPopulation } from './population.ts';

/**
 * Writes the skipped population of the Next.js checkout at `--next-dir` (`population.ts`), before a
 * shard lists what it runs. The copies go into the checkout beside their upstream suites. Into
 * `--output`, beside the results the shard keeps, go what the population is made of
 * (`population.json`) and the manifest the runner is given for it (`skipped-manifest.json`).
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
  throw new Error('write-population: --next-dir and --output are both required');
}

const population = skippedPopulation(nextDir);
mkdirSync(output, { recursive: true });
writeFileSync(
  path.join(output, 'population.json'),
  `${JSON.stringify(population, undefined, 2)}\n`,
);
writeFileSync(
  path.join(output, 'skipped-manifest.json'),
  `${JSON.stringify(populationManifest(population), undefined, 2)}\n`,
);

const listed = Object.values(population.listed).reduce((sum, cases) => sum + cases.length, 0);
const lines = [
  `- ${String(population.excluded.length)} suite(s) the deploy manifest excludes`,
  `- ${String(Object.keys(population.listed).length)} suite(s) run whole for the ${String(listed)} case(s) the manifest leaves out of them`,
  `- ${String(population.supplements.length)} cop(ies) of cases deploy mode registers otherwise or not at all`,
  ...population.stale.map(
    ({ file, upstream }) =>
      `- left out: \`${file}\`, since \`${path.posix.dirname(upstream)}\` is not the directory it was copied from`,
  ),
];
const text = `**What Next.js skips in deploy mode:**\n\n${lines.join('\n')}\n`;
console.log(text);
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary !== undefined && summary !== '') {
  appendFileSync(summary, text);
}
