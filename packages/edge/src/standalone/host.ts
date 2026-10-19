import type { EdgeHost } from '../edge-host.ts';
import type { StandaloneEnv } from './env.ts';

/**
 * The names a standalone edge keeps things under between requests (`EdgeHost.names`). Each keys
 * what a data center holds, so a site that keeps one keeps it as it is: a new name is a cold cache
 * in every data center at once.
 */
export const STANDALONE_NAMES = {
  /** Under `.invalid`, which no request is served on (RFC 6761): no request finds one of these. */
  cacheKeyHost: 'cache.upwind.invalid',
  assetCache: 'upwind-admitted-assets-v1',
  imageCache: 'upwind-images-v1',
  imageKeyOrigin: 'https://images.upwind.invalid',
  recordCache: 'upwind-generation-records-v1',
  signalCache: 'upwind-scope-signals-v1',
} as const;

/**
 * No domain is shared between sites, as one edge serves one site. A `Domain=` a Function sets on a
 * cookie is judged by the site's own hostname alone, which no hostname under `.invalid` is.
 */
const NO_SHARED_DOMAIN = 'invalid';

const hosts = new WeakMap<StandaloneEnv, EdgeHost>();

/**
 * The hostnames `HOSTNAMES` lists, as a request's URL writes a hostname: in lower case, and an
 * internationalized one in its ASCII form (`xn--…`), however the list spells it. One no URL could
 * name is left out, as no request comes in under it.
 */
function hostnamesOf(listed: string | undefined): string[] {
  if (listed === undefined) {
    return [];
  }
  return listed.split(',').flatMap((spelled) => {
    const hostname = spelled.trim();
    if (hostname === '') {
      return [];
    }
    try {
      return [new URL(`http://${hostname}`).hostname];
    } catch {
      return [];
    }
  });
}

/** What a standalone edge records of what it observes (`EdgeHost.observer`): nothing. */
function unobserved(): void {
  // No host reads a standalone edge's measurements.
}

/**
 * What a standalone edge decides for itself, made once per `env`: its names; no domain shared with
 * another site; every hostname it is routed (`HOSTNAMES`) as one it answers on, so that no image
 * source there is fetched from this edge, whichever hostname a request came in on; no credentials of
 * its own to take off what it forwards; no Function that can be gone while its pointer names it,
 * since it is deployed with the ones it names; and nothing it reports.
 */
export function standaloneHost(env: StandaloneEnv): EdgeHost {
  const held = hosts.get(env);
  if (held !== undefined) {
    return held;
  }
  const signals = env.CACHE_SIGNALS;
  const currentRecord = signals?.currentRecord;
  const host: EdgeHost = {
    names: STANDALONE_NAMES,
    sharedDomain: NO_SHARED_DOMAIN,
    ownDomains: [],
    ownHostnames: hostnamesOf(env.HOSTNAMES),
    credentials: { cookies: [], headers: [] },
    functionGone: () => false,
    observer: { metric: unobserved, recordServed: unobserved, imageTransformed: unobserved },
    // Where the cache it is bound to answers what moved in a scope: a standalone cache purges no
    // copy, so the edge asks it again every moment (`ScopeSignals.announced`).
    ...(signals !== undefined && {
      scopeSignals: {
        scopeSignals: (scopeId, since) => signals.scopeSignals(scopeId, since),
        cacheTagOf: (scopeId) => `upwind-scope-${encodeURIComponent(scopeId)}`,
      },
    }),
    ...(currentRecord !== undefined && {
      currentRecord: (scopeId, entryId, afterRevision) =>
        Reflect.apply(currentRecord, signals, [scopeId, entryId, afterRevision]),
    }),
  };
  hosts.set(env, host);
  return host;
}
