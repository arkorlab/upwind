import { headerRulesFor, type StaticFileEntry } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import {
  EDGE_VALIDATED_HEADER,
  IMMUTABLE_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  SHARED_CACHE_CONTROL_HEADERS,
} from '@stayingupwind/core/request';
import { mergeScopedMiddlewareHeaders } from '@stayingupwind/edge/handlers/responses';

import {
  type CheckedStack,
  configuredValue,
  cookieFailure,
  cookieScopeOf,
  EDGE_HEADER,
  HTTP_OK,
  edgeReads,
} from './answers.ts';
import { sharedCacheFailure } from './cache-control.ts';
import type { Reading } from './reading.ts';

/**
 * What a file of the build is expected to be answered with (`files.ts`), as the edge serves it: the
 * type it was written as or a rule sets, the entity tag it goes under, its coding, how it is held,
 * and every header the application set on it — a rule's, then the middleware's.
 */

/** How the edge has an answer held. */
type Holding =
  /** As immutable: a file the build marked so. */
  | { readonly kind: 'immutable' }
  /** By no shared cache: one visitor's answer. */
  | { readonly kind: 'private' }
  /** By nobody, the browser included: an answer no cache is to hand back (`keptByNobody`). */
  | { readonly kind: 'nobody' }
  /**
   * As the application set it — its middleware, or a rule of `next.config` — which the edge keeps
   * where nothing makes the answer one visitor's: `by` says which.
   */
  | { readonly kind: 'as-set'; readonly value: string; readonly by: string }
  /** Revalidated at every use: a file the build did not mark immutable, which may change. */
  | { readonly kind: 'revalidate' };

/** What the edge holds a file the build did not mark immutable as (`defaultCacheControl`). */
const REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
/** What a rule of `next.config` cannot set on a file: the edge's to say (`ENTITY_HEADERS` there). */
const ENTITY_HEADERS: ReadonlySet<string> = new Set([
  'accept-ranges',
  'content-length',
  'content-range',
  'etag',
]);
/**
 * Headers of a file's answer judged on their own (`fileFailure`), or written by the edge over
 * whatever the application set: the rest of what it set goes out as it set it.
 */
const CACHE_CONTROL = 'cache-control';
const CONTENT_ENCODING = 'content-encoding';
const CONTENT_TYPE = 'content-type';
const JUDGED_APART: ReadonlySet<string> = new Set([
  ...ENTITY_HEADERS,
  CACHE_CONTROL,
  CONTENT_ENCODING,
  CONTENT_TYPE,
  EDGE_HEADER,
  EDGE_VALIDATED_HEADER,
  'set-cookie',
]);
/** Where the edge did not run the application's middleware on a request, which it answered alone. */
export const DID_NOT_RUN = 'did-not-run';
/** What the middleware decided, as the edge ran it, and `DID_NOT_RUN` where it did not run. */
export type Decided = MiddlewareResult | typeof DID_NOT_RUN;

/** What a file is expected to be served with, where `next.config` and the middleware have a say. */
export interface FileExpectation {
  readonly status: number;
  /** The type it is served as: what a rule sets on it, or the type it was written as. */
  readonly type: string;
  /**
   * The entity tag it is served under: its digest's, or one the middleware set in its place, which
   * the edge keeps (`entityTagOf`) — a rule sets none (`ENTITY_HEADERS`).
   */
  readonly etag: string;
  /**
   * The coding it is said to be in: none, as the edge stores a file and sends it to a request that
   * accepts it as it is (`accept-encoding: identity`), but for one a rule of `next.config` names.
   */
  readonly encoding: string | undefined;
  readonly holding: Holding;
  /**
   * Every header the application set on the file, as the edge lays them on its answer: a rule's,
   * but the edge's own (`ENTITY_HEADERS`), then the middleware's over them
   * (`mergeScopedMiddlewareHeaders`) — a cookie of either scoped as the edge scopes it
   * (`cookieScopeOf`), and none of the edge's own headers the middleware set.
   */
  readonly set: Headers;
}

/**
 * How the edge has a file's answer held (`cacheControlFor` in the edge): where the middleware ran,
 * as it set `Cache-Control` itself — where nothing makes the answer one visitor's, a rule the
 * request selected (`conditioned`) or a cookie beside it — and kept from shared caches otherwise;
 * where it did not, kept from them for a rule the request selected, and the file's own otherwise,
 * or a rule's.
 */
