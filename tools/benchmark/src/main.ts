import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { type Measurement, parseMeasurement, SCHEMA_VERSION, sourceFromEnv } from './contract.ts';
import { errorText, PROTOCOL, type Run, TARGETS } from './protocol.ts';
import { measureRun } from './run.ts';
import { nowIso } from './time.ts';

async function main(): Promise<void> {
  const [mode, output] = process.argv.slice(2);
  if (mode !== undefined && (mode !== '--github' || output === undefined)) {
    throw new Error('usage: node tools/benchmark/src/main.ts [--github <attempt.json>]');
  }
  if (mode === undefined) {
    console.log(JSON.stringify(await measureRun(), null, 2));
    return;
  }
  const source = sourceFromEnv();
  const startedAt = nowIso();
  const base = {
    schemaVersion: SCHEMA_VERSION,
    runId: process.env['GITHUB_RUN_ID'],
    runAttempt: Number(process.env['GITHUB_RUN_ATTEMPT']),
    source,
    protocol: PROTOCOL,
    targets: TARGETS,
  };
  let measurement: Measurement;
  let attemptedRun: Run | undefined;
  try {
    const run = await measureRun();
    attemptedRun = run;
    const empty = run.scenarios.some((scenario) => {
      return scenario.pairs.every(
        (pair) => pair.vercel.headersMs === null || pair.arkor.headersMs === null,
      );
    });
    if (empty) {
      throw new Error('a scenario had no pair both sides answered within its budget');
    }
    measurement = parseMeasurement({
      ...base,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: 'success',
      run,
    });
  } catch (error) {
    measurement = parseMeasurement({
      ...base,
      startedAt,
      finishedAt: nowIso(),
      status: 'failure',
      error: errorText(error),
      ...(attemptedRun !== undefined && { run: attemptedRun }),
    });
    process.exitCode = 1;
  }
  if (output === undefined) {
    throw new Error('missing output path');
  }
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(measurement, null, 2)}\n`);
  console.log(`Measurement ${measurement.status}: ${measurement.source.runUrl}`);
}

await main();
