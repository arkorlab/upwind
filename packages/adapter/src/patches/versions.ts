/**
 * The Next.js this adapter supports, in one place.
 *
 * What settles the range is the patches beside this file. They are rewrites of Next.js's own
 * output, matched by text, so a version is supported when every one of them still finds what it
 * expects — which is a question with an answer, not an opinion: `scripts/check-patches.ts` applies
 * each patch to each published release in this range and fails on the first that does not fire.
 * The range is therefore checked across its whole width rather than asserted at its top.
 *
 * The floor is the Adapter API this adapter is written against. Three things arrived in 16.3: the
 * prerender classification (`routeType`, `response`, `compute`, `htmlSize`), which the bundle
 * takes as optional and the edge reads to decide what it may serve; a prerender's source `route`;
 * and `routing.middlewareMatchers`. The bundle requires the last two, so a 16.2 build has nothing
 * to fill them with — see the adapter's README, "Not supported, and not prepared for", for what
 * reaching down to 16.2 would take. Below that the hook is `experimental.adapterPath` and hands
 * `ctx.routes`, a different shape altogether, with no `@next/routing` release to resolve it and
 * no `edgeRuntime` metadata to build an edge bundle from.
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
export const SUPPORTED_NEXT_RANGE = '>=16.3.0 <17';
