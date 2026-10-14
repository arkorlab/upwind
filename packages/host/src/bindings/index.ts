/**
 * The bindings a deployment's Worker is given beside its own environment, by whatever deploys it,
 * for the cache and the bundle reader it runs with: the names both sides read, and the origins a
 * request over a service binding is built on.
 */

/**
 * The cache gateway, as a service binding: the cache Worker's default entrypoint.
 *
 * The default entrypoint and not a named one, deliberately. Placement acts on a Worker's `fetch`
 * handler and on nothing else — "Placement only affects the execution of fetch event handlers. It
 * does not affect RPC methods or named entrypoints" (Cloudflare, "Placement") — and a host may
 * place this gateway beside the authority it makes several round trips to. A named entrypoint here
 * would move that work to wherever the calling application happens to run.
 */
export const CACHE_SERVICE_BINDING = 'ARKOR_CACHE';
/** The KV read gateway as a service binding: a Worker of its own, which asks for no placement. */
export const CACHE_READ_SERVICE_BINDING = 'ARKOR_CACHE_READ';
/**
 * Where the Worker reaches the cache gateway when it was given no service binding: the cache
 * Worker's URL. A deployment is given one or the other and never both (`cacheBindings`,
 * `@stayingupwind/deploy/bindings`), so a private cache Worker can never be reached for by name.
 */
export const CACHE_GATEWAY_URL_BINDING = 'ARKOR_CACHE_GATEWAY_URL';
/** The KV-only gateway at the edge; the regional gateway still owns mutations and tag sync. */
export const CACHE_READ_GATEWAY_URL_BINDING = 'ARKOR_CACHE_READ_GATEWAY_URL';
/** The token that opens the deployment's own scope, and no other. A secret binding. */
export const CACHE_TOKEN_BINDING = 'ARKOR_CACHE_TOKEN';
/**
 * Next.js's own: the milliseconds its minimal-mode response cache keeps a render
 * (`server/response-cache`, ten seconds where unset). One, the least it takes — it reads nothing
 * but a positive integer, and falls back to its default for anything else — so a regeneration
 * asked for a moment after a render is never answered from that cache.
 */
export const RESPONSE_CACHE_TTL_BINDING = 'NEXT_PRIVATE_RESPONSE_CACHE_TTL';
export const RESPONSE_CACHE_TTL_MS = '1';
/** The deployment's id, which Next.js reads as its own: what its assets carry as `?dpl`. */
export const DEPLOYMENT_ID_BINDING = 'NEXT_DEPLOYMENT_ID';
/** Tells the application where it runs, for the few things it does differently there. */
export const RUNTIME_BINDING = 'ARKOR_RUNTIME';
/**
 * Where a deployment's Worker reads one blob of its **own bundle** that the build left out of it:
 * the prefetch Worker's default entrypoint.
 *
 * The adapter leaves a build's prefetch segments out of the Function, where they can be a large
 * share of its bytes, and the edge serves those prefetches from the artifacts the deployment was
 * published with. What this is for is the handful the edge could not: a middleware that failed, an
 * edge with no manifest to read, a request that reached the Worker without the edge serving the
 * prefetch at all. Nothing on a working path reaches it — and not a draft request either, which the
 * runtime renders whole.
 *
 * A binding and not a URL: Next.js replaces `globalThis.fetch` with one that reads the render's
 * stores, and an uncached call from a render hangs. A binding's `fetch` is not that global.
 *
 * No token beside it. The Worker answers bytes by their own sha256 and nothing else — no listing,
 * no prefix — so a caller can ask only for what it already holds the hash of, and a Function's
 * bundle names its own. There is nothing one deployment could learn from another's hash that the
 * hash itself does not already contain.
 */
export const PREFETCH_SERVICE_BINDING = 'ARKOR_PREFETCH';
/**
 * The one path that Worker answers, with the sha256 after it. Here rather than in either side's
 * own source because it is the whole of the protocol between them: the prefetch Worker builds its
 * key from what follows this, and a deployment's Worker builds the request. Two spellings and the
 * second one 404s.
 */
export const PREFETCH_BLOB_PATH = '/v1/blobs/';
/**
 * The origins requests are built on when they travel over a service binding.
 *
 * A binding takes a whole `Request`, so a URL still has to be written even though nothing
 * resolves it — the call never leaves the Cloudflare server it was made on. These names are
 * unresolvable on purpose: `.internal` is not a delegated top-level domain, so a request that
 * escaped a binding and went out through `fetch` fails loudly instead of reaching something.
 *
 * Every Worker on the far side routes on the path alone and reads no `Host`, which is what makes
 * a stand-in name safe; none of them keys the Cache API on the request either.
 */
export const CACHE_INTERNAL_ORIGIN = 'https://cache.upwind.internal';
export const CACHE_READ_INTERNAL_ORIGIN = 'https://cache-read.upwind.internal';
export const PREFETCH_INTERNAL_ORIGIN = 'https://prefetch.upwind.internal';

/**
 * The binding a standalone edge reaches one of a deployment's Functions by: its script name after
 * `APP__`, with every character a binding's name cannot hold made `_`. Two names that differ only
 * there are one binding, so whatever deploys names its Functions apart in what a binding can hold.
 * Here rather than in the edge alone, as whatever deploys binds each Function under it.
 */
export function functionBinding(scriptName: string): `APP__${string}` {
  return `APP__${scriptName.replaceAll(/\W/gu, '_')}`;
}
