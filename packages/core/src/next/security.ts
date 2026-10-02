/**
 * What is known here about Next.js's own releases, rather than about a deployment.
 *
 * In this package because two things say it and neither is the other's to reach for: the adapter,
 * once a build is written (`reportWhatTravels`), and `upwind dev`, once the development server is
 * ready. A floor declared in both is a floor that gets moved in one of them, and what it says is a
 * security claim — so it is declared where both already look.
 */

/**
 * The newest Next.js release carrying security fixes that this release of upwind knows of: 16.3.8,
 * Next.js's September 2026 security release.
 *
 * Not a bound of the range the adapter supports (`SUPPORTED_NEXT_RANGE`, `@stayingupwind/adapter`'s
 * `patches/versions.ts`), and not a version anything here refuses. That range's floor is where the
 * Adapter API became stable, which is a question about shapes rather than about advisories, and a
 * project that has to stay on 16.2 is better served by a deployment that works and says what it is
 * than by a build that will not run. So the range admits releases with advisories against them, and
 * what a build and a development run do about it is say so.
 *
 * What a deployment is told to go and get is in Next.js's own code, which travels into a Function
 * whole: `use cache` keying, its draft-mode fills, and the ownership checks a route template makes
 * of a prerender it is about to treat as its own. A development run has two of its own that only it
 * is exposed to: the development server's MCP endpoint, and the image optimizer, which `upwind dev`
 * hands a request that a deployment answers itself.
 *
 * **This moves with every Next.js release that carries security fixes**, and that is the one thing
 * here nobody is told. `packages/adapter/scripts/check-patches.ts` holds it to being inside the
 * adapter's range, which catches a floor no build could be judged against; no check anywhere knows
 * that a newer release exists.
 */
export const SECURITY_FLOOR = '16.3.8';

/**
 * Where the release above is written up, for a warning to send a reader to. It names the release
 * `SECURITY_FLOOR` is, so it moves when that moves: a floor raised past the advisory it points at
 * would send a reader to the fixes they already have.
 */
export const SECURITY_RELEASE_URL = 'https://nextjs.org/blog/september-2026-security-release';

/** `major.minor.patch`, and nothing a prerelease suffix adds to it. */
const RELEASE = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u;

interface Release {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function releaseOf(version: string): Release | undefined {
  const groups = RELEASE.exec(version)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  return {
    major: Number(groups['major']),
    minor: Number(groups['minor']),
    patch: Number(groups['patch']),
  };
}

function order(a: Release, b: Release): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether `version` is before `SECURITY_FLOOR`.
 *
 * A prerelease is judged by the release it is numbered as, since that is the version it is about to
 * be: `16.4.0-canary.N` is past the floor and nothing is said about it. A version this cannot read
 * is not called old either — a warning nobody can act on is worse than no warning at all.
 */
export function isBeforeSecurityFloor(version: string): boolean {
  const asked = releaseOf(version);
  const floor = releaseOf(SECURITY_FLOOR);
  if (asked === undefined || floor === undefined) {
    return false;
  }
  return order(asked, floor) < 0;
}
