import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { parseIndex, resultPath, SCHEMA_VERSION } from './contract.ts';
import { appendAttempt } from './feed.ts';
import { finalizeAttempt } from './finalize.ts';
import { nowIso } from './time.ts';

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

const [artifactFile, directory, initialize] = process.argv.slice(2);
const eventFile = process.env['GITHUB_EVENT_PATH'];
if (
  artifactFile === undefined ||
  directory === undefined ||
  eventFile === undefined ||
  (initialize !== undefined && initialize !== '--initialize')
) {
  throw new Error('usage: node publish.ts <artifact.json> <feed-directory> [--initialize]');
}
let artifact: unknown;
if (existsSync(artifactFile)) {
  try {
    artifact = readJson(artifactFile);
  } catch {
    artifact = null;
  }
}
const measurement = finalizeAttempt(readJson(eventFile), artifact);
if (measurement === null) {
  throw new Error('only scheduled benchmark runs of the main branch publish this feed');
}
const indexFile = path.join(directory, 'index.json');
if (initialize !== '--initialize' && !existsSync(indexFile)) {
  throw new Error('existing results branch has no index; refusing to reset its sequence');
}
const previous = existsSync(indexFile) ? parseIndex(readJson(indexFile)) : undefined;
const index = appendAttempt(previous, measurement, nowIso());
if (index !== previous) {
  const resultsDirectory = path.join(directory, 'runs');
  mkdirSync(resultsDirectory, { recursive: true });
  if (measurement.status === 'success') {
    writeFileSync(
      path.join(directory, resultPath(measurement)),
      `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        runId: measurement.runId,
        runAttempt: measurement.runAttempt,
        run: measurement.run,
      })}\n`,
    );
  }
  const kept = new Set(
    index.attempts.flatMap((attempt) =>
      attempt.status === 'success' ? [path.basename(attempt.result)] : [],
    ),
  );
  for (const file of readdirSync(resultsDirectory)) {
    if (/^\d+-\d+\.json$/u.test(file) && !kept.has(file)) {
      unlinkSync(path.join(resultsDirectory, file));
    }
  }
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
}
console.log(`Published benchmark sequence ${String(index.sequence)}`);
