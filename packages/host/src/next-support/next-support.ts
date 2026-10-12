/**
 * The Next.js versions a host admits, and how much of what it serves each one gets, in a module
 * that imports nothing.
 *
 * A module of its own, apart from any schema: a bundler will not drop a schema built by a call it
 * cannot prove pure, so whatever asks only this of a deployment's build carries nothing else for
 * asking it.
 */

/**
 * The Next.js versions a host admits: the range `@stayingupwind/adapter` builds, restated as a
 * tuple.
 *
 * `@stayingupwind/adapter` declares `SUPPORTED_NEXT_RANGE = '>=16.2.0 <17'` and holds it to two
 * checks. `scripts/check-patches.ts` applies the patches that reach Next.js's own package to every
 * published release in the range and fails on the first that does not fire, so the range is checked
 * across its whole width rather than asserted at its top; `tools/next-matrix` holds the four that
 * rewrite what `next build` writes, which no package shows, to a real build. The floor is where the
 * Adapter API became stable, and the ceiling is the major its shape is allowed to change in.
 *
 * It is restated rather than read because the adapter is a build-time package: whatever deploys
 * and the Workers that gate on this must not carry it. So the two move together, whenever the
 * adapter's range does.
 *
 * The floor follows what the adapter can build, not only where the Adapter API became stable: a
 * version admitted that the adapter cannot build compiles, meets a Turbopack shape the patch does
 * not know, and fails at the end of the build with a message that reads like the application's
 * fault. 16.2 is admitted because the adapter builds it (`80f3d95`) — with less than 16.3 gives it,
 * which is `FULL_SUPPORT_NEXT_MIN`'s.
 */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- the range is the version numbers
export const SUPPORTED_NEXT_RANGE = { min: [16, 2, 0], max: [17, 0, 0] } as const;

/**
 * Where full support begins: 16.3, whose builds carry what a 16.2 build does not.
 *
 * Next.js classifies its prerenders from 16.3 on (`routeType`, `response`, `compute`), and serves
 * content-addressed `/_next/static/immutable/*`. The adapter deploys a 16.2 build without either —
 * it reads what a prerender is off the outputs themselves — so a host admits one, with limited
 * support: what it can only do by that classification, or with those files, is refused for such a
 * deployment, and the refusal says to upgrade.
 */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- the version is the numbers
export const FULL_SUPPORT_NEXT_MIN = [16, 3, 0] as const;

/**
 * How much of what a host serves a Next.js version gets: all of it, all but what needs 16.3, or
 * nothing, since a build outside the adapter's range is refused.
 */
export type NextSupport = 'full' | 'limited' | 'unsupported';

const VERSION = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u;

function versionTuple(version: string): readonly [number, number, number] | undefined {
  const groups = VERSION.exec(version)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  return [Number(groups['major']), Number(groups['minor']), Number(groups['patch'])];
}

function compareTuples(a: readonly number[], b: readonly number[]): number {
  for (const [index, element] of a.entries()) {
    const diff = element - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function nextSupportOf(version: string): NextSupport {
  const tuple = versionTuple(version);
  if (
    tuple === undefined ||
    compareTuples(tuple, SUPPORTED_NEXT_RANGE.min) < 0 ||
    compareTuples(tuple, SUPPORTED_NEXT_RANGE.max) >= 0
  ) {
    return 'unsupported';
  }
  return compareTuples(tuple, FULL_SUPPORT_NEXT_MIN) < 0 ? 'limited' : 'full';
}

export function nextVersionSupported(version: string): boolean {
  return nextSupportOf(version) !== 'unsupported';
}
