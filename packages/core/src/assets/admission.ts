import { DEPLOYMENT_ID_QUERY } from '../request/constants.ts';

/**
 * `/_next/static/` sub-trees whose file names are content hashes (Next.js 16.3 Turbopack output).
 * `immutable/` is the explicit cross-deployment namespace; the others are the legacy locations that
 * Vercel serves with `?dpl=` when Skew Protection is enabled.
 */
const HASHED_TREE_RE = /^\/_next\/static\/(?:immutable|chunks|css|media|runtime)\/.+$/u;
/**
 * The manifests Next.js writes under the build id. Every build with a `deploymentId` gets the same
 * build id (`getBuildId`), so the path names no build on its own: only with the `dpl` the build's
 * documents ask for these by, which then keys the copy.
 */
const BUILD_MANIFEST_RE =
  /^\/_next\/static\/[\w-]{8,}\/_(?:buildManifest|ssgManifest|clientMiddlewareManifest)\.js$/u;
const NON_IMMUTABLE_MARKERS: readonly string[] = ['/development/', '/webpack/', '.hot-update.'];

/** True when the path (and query) can only refer to a content-addressed static asset. */
export function isImmutableAssetPath(pathname: string, searchParams: URLSearchParams): boolean {
  const named =
    HASHED_TREE_RE.test(pathname) ||
    (BUILD_MANIFEST_RE.test(pathname) && (searchParams.get(DEPLOYMENT_ID_QUERY) ?? '') !== '');
  if (!named) {
    return false;
  }
  if (NON_IMMUTABLE_MARKERS.some((marker) => pathname.includes(marker))) {
    return false;
  }
  for (const key of searchParams.keys()) {
    if (key !== DEPLOYMENT_ID_QUERY) {
      return false;
    }
  }
  return true;
}

export interface CacheControlDirectives {
  readonly public: boolean;
  readonly private: boolean;
  readonly noStore: boolean;
  readonly noCache: boolean;
  readonly immutable: boolean;
  readonly maxAge: number | undefined;
  readonly sMaxAge: number | undefined;
  /**
   * A freshness directive appeared more than once, so no reading of the header is the reading.
   * `public, immutable, max-age=0, max-age=31536000` is the shape that matters: taking the last
   * occurrence admits as immutable a response whose own origin said not to hold it at all, and the
   * next cache along may well take the first.
   */
  readonly repeatedFreshness: boolean;
}

type MutableDirectives = {
  -readonly [Key in keyof CacheControlDirectives]: CacheControlDirectives[Key];
};

type BooleanDirective = 'public' | 'private' | 'noStore' | 'noCache' | 'immutable';
const BOOLEAN_DIRECTIVES: ReadonlyMap<string, BooleanDirective> = new Map([
  ['immutable', 'immutable'],
  ['no-cache', 'noCache'],
  ['no-store', 'noStore'],
  ['private', 'private'],
  ['public', 'public'],
]);
const SECONDS_DIRECTIVES: ReadonlyMap<string, 'maxAge' | 'sMaxAge'> = new Map([
  ['max-age', 'maxAge'],
  ['s-maxage', 'sMaxAge'],
]);
const DECIMAL_RADIX = 10;

const DELTA_SECONDS = /^\d+$/u;

/**
 * Parse a `delta-seconds` argument, or nothing at all.
 *
 * The whole argument has to be digits. `Number.parseInt` would take the numeric prefix of
 * `31536000junk` and report a year, and admission would then treat a response the origin never
 * declared fresh as immutable and cache it for the policy's lifetime.
 */
function parseSeconds(argument: string | undefined): number | undefined {
  if (argument === undefined) {
    return undefined;
  }
  // Not unquoted: `delta-seconds` is digits and nothing else. Accepting a stray quote meant a
  // quoted extension such as `foo="x,max-age=31536000"` — which this splits on its inner comma —
  // handed the parser a freshness the origin never declared, and the edge then rewrote the asset
  // as immutable for a year.
  const digits = argument.trim();
  return DELTA_SECONDS.test(digits) ? Number.parseInt(digits, DECIMAL_RADIX) : undefined;
}

/** Parse the directives that admission cares about. */
export function parseCacheControl(value: string | null): CacheControlDirectives {
  const directives: MutableDirectives = {
    public: false,
    private: false,
    noStore: false,
    noCache: false,
    immutable: false,
    maxAge: undefined,
    sMaxAge: undefined,
    repeatedFreshness: false,
  };
  if (value === null) {
    return directives;
  }
  // Boolean directives are idempotent, so only the ones carrying a value can be repeated into
  // ambiguity. `Headers.get` joins repeated header lines, so those arrive here the same way.
  const seen = new Set<string>();
  for (const rawPart of value.split(',')) {
    const [name = '', argument] = rawPart.trim().toLowerCase().split('=', 2);
    const flag = BOOLEAN_DIRECTIVES.get(name);
    if (flag !== undefined) {
      directives[flag] = true;
      continue;
    }
    const seconds = SECONDS_DIRECTIVES.get(name);
    if (seconds !== undefined) {
      directives.repeatedFreshness ||= seen.has(seconds);
      seen.add(seconds);
      directives[seconds] = parseSeconds(argument);
    }
  }
  return directives;
}

const ONE_YEAR_SECONDS = 31_536_000;
const ADMITTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/javascript',
  'application/json',
  'application/octet-stream',
  'application/wasm',
  'text/css',
  'text/javascript',
]);
const ADMITTED_CONTENT_TYPE_PREFIXES: readonly string[] = ['font/', 'image/'];
const OK_STATUS = 200;

