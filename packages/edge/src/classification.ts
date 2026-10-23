import type { ProjectManifest } from '@stayingupwind/core/manifest';
import type { RequestClass } from '@stayingupwind/core/request';

/** Signed candidate probes prove build shells, never visitor-facing generation records. */
export function manifestForClassification(
  manifest: ProjectManifest,
  validated: boolean,
): ProjectManifest {
  if (!validated || (manifest.staticPages === undefined && manifest.pagesFallbacks === undefined))
    return manifest;
  return { ...manifest, staticPages: undefined, pagesFallbacks: undefined };
}

const ASSET_CLASS = 'immutable-asset-candidate';
const ROUTE_BODY_CLASS = 'route-body';
const STATIC_PAGE_CLASS = 'static-page';
const STATIC_FILE_CLASS = 'static-file';
/** A request that names no route of the build may still be served one after the middleware. */
const ROUTE_NOT_PROVED = 'route-not-proved';

export function servedAtEdge(classification: RequestClass): boolean {
  switch (classification.kind) {
    case 'document':
    case ROUTE_BODY_CLASS:
    case STATIC_PAGE_CLASS:
    case 'pages-fallback':
    case ASSET_CLASS: {
      return true;
    }
    case STATIC_FILE_CLASS: {
      // Never classified here: a file the build shipped is answered before the pointer's mode is
      // looked at (`hostedFirst`), by the same reading of the request (`classifyStaticFile`), and
      // a request with no Workers or no manifest leaves before it is classified.
      return false;
    }
    case 'passthrough': {
      // The middleware may still rewrite it onto a route the build prerendered.
      return classification.reason === ROUTE_NOT_PROVED;
    }
    case 'segment-prefetch': {
      // Taken in whatever this request's own route names, and left to `routeHostedDocument` to
      // answer or hand on: the middleware is what decides the route, so what the client asked for
      // says little about what holds the part. The root of a localised application is a rewrite to
      // `/en` or `/ja` and names no route at all, and a route that names no parts may still be
      // rewritten onto one that does.
      //
      // Refusing the ones that name no parts was tried, to spare a build with none the middleware.
      // It spared nothing: where no matcher covers the path the middleware does not run either way
      // (`middlewareMatches` decides that there), and where one does, that is the rewrite this
      // exists to follow. What the coverage costs is one middleware subrequest on a prefetch of a
      // matched path that turns out to hold no part — and the Function runs the middleware anyway.
      return true;
    }
    case 'rsc-payload': {
      // Taken by the route its own URL names, which holds a payload to answer with: the middleware
      // may still put the request on another route, as it may a prefetch's (`routeHostedDocument`).
      return true;
    }
    case 'pages-data': {
      // Taken by the page whose props the build wrote, unless a middleware is to run for it, which
      // `routeHostedDocument` leaves to the Function rather than run in a data request's way.
      return true;
    }
    case 'rsc':
    case 'action': {
      return false;
    }
  }
}
