import { order, releaseOf } from './releases.ts';

/**
 * What is known here about Next.js's own releases, rather than about a deployment.
 *
 * In this package because two things say it and neither is the other's to reach for: the adapter,
 * once a build is written (`reportWhatTravels`), and `upwind dev`, once the development server is
 * ready. A floor declared in both is a floor that gets moved in one of them, and what it says is a
 * security claim — so it is declared where both already look.
 */

/**
 * The newest Next.js release carrying security fixes that this release of upwind knows of: 16.4.1,
 * Next.js's security update of 2026-10-14, which is the only release of those fixes — none was made
 * for 16.3 or 16.2.
 *
 * Not a bound of the range the adapter supports (`SUPPORTED_NEXT_RANGE`, `@stayingupwind/adapter`'s
 * `patches/versions.ts`), and not a version anything here refuses. That range's floor is where the
 * Adapter API became stable, which is a question about shapes rather than about advisories, and a
 * project that has to stay on 16.2 is better served by a deployment that works and says what it is
 * than by a build that will not run. So the range admits releases with advisories against them, and
 * what a build and a development run do about it is say so.
 *
 * What a deployment is told to go and get is in Next.js's own code, which travels into a Function
 * whole: the React Server Components transport Next.js vendors, which reads back what a `use cache`
 * function returned and what is sent to a Server Action. A development run has one of its own that
 * only it is exposed to: the image optimizer, which `upwind dev` hands a request that a deployment
 * answers itself.
 *
 * **This moves with every Next.js release that carries security fixes**, and that is the one thing
 * here nobody is told. `packages/adapter/scripts/check-patches.ts` holds it to being inside the
 * adapter's range, which catches a floor no build could be judged against; no check anywhere knows
 * that a newer release exists.
 */
export const SECURITY_FLOOR = '16.4.1';

/**
 * Where the release above is written up, for a warning to send a reader to. It names the release
 * `SECURITY_FLOOR` is, so it moves when that moves: a floor raised past the advisory it points at
 * would send a reader to the fixes they already have.
 */
export const SECURITY_RELEASE_URL =
  'https://nextjs.org/blog/nextjs-security-update-october-14-2026';

/**
 * The first canary carrying the fixes `SECURITY_FLOOR` carries: 16.5.0-canary.14, the first built
 * with the React that has them (react/react#37846, taken in by vercel/next.js#100215).
 *
 * A canary is numbered as the minor it leads to, so 16.5.0-canary.0 to .13 are numbered past
 * `SECURITY_FLOOR` and are still not past its fixes: published from 2026-10-06 to 2026-10-15, the
 * last three of them after 16.4.1 itself, they carry the React from before them. A canary of this
 * one's minor is held to this rather than to the floor; a canary of an earlier minor is judged by
 * the release it is numbered as, which is under the floor; and one of a later minor is cut after
 * this one, so after the fixes as well.
 *
 * Moves with `SECURITY_FLOOR`, to the first canary that carries the next release's fixes.
 */
export const SECURITY_CANARY_FLOOR = '16.5.0-canary.14';

/** The release or canary a version is held to and falls short of: what a warning names. */
export interface SecurityFloor {
  readonly version: string;
  /** Whether it is `SECURITY_CANARY_FLOOR`, which is the first canary with the fixes. */
  readonly canary: boolean;
}

/**
 * The floor `version` falls short of, where it falls short of one.
 *
 * A canary of `SECURITY_CANARY_FLOOR`'s release is held to that canary. Any other prerelease is
 * judged by the release it is numbered as, since that is the version it is about to be:
 * `16.4.0-canary.N` is under the floor, and an `rc` of 16.5.0 comes after its canaries. A version
 * this cannot read is not called old either — a warning nobody can act on is worse than no warning
 * at all.
 */
export function securityFloorOf(version: string): SecurityFloor | undefined {
  const asked = releaseOf(version);
  const floor = releaseOf(SECURITY_FLOOR);
  const canaryFloor = releaseOf(SECURITY_CANARY_FLOOR);
  if (asked === undefined || floor === undefined || canaryFloor?.canary === undefined) {
    return undefined;
  }
  if (asked.canary !== undefined && order(asked, canaryFloor) === 0) {
    return asked.canary < canaryFloor.canary
      ? { version: SECURITY_CANARY_FLOOR, canary: true }
      : undefined;
  }
  return order(asked, floor) < 0 ? { version: SECURITY_FLOOR, canary: false } : undefined;
}

/** Whether `version` falls short of the security floor it is held to (`securityFloorOf`). */
export function isBeforeSecurityFloor(version: string): boolean {
  return securityFloorOf(version) !== undefined;
}