export type AssetRejection =
  | 'method'
  | 'range-request'
  | 'status'
  | 'content-type'
  | 'cache-control'
  | 'content-encoding'
  | 'set-cookie'
  | 'vary'
  | 'partial-content';

export interface AssetScreenInput {
  readonly method: string;
  readonly requestHeaders: Headers;
  readonly status: number;
  readonly responseHeaders: Headers;
}

function isContentTypeAdmitted(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    ADMITTED_CONTENT_TYPES.has(mediaType) ||
    ADMITTED_CONTENT_TYPE_PREFIXES.some((prefix) => mediaType.startsWith(prefix))
  );
}

/**
 * Whether a `cache-control` says a response may be kept for a year and shared: `immutable` on its
 * own says nothing, since it qualifies a freshness lifetime that `no-store`, `private` or a short
 * `max-age` can withhold. Read by the edge, which admits an asset on it, and by the adapter, which
 * marks a static export's files from the rule the build emits for them.
 */
export function isImmutableCacheControl(value: string | null): boolean {
  const directives = parseCacheControl(value);
  const longLived = directives.maxAge !== undefined && directives.maxAge >= ONE_YEAR_SECONDS;
  return (
    directives.immutable &&
    directives.public &&
    longLived &&
    !directives.repeatedFreshness &&
    !directives.noStore &&
    !directives.noCache &&
    !directives.private
  );
}

/**
 * The cache key is the origin URL alone, so a negotiated body would be replayed to clients that
 * negotiated something else. Only `accept-encoding` may vary, because the cache stores each
 * encoding separately; anything else disqualifies the response.
 */
const VARY_ALLOWED: ReadonlySet<string> = new Set(['accept-encoding']);

function isVaryAcceptable(vary: string | null): boolean {
  if (vary === null || vary.trim() === '') {
    return true;
  }
  return vary
    .toLowerCase()
    .split(',')
    .map((name) => name.trim())
    .every((name) => name === '' || VARY_ALLOWED.has(name));
}

const KIB = 1024;
const MIB = KIB * KIB;
const MAX_IMMUTABLE_ASSET_MIB = 8;
/**
 * Largest immutable asset the edge will admit, and therefore the most that has to be read when
 * validation compares the edge's copy with the origin's.
 *
 * This is not a number held up against a header: a Function subrequest arrives without
 * `Content-Length`, so it is how many bytes the edge pulls into the isolate — behind the response,
 * while the client reads the same body — to find out how many there are. That makes it a memory
 * budget, which is why it matches `MAX_ORIGIN_DOCUMENT_BYTES`: the same isolate, bounded the same
 * way.
 */
export const MAX_IMMUTABLE_ASSET_BYTES = MAX_IMMUTABLE_ASSET_MIB * MIB;

const CONTENT_ENCODING = 'content-encoding';
const DELIVERABLE_REFUSALS: ReadonlySet<AssetRejection> = new Set([CONTENT_ENCODING]);

/**
 * Whether a refused response's own storage declaration still stands for the caches after the edge.
 *
 * Every other rejection is a statement about the response: it sets a cookie, it varies, its own
 * origin said not to hold it. This one is a statement about the edge — the origin's declaration is
 * sound and the edge simply is not the one to keep the bytes — so the browser and the cache in
 * front of the Function keep their entitlement.
 */
export function refusalAllowsStorage(reason: AssetRejection): boolean {
  return DELIVERABLE_REFUSALS.has(reason);
}

function rejectResponse(input: AssetScreenInput): AssetRejection | undefined {
  const { responseHeaders } = input;
  if (input.status !== OK_STATUS) {
    return 'status';
  }
  if (!isContentTypeAdmitted(responseHeaders.get('content-type'))) {
    return 'content-type';
  }
  if (!isImmutableCacheControl(responseHeaders.get('cache-control'))) {
    return 'cache-control';
  }
  // The runtime chooses what encoding a subrequest asks for and whether it decodes the answer, so
  // an encoding still named here leaves the edge unable to say whether the bytes it would read are
  // the asset or a compression of it. Measuring, storing and replaying them is not a guess to make.
  if (responseHeaders.has(CONTENT_ENCODING)) {
    return CONTENT_ENCODING;
  }
  if (responseHeaders.has('set-cookie')) {
    return 'set-cookie';
  }
  if (!isVaryAcceptable(responseHeaders.get('vary'))) {
    return 'vary';
  }
  if (responseHeaders.has('content-range')) {
    return 'partial-content';
  }
  return undefined;
}

/**
 * Every question about an immutable-asset candidate that a header can answer.
 *
 * Size is not one of them, and it is not a rejection at all. A Cloudflare Function subrequest arrives
 * without `Content-Length` — the runtime sets that from the data source, and a subrequest body is a
 * stream — so the length belongs to whoever reads the body, and by then the headers have been
 * committed. An asset too large to keep is delivered as the admitted asset it is, and simply not
 * kept. Screening first is what keeps any read off the responses that were never going to be
 * admitted anyway.
 *
 * Proof of immutability comes from the origin's own headers, never from the path alone.
 */
export function screenImmutableAsset(input: AssetScreenInput): AssetRejection | undefined {
  if (input.method !== 'GET') {
    return 'method';
  }
  if (input.requestHeaders.has('range')) {
    return 'range-request';
  }
  return rejectResponse(input);
}
