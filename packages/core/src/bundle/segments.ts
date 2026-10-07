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
import { isTemplate } from './spelling.ts';

/**
 * Which of a build's router requests a host can answer from its own storage: the prefetches of a
 * page's parts, and the whole payload of a page the build finished.
 *
 * A prefetch asks for part of a page rather than the page — `rsc: 1` with a
 * `next-router-segment-prefetch` naming which part — and the build writes the bytes for each part
 * beside the page's document; it writes the page's whole payload there too, which a navigation
 * asks for with `rsc: 1` alone. They are addressable before any request, so a host that holds a
 * page's document can hold these too, and every one it holds is a request the deployment's
 * Function is not woken for.
 *
 * What is served, and under which headers, is `serving.ts`; this is the one question that file does
 * not answer, kept beside it.
 */

const HTTP_OK = 200;

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
      : // Compiled by Next.js for its own router, which runs them without the unicode flag and
        // without regard to case, as `mayRoutePath` does: a rule for `/Account` covers `/account`.
        // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
        [new RegExp(rule.sourceRegex, 'i')],
  );
}

/**
 * Whether a host answers the router's requests for a document's parts and its payload beside the
 * document: one it serves itself, and one no rule only the client's router meets covers
 * (`routerRulePatterns`).
 */
function partsServed(
  bundle: DeploymentBundle,
  options: ServableOptions,
): (document: Prerender) => boolean {
  const served = new Set(edgeServablePrerenders(bundle, options).map((prerender) => prerender.id));
  const routerRules = routerRulePatterns(bundle);
  return (document) =>
    served.has(document.id) && routerRules.every((rule) => !rule.test(document.pathname));
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
  const documents = primaryPrerenders(bundle.prerenders);
  const servesParts = partsServed(bundle, options);
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

/** A page's whole payload a host can answer with, and the document it is the payload of. */
export interface RoutePayload {
  /** The document prerender it is the payload of, which names the route it is asked for under. */
  readonly document: Prerender;
  /** The prerender holding the payload's own bytes. */
  readonly prerender: Prerender;
}

/** The pathname a document's payload is named after: the build names the root's `/index`. */
function payloadBase(pathname: string): string {
  return pathname === '/' ? '/index' : pathname;
}

/**
 * The payloads a host can answer a router's request for a whole page with: the twin the build
 * wrote beside a document it finished (`<pathname>.rsc`, in the document's own group), complete in
 * itself, which is what the deployment's Function answers such a request with from the build.
 *
 * Only of a page whose document the host serves complete. A page a resume completes has its
 * payload rendered for the request as its document is, and a class shell's twin is the payload of
 * the class's shell rather than of the member asked for. Under the conditions the parts of a page
 * are answered under (`partsServed`), for the same reasons: a host answers a page's parts and the
 * page itself from the same place, or neither.
 *
 * A twin with a status of its own is left out. The build gives a payload none — a redirect or a
 * `notFound()` is carried in it, for the client's router to follow — and the host answers `200`.
 */
export function routePayloads(
  bundle: DeploymentBundle,
  options: ServableOptions = {},
): RoutePayload[] {
  const servesParts = partsServed(bundle, options);
  const byPathname = new Map(bundle.prerenders.map((prerender) => [prerender.pathname, prerender]));
  const { suffix } = bundle.routing.rsc;
  return bundle.prerenders.flatMap((document) => {
    if (document.postponed !== undefined || isTemplate(document.pathname)) {
      return [];
    }
    if (!servesParts(document)) {
      return [];
    }
    const twin = byPathname.get(`${payloadBase(document.pathname)}${suffix}`);
    const own = twin?.route === document.route && twin.groupId === document.groupId;
    const whole =
      twin?.body !== undefined &&
      twin.postponed === undefined &&
      (twin.initialStatus === undefined || twin.initialStatus === HTTP_OK);
    return own && whole ? [{ document, prerender: twin }] : [];
  });
}
