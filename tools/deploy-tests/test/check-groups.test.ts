import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { selectCheckGroups } from '../src/check-groups.ts';

const GROUPS = ['host', 'environment', 'lifecycle-workspace', 'install-manager'] as const;
const CHECK = new URL('../src/check.ts', import.meta.url).href;
/** Refuse any fixture allocation while the real CLI rejects its invalid arguments. */
const BEFORE_FIXTURES = `
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  const [entry, ...argv] = process.argv.slice(1);
  fs.mkdtempSync = () => { throw new Error('fixture allocation attempted'); };
  syncBuiltinESMExports();
  process.argv = [process.execPath, entry, ...argv];
  await import(entry);
`;

describe('deploy-hook contract check groups', () => {
  it('keeps the complete default scenario groups in their original order', () => {
    expect(selectCheckGroups([])).toStrictEqual(GROUPS);
  });

  it.each(GROUPS)('selects only the requested %s scenarios', (group) => {
    expect(selectCheckGroups(['--group', group])).toStrictEqual([group]);
  });

  it('covers every default group exactly once across the separate CI invocations', () => {
    const selected = GROUPS.flatMap((group) => selectCheckGroups(['--group', group]));

    expect(selected).toStrictEqual(selectCheckGroups([]));
    expect(new Set(selected).size).toBe(GROUPS.length);
  });

  it.each([
    { label: 'a missing group', argv: ['--group'] },
    { label: 'an unknown group', argv: ['--group', 'unknown'] },
    { label: 'an empty group', argv: ['--group', ''] },
    { label: 'a positional group', argv: ['host'] },
    { label: 'an unsupported option', argv: ['--list'] },
    { label: 'an equals option', argv: ['--group=host'] },
    { label: 'two group options', argv: ['--group', 'host', '--group', 'environment'] },
    { label: 'an extra positional group', argv: ['--group', 'host', 'environment'] },
    { label: 'an extra option', argv: ['--group', 'host', '--list'] },
  ])('rejects $label instead of skipping or repeating contract scenarios', ({ argv }) => {
    expect(() => selectCheckGroups(argv)).toThrow(/--group/u);
  });

  it.each([
    { label: 'missing', argv: ['--group'] },
    { label: 'unknown', argv: ['--group', 'unknown'] },
    { label: 'duplicate', argv: ['--group', 'host', '--group', 'environment'] },
  ])('rejects a $label CLI selector before allocating any fixture', ({ argv }) => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', BEFORE_FIXTURES, CHECK, ...argv],
      { encoding: 'utf8', timeout: 5000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage: check.ts [--group');
    expect(result.stderr).not.toContain('fixture allocation attempted');
  });
});
