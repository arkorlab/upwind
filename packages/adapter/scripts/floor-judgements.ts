/**
 * What `isBeforeSecurityFloor` (`@stayingupwind/core/next`) has to answer, held apart from the
 * rest of `check-patches.ts`, which runs it with its other declarations.
 */
import {
  isBeforeSecurityFloor,
  SECURITY_CANARY_FLOOR,
  SECURITY_FLOOR,
} from '@stayingupwind/core/next';

/** A version, and whether `isBeforeSecurityFloor` has to call it old. */
type Judgement = [version: string, old: boolean];

/** A canary, `x.y.z-canary.N`: the release it is numbered as, and its number. */
export function canaryOf(
  version: string,
): { readonly release: readonly [number, number, number]; readonly number: number } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)-canary\.(\d+)$/u.exec(version);
  if (match === null) {
    return undefined;
  }
  const [, major = '0', minor = '0', patch = '0', number = '0'] = match;
  return { release: [Number(major), Number(minor), Number(patch)], number: Number(number) };
}

/**
 * What `isBeforeSecurityFloor` has to answer, whatever the floor is.
 *
 * The warnings it decides are the only thing that tells a build or a development run that its
 * Next.js is missing fixes, and a comparison that quietly stopped working would take them both out
 * at once while every check here still passed. So the edges it is written for are asked here, where
 * CI already runs: the floor itself and a prerelease of it, something under it, something over it,
 * and the two kinds of string that are not a release at all.
 *
 * Phrased against `SECURITY_FLOOR` rather than against literal versions, so moving the floor does
 * not come with a table of expectations to move with it.
 */
/** The canaries around `SECURITY_CANARY_FLOOR`, phrased against it as the rest are against the floor. */
function canaryJudgements(): Judgement[] {
  const canary = canaryOf(SECURITY_CANARY_FLOOR);
  if (canary === undefined) {
    // `checkDeclarations` says what is wrong with it; there is nothing here to judge against.
    return [];
  }
  const numbered = canary.release.join('.');
  const before: Judgement[] =
    canary.number > 0
      ? [
          [`${numbered}-canary.0`, true],
          [`${numbered}-canary.${String(canary.number - 1)}`, true],
        ]
      : [];
  return [
    ...before,
    [SECURITY_CANARY_FLOOR, false],
    [`${numbered}-canary.${String(canary.number + 1)}`, false],
    [`${String(canary.release[0])}.${String(canary.release[1] + 1)}.0-canary.0`, false],
    ['0.0.0-canary.0', true],
  ];
}

export function floorJudgements(): string[] {
  const expected: readonly Judgement[] = [
    // A version is not older than itself, and a prerelease is judged by the release it is numbered
    // as — a canary of the floor is not a build without the fixes.
    [SECURITY_FLOOR, false],
    [`${SECURITY_FLOOR}-canary.1`, false],
    ['0.0.0', true],
    ['999.0.0', false],
    // Not a release, and so nothing to warn about. The numbers have to be *under* the floor for the
    // first of these to mean anything: a pattern that read the leading numbers and stopped would
    // call it old, where the same suffix on the floor itself comes out equal either way and pins
    // nothing. The second matches no pattern at all, and is here for the path it takes.
    ['0.0.0garbage', false],
    ['not a version', false],
    // A canary is numbered as the minor it leads to, and the ones of `SECURITY_CANARY_FLOOR`'s
    // release that came before it still carry what the floor fixes; that canary, and the ones after
    // it, do not. A canary of an earlier release is judged by the release, which is under the floor.
    ...canaryJudgements(),
  ];
  const problems: string[] = [];
  for (const [version, old] of expected) {
    if (isBeforeSecurityFloor(version) !== old) {
      problems.push(
        `isBeforeSecurityFloor("${version}") is ${String(!old)} against a floor of ${SECURITY_FLOOR} (${SECURITY_CANARY_FLOOR} for its canaries), and has to be ${String(old)}`,
      );
    }
  }
  return problems;
}
