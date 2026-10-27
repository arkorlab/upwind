import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCheckShard } from '../src/sharding.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

describe('the local check shard argument', () => {
  it.each([
    { value: '1/1', shard: { index: 1, total: 1 } },
    { value: '1/4', shard: { index: 1, total: 4 } },
    { value: '4/4', shard: { index: 4, total: 4 } },
    {
      value: `${String(Number.MAX_SAFE_INTEGER)}/${String(Number.MAX_SAFE_INTEGER)}`,
      shard: { index: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER },
    },
  ])('accepts the complete one-based partition $value', ({ value, shard }) => {
    expect(parseCheckShard(value)).toStrictEqual(shard);
  });

  it.each([
    '',
    '1',
    '1/',
    '0/4',
    '5/4',
    '1/0',
    '-1/4',
    '1.5/4',
    '1/2.5',
    '1e1/20',
    '1/9007199254740992',
    '1/4/5',
    ' 1/4',
    '1/4 ',
  ])('refuses the incomplete or invalid partition %j', (value) => {
    expect(parseCheckShard(value)).toBeNull();
  });

  it.each([
    { command: 'check', value: '0/4' },
    { command: 'check', value: '5/4' },
    { command: 'serve', value: '1/4' },
  ])('refuses $command --shard $value before starting a local stack', ({ command, value }) => {
    const result = spawnSync(process.execPath, [MAIN, command, '--shard', value], {
      encoding: 'utf8',
      timeout: 5000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--shard needs index/total');
    expect(result.stderr).not.toContain('the stack did not start');
  });
});
