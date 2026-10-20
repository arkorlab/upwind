interface SelectableFixture {
  readonly name: string;
  readonly proofVersion?: string;
}

/** Dedicated, pinned proofs run only when explicitly requested, never in the supported-range matrix. */
export function selectFixtures<T extends SelectableFixture>(
  fixtures: readonly T[],
  only: string | undefined,
): readonly T[] {
  const selected = fixtures.filter((fixture) =>
    only === undefined ? fixture.proofVersion === undefined : fixture.name === only,
  );
  if (selected.length === 0) {
    const names = fixtures.map((fixture) => fixture.name).join(', ');
    throw new Error(`next-matrix: no fixture named "${only ?? ''}"; there are ${names}`);
  }
  return selected;
}

/** Reject an unsupported proof/version pair before any fixture installs or builds. */
export function checkFixtureVersions(
  fixtures: readonly SelectableFixture[],
  versions: readonly string[],
): void {
  for (const fixture of fixtures) {
    if (fixture.proofVersion === undefined) continue;
    if (versions.some((version) => version !== fixture.proofVersion)) {
      throw new Error(
        `next-matrix: ${fixture.name} is a dedicated proof for next@${fixture.proofVersion}; requested ${versions.join(', ')}`,
      );
    }
  }
}
