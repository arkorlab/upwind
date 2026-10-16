import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type Index, parseIndex, SCHEMA_VERSION } from '../src/contract.ts';
import { appendAttempt } from '../src/feed.ts';
import { AT, completed, success } from './helpers.ts';

const PUBLISHER = path.resolve(import.meta.dirname, '../src/publish.ts');
const directories: string[] = [];

interface Publication {
  readonly feed: string;
  readonly artifact: string;
  readonly event: string;
}

function fixture(): Publication {
  const directory = mkdtempSync(path.join(tmpdir(), 'upwind-benchmark-publication-'));
  directories.push(directory);
  const feed = path.join(directory, 'feed');
  mkdirSync(feed);
  const event = path.join(directory, 'event.json');
  writeFileSync(event, JSON.stringify(completed()));
  return { feed, event, artifact: path.join(directory, 'attempt.json') };
}

function publish(
  input: Publication,
  initialize = false,
): { readonly status: number | null; readonly stderr: string } {
  const argumentsOfCall = [PUBLISHER, input.artifact, input.feed];
  if (initialize) {
    argumentsOfCall.push('--initialize');
  }

  const result = spawnSync(process.execPath, argumentsOfCall, {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_PATH: input.event },
  });
  return { status: result.status, stderr: result.stderr };
}

function writeSuccess(input: Publication, id: number): void {
  const measured = success(String(id));
  writeFileSync(input.artifact, JSON.stringify(measured));
  writeFileSync(input.event, JSON.stringify(completed({ id, html_url: measured.source.runUrl })));
}

function readIndex(input: Publication): Index {
  const contents = readFileSync(path.join(input.feed, 'index.json'), 'utf8');
  return parseIndex(JSON.parse(contents) as unknown);
}

describe('publisher filesystem CLI', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bootstraps a first missing-artifact failure and leaves an empty results directory', () => {
    const input = fixture();

    expect(publish(input, true)).toStrictEqual({ status: 0, stderr: '' });
    expect(readIndex(input)).toMatchObject({
      sequence: 1,
      attempts: [{ sequence: 1, status: 'failure', runId: '123', runAttempt: 1 }],
    });
    expect(readdirSync(path.join(input.feed, 'runs'))).toStrictEqual([]);

    const before = readFileSync(path.join(input.feed, 'index.json'), 'utf8');

    expect(publish(input)).toStrictEqual({ status: 0, stderr: '' });
    expect(readFileSync(path.join(input.feed, 'index.json'), 'utf8')).toBe(before);
  });

  it('writes the raw successful run and leaves duplicate publication byte-for-byte unchanged', () => {
    const input = fixture();
    writeSuccess(input, 123);

    expect(publish(input, true)).toStrictEqual({ status: 0, stderr: '' });

    const index = readIndex(input);

    expect(index).toMatchObject({
      sequence: 1,
      attempts: [{ status: 'success', result: 'runs/123-1.json' }],
    });

    const raw = readFileSync(path.join(input.feed, 'runs/123-1.json'), 'utf8');

    expect(JSON.parse(raw) as unknown).toStrictEqual({
      schemaVersion: SCHEMA_VERSION,
      runId: '123',
      runAttempt: 1,
      run: success().run,
    });

    const before = readFileSync(path.join(input.feed, 'index.json'), 'utf8');

    expect(publish(input)).toStrictEqual({ status: 0, stderr: '' });
    expect(readFileSync(path.join(input.feed, 'index.json'), 'utf8')).toBe(before);
    expect(readFileSync(path.join(input.feed, 'runs/123-1.json'), 'utf8')).toBe(raw);
  });

  it('prunes only the expired raw result and preserves all 120 retained files', () => {
    const input = fixture();
    const results = path.join(input.feed, 'runs');
    mkdirSync(results);
    let index: Index | undefined;
    for (let id = 1; id <= 120; id += 1) {
      const measured = success(String(id));
      index = appendAttempt(index, measured, AT);
      writeFileSync(
        path.join(results, `${String(id)}-1.json`),
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          runId: measured.runId,
          runAttempt: measured.runAttempt,
          run: measured.run,
        }),
      );
    }
    writeFileSync(path.join(input.feed, 'index.json'), JSON.stringify(index));
    writeSuccess(input, 121);

    expect(publish(input)).toStrictEqual({ status: 0, stderr: '' });
    expect(readIndex(input).sequence).toBe(121);
    expect(readIndex(input).attempts).toHaveLength(120);
    expect(existsSync(path.join(results, '1-1.json'))).toBe(false);
    expect(readdirSync(results)).toHaveLength(120);

    for (const attempt of readIndex(input).attempts) {
      expect(attempt.status).toBe('success');
      expect(existsSync(path.join(results, `${attempt.runId}-1.json`))).toBe(true);
    }
  });

  it('refuses a missing or corrupted existing index without resetting publication state', () => {
    const input = fixture();

    expect(publish(input).status).toBe(1);
    expect(existsSync(path.join(input.feed, 'index.json'))).toBe(false);

    const corrupt = '{"schemaVersion":1,"sequence":0,"attempts":[]}';
    writeFileSync(path.join(input.feed, 'index.json'), corrupt);

    expect(publish(input).status).toBe(1);
    expect(readFileSync(path.join(input.feed, 'index.json'), 'utf8')).toBe(corrupt);
  });
});
