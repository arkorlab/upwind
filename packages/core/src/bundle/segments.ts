import type { DeploymentBundle, Prerender } from './schema.ts';
import { edgeServablePrerenders, primaryPrerenders, type ServableOptions } from './serving.ts';

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
 * A bundle from before a segment's path was recorded yields none, which is the right answer for a
 * host that cannot tell which output is which: its Function answers every prefetch, as it did.
 */
export function prefetchSegments(
  bundle: DeploymentBundle,
  options: ServableOptions = {},
): PrefetchSegment[] {
  const served = new Set(edgeServablePrerenders(bundle, options).map((prerender) => prerender.id));
  const documents = primaryPrerenders(bundle.prerenders);
  return bundle.prerenders.flatMap((prerender) => {
    const { segmentPath } = prerender;
    const document = documents.get(prerender.id);
    if (segmentPath === undefined || prerender.body === undefined) {
      return [];
    }
    return document === undefined || !served.has(document.id)
      ? []
      : [{ segmentPath, document, prerender }];
  });
}
