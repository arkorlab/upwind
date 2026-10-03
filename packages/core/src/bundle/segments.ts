import { mayHoldForDocument } from '../request/conditions.ts';
import type { DeploymentBundle, Prerender } from './schema.ts';
import {
  beforeFilesPhases,
  edgeServablePrerenders,
  headerPhases,
  primaryPrerenders,
  reproducesDynamicRouting,
  type ServableOptions,
} from './serving.ts';

/**
 * Which of a build's router prefetches a host can answer from its own storage.
 *
 * A prefetch asks for part of a page rather than the page — `rsc: 1` with a
 * `next-router-segment-prefetch` naming which part — and the build writes the bytes for each part
 * beside the page's document. They are addressable before any request, so a host that holds a
 * page's document can hold its prefetches too, and every one it holds is a request the deployment's
 * Function is not woken for.
 *
 * What is served, and under which headers, is `serving.ts`; this is the one question that file does
 * not answer, kept beside it.
 */

/**
 * The patterns of the rules only the client's router meets — a header rule or a claim whose `has`
 * names one of its headers — in a build whose routing the edge does not reproduce; none where it
 * does, since there the edge judges every rule on every request.
 *
 * Such a rule never applies to a page's document (`mayHoldForDocument`), so the document can be the
 * edge's. The router's own requests for the page's parts are exactly what it does apply to — Next.js
 * sets its deployment id on every RSC response this way — and the manifest of such a build carries
 * no conditional rule for the edge to apply, so the parts of a page one covers stay with the Function
 * (`prefetchSegments`).
 */
function routerRulePatterns(bundle: DeploymentBundle): RegExp[] {
  if (reproducesDynamicRouting(bundle)) {
    return [];
  }
  return [
    ...headerPhases(bundle).filter((rule) => rule.headers !== undefined),
    ...beforeFilesPhases(bundle),
  ].flatMap((rule) =>
    mayHoldForDocument(rule)
      ? []
      : // Compiled by Next.js for its own router, which runs them without the unicode flag.
        // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
        [new RegExp(rule.sourceRegex)],
  );
}

/** A prefetch segment a host can answer with, and the document it is a prefetched part of. */
export interface PrefetchSegment {
  /** The value of `next-router-segment-prefetch` this answers. */
  readonly segmentPath: string;
  /** The document prerender it belongs to, which names the route it is asked for under. */
  readonly document: Prerender;
  /** The prerender holding the segment's own bytes. */
  readonly prerender: Prerender;
}

/**
 * The prefetch segments a host can answer itself, under the same delivery its documents are served
 * under.
 *
 * Only the segments of a document the host itself serves. A page left to the Function — its path
 * claimed by a rule of `next.config`, a template the edge cannot resolve, a header it cannot judge
 * — must have its prefetches left there as well: answering the parts from one place and the whole
 * from another lets the two disagree about the page, and a navigation then lands on something the
 * document it started from did not describe. `options` is passed through so the caller asks the one
 * question here that it asked of its documents, rather than a second question of its own.
 *
 * Nor the segments of a document a rule only the client's router meets covers, in a build whose
 * routing the host does not reproduce (`routerRulePatterns`): the rule is set aside for the
 * document, which no router request asks for, and applies to every prefetch of its parts, which the
 * host has no rule to apply with.
 *
 * A bundle from before a segment's path was recorded yields none, which is the right answer for a
 * host that cannot tell which output is which: its Function answers every prefetch, as it did.
 */
export function prefetchSegments(
  bundle: DeploymentBundle,
  options: ServableOptions = {},
): PrefetchSegment[] {
  const served = new Set(edgeServablePrerenders(bundle, options).map((prerender) => prerender.id));
  const documents = primaryPrerenders(bundle.prerenders);
  const routerRules = routerRulePatterns(bundle);
  const servesParts = (document: Prerender): boolean =>
    served.has(document.id) && routerRules.every((rule) => !rule.test(document.pathname));
  return bundle.prerenders.flatMap((prerender) => {
    const { segmentPath } = prerender;
    const document = documents.get(prerender.id);
    if (segmentPath === undefined || prerender.body === undefined) {
      return [];
    }
    return document === undefined || !servesParts(document)
      ? []
      : [{ segmentPath, document, prerender }];
  });
}
