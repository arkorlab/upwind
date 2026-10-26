import { generationResponseHeaders } from '../cache/response-headers.ts';
import { ROUTE_BODY_BUILD_HEADERS } from '../request/constants.ts';
import type { Prerender } from './schema.ts';
import {
  prerenderResponseHeaders,
  reproducesDynamicRouting,
  routeHandlerPrerenders,
  type ServingBundle,
} from './serving.ts';

const HTTP_OK = 200;
const BUILD_HEADERS: ReadonlySet<string> = new Set(ROUTE_BODY_BUILD_HEADERS);
const PRIVATE_CACHE_CONTROL = /(?:^|,)\s*(?:private|no-store)(?:[\s,=]|$)/iu;

/** A non-HTML media type: an HTML response keeps the document's own security policy. */
function nonHtml(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return (
    type !== undefined &&
    type !== '' &&
    !type.includes(',') &&
    type !== 'text/html' &&
    type !== 'application/xhtml+xml'
  );
}

function initialHeaders(prerender: Prerender): [string, string][] {
  const entries = Object.entries(prerender.initialHeaders ?? {});
  const headers: [string, string][] = [];
  for (const [name, values] of entries) {
    const list = typeof values === 'string' ? [values] : values;
    for (const value of list) {
      headers.push([name, value]);
    }
  }
  return headers;
}

/** The build's privacy vetoes are judged before a stored-response filter can remove them. */
function publicBody(bundle: ServingBundle, prerender: Prerender): boolean {
  if (prerender.body === undefined || !nonHtml(prerender.body.contentType)) {
    return false;
  }
  const headers = [...initialHeaders(prerender), ...prerenderResponseHeaders(bundle, prerender)];
  if (headers.some(([name, value]) => name.toLowerCase() === 'content-type' && !nonHtml(value))) {
    return false;
  }
  const stored = generationResponseHeaders('app-route', HTTP_OK, headers);
  return (
    !PRIVATE_CACHE_CONTROL.test(stored['cache-control'] ?? '') &&
    (stored['vary'] ?? '').split(',').every((value) => value.trim() !== '*')
  );
}

/**
 * Complete Node.js responses a host may serve from their current trusted route-body records.
 * Only a bundle built with the privacy-preserving runtime opts in. Older bundles remain private
 * Function responses, even when a newer host assembles their manifest again.
 */
export function edgeServableRouteBodies(bundle: ServingBundle): Prerender[] {
  if (bundle.routeBodyPrivacy !== 2 || !reproducesDynamicRouting(bundle)) {
    return [];
  }
  const kinds = new Map(bundle.entrypoints.map((entry) => [entry.pathname, entry.kind]));
  return routeHandlerPrerenders(bundle).filter((prerender) => {
    return (
      kinds.get(prerender.route) === 'app-route' &&
      prerender.routeType === 'route' &&
      prerender.response === 'complete' &&
      prerender.compute === 'static' &&
      prerender.postponed === undefined &&
      (prerender.initialStatus ?? HTTP_OK) === HTTP_OK &&
      (prerender.allowQuery?.length ?? 0) === 0 &&
      (prerender.allowHeader ?? []).every((name) => BUILD_HEADERS.has(name.toLowerCase())) &&
      publicBody(bundle, prerender)
    );
  });
}
