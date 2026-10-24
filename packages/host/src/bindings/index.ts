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
/** What `RUNTIME_BINDING` holds, and what the application compares it with: the runtime it is in. */
export const RUNTIME_NAME = 'workerd';
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

/**
 * The binding a standalone edge reaches a route's gate by (`gates`, in a deployment's manifest):
 * the gate's name after `GATE__`, upper-cased, each `-` an `_` — `GATE__CONTENT_RULES` for
 * `content-rules`. A gate's name holds nothing else (`gateNameSchema`), so no two names are one
 * binding. Here rather than in the edge alone, as whatever deploys the edge binds each gate under
 * it.
 */
export function gateBinding(name: string): `GATE__${string}` {
  return `GATE__${name.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * What the edge and a route's gate say to each other, beside the request itself: the route the
 * request is of, as the build declared it (`GATE_ROUTE_HEADER`, on the request the gate is handed),
 * and the deployment of the site it is of, where the edge's manifest names one
 * (`GATE_DEPLOYMENT_HEADER`: its `deployment.dplId`, which a gate's answer made of another
 * deployment's page is no answer to); and, on the gate's answer, that the request is to be served
 * as though there were no gate (`GATE_ANSWER_HEADER` set to `GATE_PASS`) — a `GET` handed to the
 * route's Function as a capture where the gate says so beside it (`GATE_CAPTURE_HEADER` set to
 * `GATE_CAPTURE`) — or that the visitor is to be served the shell its body is, of the gate's own,
 * completed by the route's Function (`GATE_ANSWER_HEADER` set to `GATE_SHELL`, `gate-shell.ts`) —
 * which a gate answers only a request its host says it would serve one for (`GATE_ACCEPT_HEADER`
 * set to `GATE_SHELL`), in no content coding (a host serves one its fetch undid of gzip or br, as
 * workerd's does, and refuses any other). A gate that decides nothing else of its route says so
 * beside a pass (`GATE_SCOPE_HEADER` set to `GATE_SCOPE_DOCUMENTS`), and its host may let the route's
 * other requests go on unasked, but one that says it is to be captured (`GATE_CAPTURE_HEADER` set
 * to `GATE_CAPTURE`, on the request). Every name begins `GATE_HEADER_PREFIX`, which no visitor's
 * request carries on to a gate: what a gate is told of a request, its host tells it.
 */
export const GATE_HEADER_PREFIX = 'x-upwind-gate';
export const GATE_ROUTE_HEADER = 'x-upwind-gate-route';
export const GATE_DEPLOYMENT_HEADER = 'x-upwind-gate-deployment';
export const GATE_ANSWER_HEADER = 'x-upwind-gate';
export const GATE_PASS = 'pass';
export const GATE_SHELL = 'shell';
export const GATE_CAPTURE_HEADER = 'x-upwind-gate-capture';
export const GATE_ACCEPT_HEADER = 'x-upwind-gate-accept';
export const GATE_SCOPE_HEADER = 'x-upwind-gate-scope';
export const GATE_SCOPE_DOCUMENTS = 'documents';
export const GATE_CAPTURE = '1';
/**
 * What the edge tells the route's Function beside the resume that completes a gate's shell: the
 * token the gate handed with the shell for it (`GateShellHeader.resume`), as the gate wrote it. A
 * capture its gate asked for is told by the Function's own name for one (`CAPTURE_HEADER`, in
 * `@stayingupwind/core/paas`). Set after what the visitor sent under the edge's own names is taken
 * off the request: the Function reads it as the edge's word, and keeps it from what the
 * application's framework reads of the request, as it keeps every name of the edge's, handing it on
 * through the request's context alone.
 */
export const GATE_RESUME_HEADER = 'x-arkor-gate-resume';
/**
 * The URL a visitor asked for, where the host reaches a gate at an address of the gate's own rather
 * than over a binding, which keeps the request's own URL: the request a gate is handed is then
 * addressed to the gate, and this says where it was going.
 */
export const GATE_URL_HEADER = 'x-upwind-gate-url';

export {
  type DecodedGateShell,
  decodeGateShell,
  encodeGateShell,
  GATE_SHELL_CONTENT_TYPE,
  GATE_SHELL_VERSION,
  type GateShell,
  type GateShellFields,
  type GateShellHeader,
  isGateShellType,
  MAX_GATE_SHELL_BYTES,
  MAX_GATE_SHELL_HEADER_BYTES,
  reachesUncoded,
} from './gate-shell.ts';
