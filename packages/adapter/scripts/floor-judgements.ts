/**
 * What `securityFloorOf` (`@stayingupwind/core/next`) has to answer, held apart from the rest of
 * `check-patches.ts`, which runs it with its other declarations.
 */
import {
  isBeforeSecurityFloor,
  SECURITY_CANARY_FLOOR,
  SECURITY_FLOOR,
  type SecurityFloor,
  securityFloorOf,
} from '@stayingupwind/core/next';

/** The floors a warning can name: the release, and the first canary carrying its fixes. */
const RELEASE_FLOOR: SecurityFloor = { version: SECURITY_FLOOR, canary: false };
const CANARY_FLOOR: SecurityFloor = { version: SECURITY_CANARY_FLOOR, canary: true };

/** A version, and the floor it has to be held to and fall short of: none, where it is past it. */
type Judgement = [version: string, floor: SecurityFloor | undefined];

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
          [`${numbered}-canary.0`, CANARY_FLOOR],
          [`${numbered}-canary.${String(canary.number - 1)}`, CANARY_FLOOR],
        ]
      : [];
  return [
    ...before,
    [SECURITY_CANARY_FLOOR, undefined],
    [`${numbered}-canary.${String(canary.number + 1)}`, undefined],
    [`${String(canary.release[0])}.${String(canary.release[1] + 1)}.0-canary.0`, undefined],
    ['0.0.0-canary.0', RELEASE_FLOOR],
  ];
}

function described(floor: SecurityFloor | undefined): string {
  if (floor === undefined) {
    return 'no floor';
  }
  return `${floor.version}${floor.canary ? ', as a canary' : ''}`;
}

/**
 * What `securityFloorOf` has to answer, whatever the floors are.
 *
 * The warnings it decides are the only thing that tells a build or a development run that its
 * Next.js is missing fixes, and a comparison that quietly stopped working would take them both out
 * at once while every check here still passed. So the edges it is written for are asked here, where
 * CI already runs: the floor itself and a prerelease of it, something under it, something over it,
 * the two kinds of string that are not a release at all, and the canaries either side of the first
 * canary carrying the floor's fixes. Each is held to the floor a warning would name, and as what,
 * not only to whether it warns: a warning that named the wrong one would send a reader to the wrong
 * upgrade.
 *
 * Phrased against `SECURITY_FLOOR` and `SECURITY_CANARY_FLOOR` rather than against literal versions,
 * so moving the floors does not come with a table of expectations to move with them.
 */
export function floorJudgements(): string[] {
  const expected: readonly Judgement[] = [
    // A version is not older than itself, and a prerelease is judged by the release it is numbered
    // as — a canary of the floor is not a build without the fixes.
    [SECURITY_FLOOR, undefined],
    [`${SECURITY_FLOOR}-canary.1`, undefined],
    ['0.0.0', RELEASE_FLOOR],
    ['999.0.0', undefined],
    // Not a release, and so nothing to warn about. The numbers have to be *under* the floor for the
    // first of these to mean anything: a pattern that read the leading numbers and stopped would
    // call it old, where the same suffix on the floor itself comes out equal either way and pins
    // nothing. The second matches no pattern at all, and is here for the path it takes.
    ['0.0.0garbage', undefined],
    ['not a version', undefined],
    // A canary is numbered as the minor it leads to, and the ones of `SECURITY_CANARY_FLOOR`'s
    // release that came before it still carry what the floor fixes; that canary, and the ones after
    // it, do not. A canary of an earlier release is judged by the release, which is under the floor.
    ...canaryJudgements(),
  ];
  const problems: string[] = [];
  for (const [version, floor] of expected) {
    const held = securityFloorOf(version);
    const old = isBeforeSecurityFloor(version);
    if (
      old !== (floor !== undefined) ||
      held?.version !== floor?.version ||
      held?.canary !== floor?.canary
    ) {
      problems.push(
        `securityFloorOf("${version}") is ${described(held)} and isBeforeSecurityFloor ${String(old)}; they have to be ${described(floor)} and ${String(floor !== undefined)}`,
      );
    }
  }
  return problems;
}
