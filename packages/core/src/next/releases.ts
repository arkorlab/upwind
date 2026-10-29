/**
 * A Next.js version as the numbers it is ordered by, for what this package knows about Next.js's
 * own releases (`security.ts`, `form-actions.ts`).
 */

/**
 * `major.minor.patch`, and nothing a prerelease or build suffix adds to it — but a canary's own
 * number, which is the one suffix a floor is ever kept for (`SECURITY_CANARY_FLOOR`).
 *
 * Anchored at both ends, with the suffix having to begin the way a suffix does. Reading the leading
 * numbers and stopping would make `16.3.0nonsense` a release and warn about it, and a version this
 * cannot read is one it has to say nothing about rather than guess at.
 */
const RELEASE = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?<suffix>[-+].*)?$/u;
/** A canary's suffix, `-canary.N`, with a build suffix after it where one is given. */
const CANARY = /^-canary\.(?<number>\d+)(?:\+.*)?$/u;

export interface Release {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The `N` of a `-canary.N`, for a canary; nothing for a release or another prerelease. */
  readonly canary?: number;
}

export function releaseOf(version: string): Release | undefined {
  const groups = RELEASE.exec(version)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const canary = CANARY.exec(groups['suffix'] ?? '')?.groups?.['number'];
  return {
    major: Number(groups['major']),
    minor: Number(groups['minor']),
    patch: Number(groups['patch']),
    ...(canary !== undefined && { canary: Number(canary) }),
  };
}

/** The order of two versions by the release each is numbered as, whatever their suffixes. */
export function order(a: Release, b: Release): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