function holdingOf(
  file: StaticFileEntry,
  rules: { readonly conditioned: boolean; readonly cacheControl: string | undefined },
  answer: Reading,
  middleware: Decided,
): Holding {
  if (middleware !== DID_NOT_RUN) {
    const shareable = !rules.conditioned && answer.headers['set-cookie'] === undefined;
    const own =
      middleware.kind === 'continue'
        ? (middleware.responseHeaders.get(CACHE_CONTROL) ?? undefined)
        : undefined;
    if (shareable && own !== undefined) {
      return { kind: 'as-set', value: own, by: "the middleware's own" };
    }
    return { kind: 'private' };
  }
  if (rules.conditioned) {
    return { kind: 'private' };
  }
  // A rule's own `Cache-Control` stands over the file's, as the rule wrote it.
  if (rules.cacheControl !== undefined) {
    return { kind: 'as-set', value: rules.cacheControl, by: 'the one a rule of next.config sets' };
  }
  return { kind: file.immutable ? 'immutable' : 'revalidate' };
}

/**
 * What the rules of `next.config` set on a file, as the edge applies them to the request it was
 * asked with (`headerRulesFor`).
 */
export function expectationOf(
  stack: CheckedStack,
  url: URL,
  file: StaticFileEntry,
  read: {
    readonly headers: Readonly<Record<string, string>>;
    readonly answer: Reading;
    readonly middleware: Decided;
  },
): FileExpectation {
  const configured = headerRulesFor(stack.manifest, url, edgeReads(read.headers));
  const set = (header: string): string | undefined =>
    Object.entries(configured.headers).find(([name]) => name.toLowerCase() === header)?.[1];
  const rules = {
    conditioned: configured.conditioned,
    cacheControl: set(CACHE_CONTROL),
  };
  const middleware = read.middleware === DID_NOT_RUN ? undefined : read.middleware;
  const own = middleware?.kind === 'continue' ? middleware.responseHeaders.get('etag') : null;
  const scope = cookieScopeOf(stack);
  const laid = new Headers();
  for (const [name, value] of Object.entries(configured.headers)) {
    if (!ENTITY_HEADERS.has(name.toLowerCase())) {
      try {
        laid.set(name, configuredValue(name, value, scope));
      } catch {
        // Not a header, which the edge leaves off too (`setConfigured`).
      }
    }
  }
  if (middleware?.kind === 'continue') {
    mergeScopedMiddlewareHeaders(laid, middleware.responseHeaders, scope);
  }
  return {
    status: file.status ?? HTTP_OK,
    type: set(CONTENT_TYPE) ?? file.contentType,
    etag: own ?? `"${file.sha256}"`,
    encoding: set(CONTENT_ENCODING),
    holding: holdingOf(file, rules, read.answer, read.middleware),
    set: laid,
  };
}

/**
 * Why a file's answer does not describe it as it should: its coding, which a browser undoes and
 * fails on bytes in none; the tag it revalidates it by, another or none leaving it the wrong bytes
 * or none; and every header the application set (`setHeaderFailure`). An answer that a browser
 * already holds the file (`304`, `unmodified`) may leave its coding unsaid, as what describes the
 * bytes it does not send — but one it says updates what the browser holds, so it has to be the
 * file's.
 */
function descriptionFailure(
  answer: Reading,
  expected: FileExpectation,
  unmodified: boolean,
): string | undefined {
  const encoding = answer.headers[CONTENT_ENCODING];
  if (encoding !== expected.encoding && !(unmodified && encoding === undefined)) {
    const wanted =
      expected.encoding === undefined
        ? 'none, to a request that accepts identity alone'
        : `${expected.encoding}, as a rule of next.config sets`;
    return `answered with Content-Encoding ${encoding ?? 'none'}, not ${wanted}`;
  }
  const { etag } = answer.headers;
  if (etag !== expected.etag) {
    return `answered under the entity tag ${etag ?? 'none'}, not ${expected.etag}`;
  }
  return setHeaderFailure(answer, expected);
}

/**
 * Why a file's answer does not carry a header as the application set it: a rule of `next.config`,
 * or its middleware — but for what is judged apart, and, where the answer is one visitor's, what a
 * shared cache reads ahead of `Cache-Control`, which the edge takes off then.
 */
function setHeaderFailure(answer: Reading, expected: FileExpectation): string | undefined {
  const unshared = expected.holding.kind === 'private' || expected.holding.kind === 'nobody';
  for (const [name, value] of expected.set) {
    if (JUDGED_APART.has(name) || (unshared && SHARED_CACHE_CONTROL_HEADERS.includes(name))) {
      continue;
    }
    const sent = answer.headers[name];
    const answered = Array.isArray(sent) ? sent.join(', ') : sent;
    if (answered !== value) {
      return `answered with ${name} ${answered ?? 'none'}, not the ${value} the application set`;
    }
  }
  // Each cookie apart, as it is set and sent.
  return cookieFailure(answer, expected.set.getSetCookie());
}

