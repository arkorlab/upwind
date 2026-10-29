import { describe, expect, it } from 'vitest';

import { FIXTURE_COVERAGE, type FixtureCoverage } from '../src/coverage.ts';
import { checkFixtureVersions, selectFixtures } from '../src/selection.ts';

const fixtures = Object.entries(FIXTURE_COVERAGE).map(([name, coverage]) => {
  const entry: FixtureCoverage & { readonly name: string } = { name, ...coverage };
  return entry;
});

describe('dedicated proof fixture selection', () => {
  it('keeps the supported-range default selection free of pinned proofs', () => {
    const selected = selectFixtures(fixtures, undefined);

    expect(selected.map((fixture) => fixture.name)).toStrictEqual([
      'next-websocket',
      'next-edge-instrumentation-baseline',
      'next-edge-instrumentation',
      'next-edge-instrumentation-no-own',
      'next-external-output',
      'next-minimal',
      'next-edge',
      'next-workflow',
      'next-use-cache-concurrency',
    ]);
    expect(() => {
      checkFixtureVersions(selected, ['16.2.0', '16.3.0', '16.4.2']);
    }).not.toThrow();
  });

  it.each(fixtures.filter((fixture) => fixture.proofVersion !== undefined))(
    'runs $name only for an explicit name and its exact resolved version',
    (fixture) => {
      const selected = selectFixtures(fixtures, fixture.name);

      expect(selected.map((entry) => entry.name)).toStrictEqual([fixture.name]);
      expect(() => {
        checkFixtureVersions(selected, [fixture.proofVersion ?? '']);
      }).not.toThrow();
      expect(() => {
        checkFixtureVersions(selected, ['unsupported']);
      }).toThrow('dedicated proof');
    },
  );

  it('rejects unknown names and every mismatched explicit version instead of reporting success', () => {
    const selected = selectFixtures(fixtures, 'next-twoslash');

    expect(() => selectFixtures(fixtures, 'missing')).toThrow('no fixture named "missing"');
    expect(() => {
      checkFixtureVersions(selected, ['16.3.0']);
    }).toThrow('dedicated proof for next@16.4.2');
    expect(() => {
      checkFixtureVersions(selected, ['16.4.2', '16.4.2-canary.1']);
    }).toThrow('dedicated proof for next@16.4.2');
  });
});
