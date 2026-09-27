/**
 * The Next.js this adapter supports, in one place.
 *
 * What settles the range is the patches beside this file. They are rewrites of Next.js's own
 * output, matched by text, so a version is supported when every one of them still finds what it
 * expects — which is a question with an answer, not an opinion. `scripts/check-patches.ts` applies
 * the ten that reach Next.js's package to each published release in this range, and
 * `tools/next-matrix` builds applications for the four that rewrite what `next build` writes. The
 * range is therefore checked across its whole width rather than asserted at its top, and it is the
 * second of those that finds most of what moves: of the five differences that reaching down to
 * 16.2 turned up, four were in build output, where reading a package cannot see them.
 *
 * The floor is where the Adapter API became stable, which is 16.2. Below it the hook is
 * `experimental.adapterPath` and hands `ctx.routes`, a different shape altogether, with no
 * `@next/routing` release to resolve it and no `edgeRuntime` metadata to build an edge bundle
 * from.
 *
 * What a 16.2 build does not carry, and what that costs a deployment, is the adapter's README
 * under "Which Next.js". The short of it: two of the three things 16.3 added are filled in from
 * elsewhere, and the third — the prerender classification — is what the edge reads to decide which
 * shells it may serve, so a 16.2 deployment serves none of them from the edge.
 *
 * The ceiling is the Adapter API's own contract: its shape changes only in a major release
 * (Next.js, "Adapters"). A minor within the major is admitted on the strength of the check, which
 * is why the check runs against the canary as well. A canary is numbered as the next minor
 * (`16.4.0-canary.N`) whatever it is going to become, and which it becomes is decided when it
 * ships — so a break in one is notice and not yet a verdict: as a major it is already outside
 * this range and costs nothing, as a minor it is inside and the patch has to learn the new shape.
 *
 * `packages/adapter/package.json` and `packages/upwind/package.json` declare this same range as
 * their `peerDependencies.next`, and the check holds all three to each other.
 */
export const SUPPORTED_NEXT_RANGE = '>=16.2.0 <17';