export function fileFailure(
  file: StaticFileEntry,
  answer: Reading,
  expected: FileExpectation,
): string | undefined {
  if (answer.status !== expected.status) {
    return `answered ${answer.status}, not ${expected.status}`;
  }
  if (answer.sha256 !== file.sha256) {
    return `answered ${answer.length} bytes other than its own ${file.byteLength}`;
  }
  // Its length, as the manifest has it, which a download's progress is read by.
  const length = answer.headers['content-length'];
  if (length !== String(file.byteLength)) {
    return `answered with Content-Length ${length ?? 'none'}, not the file's ${file.byteLength}`;
  }
  return describedFailure(answer, expected, false);
}

/**
 * Why a file's answer to a request for its headers alone (`HEAD`) is not the whole file's, as the
 * edge answers one from the manifest rather than storage (`metadataResponse`): its status, no body,
 * the file's length — which a client asks for its headers to learn — and what the whole file says
 * of itself.
 */
export function fileHeadFailure(
  file: StaticFileEntry,
  answer: Reading,
  expected: FileExpectation,
): string | undefined {
  if (answer.status !== expected.status) {
    return `answered HEAD with ${answer.status}, not ${expected.status}`;
  }
  if (answer.length > 0) {
    return 'answered HEAD with a body';
  }
  const length = answer.headers['content-length'];
  if (length !== String(file.byteLength)) {
    return `answered HEAD with Content-Length ${length ?? 'none'}, not the file's ${file.byteLength}`;
  }
  const described = describedFailure(answer, expected, false);
  return described === undefined ? undefined : `asked for with HEAD, ${described}`;
}

/**
 * Why a file's answer does not say of it what it should, whatever its body: the type it is served
 * as — which an answer that the browser already holds the file (`unmodified`) may leave unsaid, as
 * it may its coding — what describes it (`descriptionFailure`), and how it is held.
 */
export function describedFailure(
  answer: Reading,
  expected: FileExpectation,
  unmodified: boolean,
): string | undefined {
  // A browser refuses a module, a style sheet or a font served as another type.
  const type = answer.headers[CONTENT_TYPE];
  if (type !== expected.type && !(unmodified && type === undefined)) {
    return `answered as ${type ?? 'no type'}, not ${expected.type}`;
  }
  // Whether a range of it is asked for, as the edge says of a file it answers as itself.
  const ranges = answer.headers['accept-ranges'];
  const wanted = expected.status === HTTP_OK ? 'bytes' : 'none';
  if (ranges !== wanted && !(unmodified && ranges === undefined)) {
    return `answered with Accept-Ranges ${ranges ?? 'unsaid'}, not ${wanted}`;
  }
  return descriptionFailure(answer, expected, unmodified) ?? holdingFailure(answer, expected);
}

/** What a verdict says of an answer that says nothing of how it may be kept. */
const UNSAID_CACHE_CONTROL = 'with no Cache-Control';

/** Why a file's answer is not held as the edge holds it (`Holding`). */
function holdingFailure(answer: Reading, expected: FileExpectation): string | undefined {
  const cacheControl = answer.headers[CACHE_CONTROL];
  switch (expected.holding.kind) {
    case 'revalidate': {
      // As the edge holds a file that may change from one deployment to the next (`robots.txt`):
      // kept, but asked about again at every use.
      return cacheControl === REVALIDATE_CACHE_CONTROL
        ? undefined
        : `not answered as one revalidated at every use (${REVALIDATE_CACHE_CONTROL}), but ${cacheControl ?? UNSAID_CACHE_CONTROL}`;
    }
    case 'immutable': {
      // As the edge holds an immutable file: a year, never revalidated — not merely `immutable`,
      // which beside no lifetime, or a lifetime of none, is stale at once.
      return cacheControl === IMMUTABLE_CACHE_CONTROL
        ? undefined
        : `not answered as immutable (${IMMUTABLE_CACHE_CONTROL}), but ${cacheControl ?? UNSAID_CACHE_CONTROL}`;
    }
    case 'private': {
      // The edge takes off what a shared cache reads ahead of `Cache-Control` here.
      return sharedCacheFailure(answer, () => false);
    }
    case 'nobody': {
      // And keeps it from the browser too.
      return cacheControl === NO_STORE_CACHE_CONTROL
        ? sharedCacheFailure(answer, () => false)
        : `not kept by nobody (${NO_STORE_CACHE_CONTROL}), but ${cacheControl ?? UNSAID_CACHE_CONTROL}`;
    }
    case 'as-set': {
      const { value, by } = expected.holding;
      return cacheControl === value
        ? undefined
        : `answered with Cache-Control ${cacheControl ?? 'none'}, not ${by}, ${value}`;
    }
  }
}
