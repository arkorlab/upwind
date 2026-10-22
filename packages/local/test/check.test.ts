import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- what a browser accepts, zstd among it
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';

import {
  type DeploymentBundle,
  dynamicRouting,
  foldedHeaderRulesOf,
  headerRulesOf,
  pagesDataPathnameUnder,
  type Prerender,
  type RouteHas,
  shellHeaders,
  spelledPrefixOf,
  staticFileLocalesOf,
} from '@stayingupwind/core/bundle';
import { deriveEntry, KEY_SCHEMA_VERSION, kvGenerationKey } from '@stayingupwind/core/cache';
import {
  buildProjectManifest,
  type DynamicRoute,
  type HeaderRule,
  type ProjectManifest,
  type ReservedRoute,
  type RouteCache,
  type RouteEntry,
  type RouteSegment,
  type StaticFileEntry,
  validationPathnameFor,
} from '@stayingupwind/core/manifest';
import { readMiddlewareResponse } from '@stayingupwind/core/paas';
import {
  allowRecoveryScript,
  NO_STORE_CACHE_CONTROL,
  NULL_BODY_STATUSES,
  RSC_VARY,
  SHARED_CACHE_CONTROL_HEADERS,
} from '@stayingupwind/core/request';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
  runtimeCacheOf,
} from '@stayingupwind/host/delivery';
import { scanPreloadLinks } from '@stayingupwind/host/preloads';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type CheckResult, checkStack } from '../src/check.ts';
import { jarOf, NO_COOKIE_CHANGES } from '../src/cookie-jar.ts';
import { documentAnswerAt } from '../src/document-adoption.ts';
import { expectationOf, fileFailure, fileHeadFailure } from '../src/file-expectations.ts';
import { flowFailure } from '../src/part-flows.ts';
import type { Part } from '../src/part-marks.ts';
import { originAt, partsOf } from '../src/parts.ts';
import { read } from '../src/reading.ts';
import { redirectsFrom } from '../src/redirects.ts';
import type { CspNonceSetting, LocalStack } from '../src/stack.ts';
import type { RecordedGeneration, Regeneration } from '../src/workers/protocol.ts';

/**
 * The check against an edge whose every answer the test writes — and a Function, where one is
 * asked for: what the application's middleware may make of a request — a file rewritten onto
 * another, held as the middleware chose, a page rewritten onto another route — told apart from what
 * nothing the middleware does explains; and how an export's Function answers a miss.
 */

const TEXT = 'text/plain; charset=utf-8';
const SCRIPT = 'text/javascript; charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const GATED = 'private, max-age=0, must-revalidate';
/** How the edge holds a file the build did not mark immutable. */
const REVALIDATE = 'public, max-age=0, must-revalidate';
const FILE_EDGE = 'static;src=bucket;project=site;policy=default;m=0000';
const FRONT = '<!doctype html><html><head><title>Front</title></head><body>';
const ABOUT = '<!doctype html><html><head><title>About</title></head><body>';
const REST = '<main>rendered</main></body></html>';
const AT = '2026-10-09T00:00:00.000Z';
/** Where the check asks a Function for a miss: the answer under this key answers every one. */
const MISS = '/_upwind-local-check/';
/** Where the test's server, standing in for the edge's own socket, hands back kept decisions. */
const BACKSTAGE = '/_backstage/';
const HTML = 'text/html; charset=utf-8';
/** How the build types a React Server Components payload, and a page's props. */
const RSC = 'text/x-component';
/** What a browser accepts a page in, all at once, as the check asks for one. */
const BROWSER_CODINGS = 'gzip, deflate, br, zstd';
/** What Safari accepts at once, as WebKit names it. */
const SAFARI_CODINGS = 'gzip, deflate, br';
/**
 * What each browser a page is asked as accepts at once, in the order the check asks each (`codedAsks`):
 * Chrome, Safari, Firefox, Safari on a Mac and Chrome on Android, each from the four places a
 * navigation comes from — and from the three pages among them as their script navigates.
 */
const EACH_BROWSER_CODINGS = [
  BROWSER_CODINGS,
  SAFARI_CODINGS,
  BROWSER_CODINGS,
  SAFARI_CODINGS,
  BROWSER_CODINGS,
].flatMap((coding) => Array.from({ length: 7 }, () => coding));
const JSON_TYPE = 'application/json';
/** What the edge varies a part of a page by, as `segment.ts` in the edge does. */
const PART_VARY =
  'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, accept-encoding';
const NOT_FOUND = '<!doctype html><html><body>Not here</body></html>';

interface Answer {
  /** A router answer whose redirects depend on the query exactly as sent. */
  readonly forSearch?: (search: string) => Answer;
  readonly status?: number;
  readonly headers: OutgoingHttpHeaders;
  readonly body: string;
  /** Whether the answer never ends, as a stream an application keeps open does. */
  readonly endless?: boolean;
  /** Observe the real response whose body is held open until the reader cancels it. */
  readonly opened?: ((response: ServerResponse) => void) | undefined;
  /** Whether a file is answered whole to a request for a range of it. */
  readonly rangeless?: boolean;
  /** What a request for a range of it is answered with instead, where not the file's range. */
  readonly inPart?: Answer;
  /** Whether a file is answered whole to a request on the entity tag it is served under. */
  readonly unconditional?: boolean;
  /** The headers a request on its entity tag is answered with instead, where not the file's. */
  readonly unmodifiedHeaders?: OutgoingHttpHeaders;
  /** What a request on its entity tag is answered with instead of a `304`: the file, whole. */
  readonly onCondition?: Answer;
  /** What a request for its headers alone (`HEAD`) is answered with instead, where not the GET's. */
  readonly onHead?: OutgoingHttpHeaders;
  /**
   * Whether its body goes out compressed in the coding the request accepts — or in the one named —
   * its headers as given.
   */
  readonly compressed?: boolean | 'zstd' | 'gzip';
  /** Whether a file is answered without saying its length, as the edge always says it. */
  readonly lengthless?: boolean;
  /** The headers a request carrying the cookie `name` is answered with over the file's own. */
  readonly withCookie?: { readonly name: string; readonly headers: OutgoingHttpHeaders };
  /** The headers a request without the header `name` is answered with over the file's own. */
  readonly withoutHeader?: { readonly name: string; readonly headers: OutgoingHttpHeaders };
  /** The headers a request carrying the header `name` is answered with over the file's own. */
  readonly withHeader?: { readonly name: string; readonly headers: OutgoingHttpHeaders };
  /**
   * The headers a request `test` holds for is answered with over the others, and the status, where
   * one is given — or whether its connection is closed before any of the answer goes out
   * (`hangsUp`).
   */
  readonly when?: {
    readonly test: (
      headers: IncomingMessage['headers'],
      method: string | undefined,
      url: URL,
    ) => boolean;
    readonly headers?: OutgoingHttpHeaders;
    readonly status?: number;
    readonly hangsUp?: boolean;
    /** What a request for its headers alone it holds for is answered with (`onHead`). */
    readonly onHead?: OutgoingHttpHeaders;
  };
  /**
   * Whether a rule claims a request with these headers, which the edge then hands on for want of a
   * route (`route-not-proved`), as the test says.
   */
  readonly claimedWhen?: (headers: IncomingMessage['headers']) => boolean;
  /**
   * What a router's request without the `_rsc` the client router names one by is answered with
   * instead, where not this: one a redirect brought to the URL as it was written.
   */
  readonly unbusted?: Answer;
  /** Whether the connection is closed before any of the answer goes out, as one that drops is. */
  readonly hangsUp?: boolean;
  /** Whether a range of it is answered on a validator its own tag is not (`If-Range`), all the same. */
  readonly ifRangeIgnored?: boolean;
  /** Whether a range of it on its own tag (`If-Range`) is answered whole, as on a stale one. */
  readonly ifRangeRefused?: boolean;
  /** Whether a range of it by its end (`bytes=-n`) or from a byte on (`bytes=n-`) is answered whole. */
  readonly openRangeless?: boolean;
  /** Whether a document asked for in a coding is answered as it is all the same. */
  readonly uncoded?: boolean;
  /** What a document asked for in a coding is, undone, where not `body`. */
  readonly codedBody?: string;
  /** The rendering the edge says it sent a document asked for in a coding as, where not its own. */
  readonly rendering?: string;
  /** Whether a document asked for in brotli by Chrome goes in two layers of it, as the edge layers. */
  readonly layered?: boolean;
  /** Whether such a document's Vary leaves the agent out. */
  readonly unvariedByAgent?: boolean;
  /** The rendering the edge says it sent such a document in two layers as, where not `br-br`. */
  readonly layeredRendering?: string;
  /** Whether a document asked for in brotli goes in two layers of it to any agent, not Chrome's alone. */
  readonly layeredForAll?: boolean;
}

/** The real router's one tree request, rather than a handwritten hash or part. */
function treePart(parts: readonly Part[]): Part {
  const tree = parts.find((part) => part.kind === 'segment');
  if (tree === undefined) {
    throw new Error('the build wrote no tree segment');
  }
  return tree;
}

/** A built segment selected by the header its real router request carries. */
function namedSegment(parts: readonly Part[], segmentPath: string): Part {
  const found = parts.find((part) => part.headers['next-router-segment-prefetch'] === segmentPath);
  if (found === undefined) {
    throw new Error(`the build wrote no ${segmentPath} segment`);
  }
  return found;
}

/** The hash Next appended after any earlier bare or encoded query keys. */
function appendedHash(part: Part): string {
  const hash = part.url.searchParams.getAll('_rsc').at(-1);
  if (typeof hash !== 'string') {
    throw new TypeError('the router request carries no computed hash');
  }
  return hash;
}

/** A target whose correct router hash is required for a valid part response. */
function requiringHash(seen: string[], hash: string): (search: string) => Answer {
  return (search) => {
    seen.push(search);
    const answer = segmentAnswer('login tree');
    return new URLSearchParams(search).get('_rsc') === hash
      ? answer
      : { ...answer, headers: { ...answer.headers, 'content-type': TEXT } };
  };
}

/** A target that canonically drops the appended duplicate while keeping the original bare key. */
function keepingBare(seen: string[], redirect: Answer): (search: string) => Answer {
  return (search) => {
    seen.push(search);
    const duplicated = new URLSearchParams(search).getAll('_rsc').length > 1;
    return duplicated ? redirect : segmentAnswer('login tree');
  };
}

/** What the edge answers each pathname with, written by each test. */
const answers = new Map<string, Answer>();
/**
 * What the client router's request for a part of a page is answered with, by the page's pathname
 * and the segment it names (`next-router-segment-prefetch`) — `rsc` for the whole payload — and what
 * each such request asked with.
 */
const partAnswers = new Map<string, Answer>();
/** Every coding each pathname was asked to accept, in the order it was asked. */
const codingsAsked = new Map<string, string[]>();
const partsAsked = new Map<
  string,
  { readonly headers: IncomingMessage['headers']; readonly search: string }
>();
/** The headers of every request for each part asked as it is, in the order they came. */
const partsAskedEach = new Map<string, IncomingMessage['headers'][]>();
/**
 * What the middleware decided for each pathname, as the stack keeps it for a traced request; one
 * it has nothing for it let through as it came.
 */
const decisions = new Map<string, OutgoingHttpHeaders>();
/** The captured HTTP status of a middleware rewrite, otherwise 200. */
const decisionStatuses = new Map<string, number>();
/**
 * What the middleware decided for each pathname asked for a range of it, where not what it decided
 * for the whole: the traced requests that asked for one, by their ids.
 */
const decidedInPart = new Map<string, OutgoingHttpHeaders>();
const rangeTraces = new Set<string>();
/** The same, for a request on a file's entity tag (`If-None-Match`), and for its headers alone. */
const decidedOnCondition = new Map<string, OutgoingHttpHeaders>();
const conditionTraces = new Set<string>();
const decidedOnHead = new Map<string, OutgoingHttpHeaders>();
const headTraces = new Set<string>();
/**
 * What the middleware decided for a pathname asked for accepting a coding, where not what it decided
 * for the pathname: by `<pathname>|<accept-encoding>`, and the coding each traced request accepted.
 */
const decidedInCoding = new Map<string, OutgoingHttpHeaders>();
const traceCodings = new Map<string, string>();
/**
 * What the middleware decided for the client router's request for a segment of the page at a
 * pathname, apart from the page's own: by `<pathname>|<segment path>`, and the segment each traced
 * request named.
 */
const decidedForSegment = new Map<string, OutgoingHttpHeaders>();
const traceSegments = new Map<string, string>();
/**
 * What the middleware decided for a navigation of a pathname from where it came from, apart from
 * the page's own: by `<pathname>|<sec-fetch-site>`, and where each traced navigation came from.
 */
const decidedFromSite = new Map<string, OutgoingHttpHeaders>();
const traceSites = new Map<string, string>();
/** The pathname each traced request asked for, by its id. */
const traces = new Map<string, string>();
/** The ids the check registered, read what was kept under, and let go of, as the backstage saw it. */
const traceIds = {
  registered: new Set<string>(),
  read: new Set<string>(),
  letGo: new Set<string>(),
};
/** What each pathname was last asked to accept, and as which agent, as the edge was asked. */
const accepted = new Map<string, string | undefined>();
const agents = new Map<string, string | undefined>();
/** Every agent each pathname was asked as, in the order it was asked, as the edge was asked. */
const agentsAsked = new Map<string, (string | undefined)[]>();
/**
 * The record the edge had a Function regenerate in front of each pathname, as the stack keeps it for
 * a traced request.
 */
const regenerations = new Map<string, Regeneration>();
/**
 * What the edge says of its probe of each Function, by the Function's name: by default, that it
 * handed the probe to that Function (`fn=`).
 */
const probedAs = new Map<string, string>();
/** The headers each generation of a record was recorded with, by `<scope>|<entry>|<seq>`. */
const generationHeaders = new Map<string, Record<string, string>>();
/** The outputs a generation the test names holds, by `<scope>|<entry>|<seq>`, where it names them. */
const generationOutputs = new Map<string, Output[]>();
/** The generations the test names that a resume would finish, by `<scope>|<entry>|<seq>`. */
const partialGenerations = new Set<string>();
/** The generations the test names that a build wrote, by `<scope>|<entry>|<seq>`. */
const builtGenerations = new Set<string>();
/** The status each generation the test names was rendered with, where the test says. */
const generationStatuses = new Map<string, number>();
/** What the edge judged the validity of each generation the test names by, where the test says. */
const generationFreshness = new Map<string, unknown>();
/** Records whose metadata the fake backstage captures in the part's own trace reply. */
const capturedPartRecords = new Map<string, string>();
/** Generation snapshots kept by a HEAD's own trace, apart from the live generation endpoint. */
const capturedHeadRecords = new Map<string, Record<string, RecordedGeneration>>();
/** A refresh after the final redirected response's trace is released, before its deferred verdict. */
const afterPartTraces = new Map<string, { remaining: number; readonly apply: () => void }>();
/** The value of the trace header each registered id is to go on with (`?as=`), and by pathname. */
const registeredAs = new Map<string, string | null>();
const restored = new Map<string, string | null>();
/** The mode each pathname was last asked in (`Sec-Fetch-Mode`), its query, and its cookies. */
const modes = new Map<string, string | undefined>();
const queries = new Map<string, string>();
const cookies = new Map<string, string | undefined>();
/** The host each pathname was last asked under (`Host`), and what for (`Sec-Fetch-Dest`). */
const hosts = new Map<string, string | undefined>();
const destinations = new Map<string, string | string[] | undefined>();
/** Every header each pathname was last asked with, as the edge was sent them. */
const askedHeaders = new Map<string, IncomingMessage['headers']>();
/** The headers of each request for a page, by the pathname it was asked at, in the order asked. */
const askedHeadersEach = new Map<string, IncomingMessage['headers'][]>();
/** The pathnames whose middleware decision the stack kept nothing of. */
const unkept = new Set<string>();
/**
 * Whether the answer the test's edge gave each traced request, by its id, said the middleware ran
 * on it (`mw=hit`), where it said anything of it: where it said it did not, the stack keeps no
 * decision of it, as the edge's own keeps one of a middleware it ran alone — but for the pathnames
 * in `keptUnsaid`, whose decision it keeps though the answer says the middleware did not run.
 */
const saidRan = new Map<string, boolean>();
const keptUnsaid = new Set<string>();
/** The pathnames whose `HEAD` the stack keeps nothing of the middleware for, as for one it never ran. */
const unkeptOnHead = new Set<string>();
const state: {
  origin?: URL;
  bundleDir?: string;
  /** What a deploy permits on a document's policy: the edge's recovery script. */
  recovery?: string;
  backstageFails?: number | undefined;
  /** How many shells the backstage was asked to stamp. */
  stamped?: number;
  /** What the backstage says the middleware made of a request it was asked about on its own. */
  middlewareProbe?: Record<string, unknown> | undefined;
  /** The pathname it was asked about. */
  middlewareAsked?: string | null | undefined;
} = {};

/** What a request for `pathname` asked, as the tests read it back. */
function recordAsked(
  request: IncomingMessage,
  at: { readonly pathname: string; readonly keyed: string; readonly search: string },
): void {
  const trace = request.headers['x-upwind-trace'];
  if (typeof trace === 'string') {
    traces.set(trace, at.pathname);
    traceCodings.set(trace, request.headers['accept-encoding'] ?? 'identity');
    const segment = request.headers['next-router-segment-prefetch'];
    if (typeof segment === 'string') {
      traceSegments.set(trace, segment);
    }
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string' && request.headers['sec-fetch-mode'] === 'navigate') {
      traceSites.set(trace, site);
    }
    // A range of it bounded at both ends, asked for plainly: one on a validator (`If-Range`) is
    // decided as the whole file, and one by its end or from a byte on as the file itself.
    const bounded = /^bytes=\d+-\d+$/u.test(request.headers.range ?? '');
    if (bounded && request.headers['if-range'] === undefined) {
      rangeTraces.add(trace);
    }
    if (request.headers['if-none-match'] !== undefined) {
      conditionTraces.add(trace);
    }
    if (request.method === 'HEAD') {
      headTraces.add(trace);
    }
  }
  // What the client router asks for of a page is kept apart (`partsAsked`), not as the page asked.
  if (request.headers['rsc'] === '1') {
    return;
  }
  if (typeof trace === 'string') {
    restored.set(at.pathname, registeredAs.get(trace) ?? null);
  }
  accepted.set(at.keyed, request.headers.accept);
  agents.set(at.keyed, request.headers['user-agent']);
  agentsAsked.set(at.keyed, [...(agentsAsked.get(at.keyed) ?? []), request.headers['user-agent']]);
  modes.set(at.keyed, request.headers['sec-fetch-mode']);
  queries.set(at.keyed, at.search);
  cookies.set(at.keyed, request.headers.cookie);
  hosts.set(at.keyed, request.headers.host);
  destinations.set(at.keyed, request.headers['sec-fetch-dest']);
  askedHeaders.set(at.keyed, request.headers);
  askedHeadersEach.set(at.keyed, [...(askedHeadersEach.get(at.keyed) ?? []), request.headers]);
}

/**
 * A file's answer to a request for one range of it, as the edge serves one; false for none — and for
 * one asked on a validator the file's own tag is not, strongly (`If-Range`), but where the test has
 * the edge ignore that (`ifRangeIgnored`).
 */
function answeredInPart(
  answer: Answer,
  request: IncomingMessage,
  headers: OutgoingHttpHeaders,
  response: ServerResponse,
): boolean {
  const asked = rangeAsked(answer, request, headers);
  if (asked === undefined) {
    return false;
  }
  // What the test gives a range bounded at both ends, asked for plainly as a resumed download asks
  // one: its own — as the middleware decides it apart (`decidedInPart`).
  if (asked.bounded && answer.inPart !== undefined && request.headers['if-range'] === undefined) {
    response.writeHead(answer.inPart.status ?? 200, answer.inPart.headers).end(answer.inPart.body);
    return true;
  }
  // A file of an error's status answers no range: whole.
  if ((answer.status ?? 200) !== 200) {
    return false;
  }
  const bytes = Buffer.from(answer.body);
  const start = asked.start(bytes.length);
  // No byte of it where the range starts — or none at all, for one by its end: `416`, under the
  // length it has (`rangeNotSatisfiable`).
  if (start >= bytes.length || bytes.length === 0) {
    // The file's headers but its length, and kept by nobody (`keptByNobody`).
    const unsatisfied = Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => name !== 'content-length' && !SHARED_CACHE_CONTROL_HEADERS.includes(name),
      ),
    );
    response
      .writeHead(416, {
        ...unsatisfied,
        'cache-control': NO_STORE_CACHE_CONTROL,
        'content-range': `bytes */${bytes.length}`,
      })
      .end();
    return true;
  }
  const end = asked.end(bytes.length);
  const contentRange = `bytes ${start}-${end}/${bytes.length}`;
  const length = String(end - start + 1);
  response.writeHead(206, { ...headers, 'content-range': contentRange, 'content-length': length });
  response.end(bytes.subarray(start, end + 1));
  return true;
}

/**
 * The one range a request asks for, as the test's edge reads it — bounded at both ends, by its end
 * (`-n`) or from a byte on (`n-`) — where it answers one: none for a request asking no range, for a
 * file the test has answered whole to one (`rangeless`, `openRangeless` for the two open forms),
 * and for one asked on a validator the file's own tag is not, strongly (`If-Range`), but where the
 * test has the edge ignore that (`ifRangeIgnored`).
 */
function rangeAsked(
  answer: Answer,
  request: IncomingMessage,
  headers: OutgoingHttpHeaders,
):
  | {
      readonly bounded: boolean;
      readonly start: (length: number) => number;
      readonly end: (length: number) => number;
    }
  | undefined {
  const [, first = '', last = ''] = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? '') ?? [];
  const condition = request.headers['if-range'];
  const tag = headers.etag ?? '';
  const stale = condition !== undefined && (condition !== tag || condition.startsWith('W/'));
  // On its own tag, or on a stale one, as the test has the edge take each.
  const conditioned = stale
    ? answer.ifRangeIgnored !== true
    : condition !== undefined && answer.ifRangeRefused === true;
  const bounded = first !== '' && last !== '';
  if (
    conditioned ||
    (first === '' && last === '') ||
    answer.rangeless === true ||
    (!bounded && answer.openRangeless === true)
  ) {
    return undefined;
  }
  return {
    bounded,
    start: (length) => (first === '' ? Math.max(0, length - Number(last)) : Number(first)),
    end: (length) => (bounded ? Math.min(Number(last), length - 1) : length - 1),
  };
}

/** A file's answer to a request on the entity tag it is served under: `304`; false for none. */
function answeredUnmodified(
  answer: Answer,
  condition: string | undefined,
  headers: OutgoingHttpHeaders,
  response: ServerResponse,
): boolean {
  if (
    condition === undefined ||
    condition !== headers.etag ||
    (answer.status ?? 200) !== 200 ||
    answer.unconditional === true
  ) {
    return false;
  }
  // As the edge answers one: its headers, but the length of a body it does not send.
  const unmodified = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== 'content-length'),
  );
  response.writeHead(304, answer.unmodifiedHeaders ?? unmodified).end();
  return true;
}

/**
 * What the test's edge answers a request that selects of a file with, where it answers one apart:
 * its headers alone (`HEAD`) as the test gives them, a range of it, or that the browser holds it.
 */
function answeredApart(
  request: IncomingMessage,
  file: {
    readonly answer: Answer;
    readonly served: boolean;
    readonly headers: OutgoingHttpHeaders;
  },
  response: ServerResponse,
): boolean {
  const { answer, headers } = file;
  if (request.method === 'HEAD' && answer.onHead !== undefined) {
    response.writeHead(answer.status ?? 200, answer.onHead).end();
    return true;
  }
  // A page a resume completes, asked for its headers alone: handed on to the Function behind the
  // middleware, as the edge hands one on (`headToApplication`) — and a page's props, which the edge
  // hands on whole (`composePagesData`).
  const account = String(answer.headers['x-arkor-edge'] ?? '');
  if (request.method === 'HEAD' && account.startsWith('data;')) {
    response.writeHead(200, { 'x-arkor-edge': 'passthrough;reason=pages-data' }).end();
    return true;
  }
  if (
    request.method === 'HEAD' &&
    account.startsWith('shell;') &&
    account.includes(';cont=resume')
  ) {
    const ran = account.split(';').includes('mw=hit') ? ';mw=hit' : '';
    response.writeHead(200, {
      'content-type': HTML,
      'x-arkor-edge': `passthrough;reason=head-resumed${ran}`,
    });
    response.end();
    return true;
  }
  // A file the edge holds is answered from the manifest, its length said (`metadataResponse`).
  if (request.method === 'HEAD' && file.served) {
    const length = String(Buffer.byteLength(answer.body));
    response.writeHead(answer.status ?? 200, { ...headers, 'content-length': length }).end();
    return true;
  }
  const resent = answer.onCondition;
  if (resent !== undefined && file.served && request.headers['if-none-match'] !== undefined) {
    // As the edge serves a file whole: under its digest's tag and its length, but as given.
    const tagged = {
      etag: `"${sha256Of(resent.body)}"`,
      'content-length': String(Buffer.byteLength(resent.body)),
      'accept-ranges': 'bytes',
      ...resent.headers,
    };
    response.writeHead(resent.status ?? 200, tagged).end(resent.body);
    return true;
  }
  return (
    file.served &&
    (answeredInPart(answer, request, headers, response) ||
      answeredUnmodified(answer, request.headers['if-none-match'], headers, response))
  );
}

/**
 * A document the edge composed with a nonce minted for it, as `account` says, under `policies`: its
 * shell (`body`), and what followed it (`rest`).
 */
function mintedAnswer(
  body: string,
  account: string,
  policies: OutgoingHttpHeaders,
  rest = REST,
): Answer {
  return {
    headers: {
      'content-type': HTML,
      'cache-control': 'no-store, no-transform',
      ...policies,
      'x-arkor-edge': `shell;strategy=edge;src=kv;m=0000;policy=default${account};cont=resume;mw=miss;route=/`,
    },
    body: body + rest,
  };
}

/** A rule claiming `/a.txt` for a request without an `x-mode` header that `value` matches. */
function wanting(value: string): ReservedRoute {
  return {
    sourceRegex: String.raw`^/a\.txt$`,
    beforeFiles: true,
    missing: [{ type: 'header', key: 'x-mode', value }],
  };
}

/**
 * A shell with `nonce` stamped in it, as the test's edge stamps one: on each of its scripts, in place
 * of any it named — so that stamped again with it, it is the same.
 */
function stampedWith(shell: string, nonce: string): string {
  return shell.replaceAll(/<script(?: nonce="[^"]*")?/gu, () => `<script nonce="${nonce}"`);
}

/**
 * Policies with `nonce` put in them as the test's edge puts one: beside each, or in a reporting copy
 * of the enforcing one — and `'strict-dynamic'` beside it, where asked.
 */
function noncedWith(
  policies: Readonly<Record<string, string>>,
  nonce: string,
  asked: URLSearchParams,
): Record<string, string> {
  const source = `'nonce-${nonce}'${asked.get('strict') === '1' ? " 'strict-dynamic'" : ''}`;
  const enforcing = policies['content-security-policy'];
  if (enforcing !== undefined && asked.get('mode') === 'report-only') {
    return { ...policies, 'content-security-policy-report-only': `${enforcing} ${source}` };
  }
  return Object.fromEntries(
    Object.entries(policies).map(([name, policy]) => [name, `${policy} ${source}`]),
  );
}

/** What the backstage makes of a nonce, as the test's edge makes it; false for none of its routes. */
function answeredNonce(asked: URL, request: IncomingMessage, response: ServerResponse): boolean {
  const stamp = asked.pathname === `${BACKSTAGE}stamp`;
  const digest = asked.pathname === `${BACKSTAGE}stamped-digest`;
  if (!stamp && !digest && asked.pathname !== `${BACKSTAGE}nonced`) {
    return false;
  }
  const nonce = asked.searchParams.get('nonce') ?? '';
  if (stamp) {
    state.stamped = (state.stamped ?? 0) + 1;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  request.on('end', () => {
    const sent = Buffer.concat(chunks).toString();
    if (stamp) {
      response.writeHead(200).end(stampedWith(sent, nonce));
      return;
    }
    if (digest) {
      const restamped = stampedWith(sent, nonce);
      const length = Buffer.byteLength(restamped);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sha256: sha256Of(restamped), length }));
      return;
    }
    const policies = JSON.parse(sent) as Record<string, string>;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(noncedWith(policies, nonce, asked.searchParams)));
  });
  return true;
}

/** What the stack kept of the traced request `trace`, as the backstage hands it back. */
/**
 * What the test's middleware decided for a traced request of `tracedPath`: for a segment of the
 * page, a range of it, a request on a validator, a `HEAD`, or in a coding, where the test decides
 * those apart — else for the pathname, or to let it on.
 */
function decisionOf(trace: string, tracedPath: string): OutgoingHttpHeaders {
  const inPart = rangeTraces.has(trace) ? decidedInPart.get(tracedPath) : undefined;
  const onCondition = conditionTraces.has(trace) ? decidedOnCondition.get(tracedPath) : undefined;
  const onHead = headTraces.has(trace) ? decidedOnHead.get(tracedPath) : undefined;
  const inCoding = decidedInCoding.get(`${tracedPath}|${traceCodings.get(trace) ?? 'identity'}`);
  const forSegment = decidedForSegment.get(`${tracedPath}|${traceSegments.get(trace) ?? ''}`);
  const fromSite = decidedFromSite.get(`${tracedPath}|${traceSites.get(trace) ?? ''}`);
  return (
    forSegment ??
    fromSite ??
    inPart ??
    onCondition ??
    onHead ??
    inCoding ??
    decisions.get(tracedPath) ?? { 'x-middleware-next': '1' }
  );
}

function answerTrace(trace: string, method: string | undefined, response: ServerResponse): void {
  // A backstage that fails as a Worker that throws does — with a page of its own, not JSON — or
  // that let the request's record go.
  if (method === 'GET' && state.backstageFails !== undefined) {
    response.writeHead(state.backstageFails, { 'content-type': 'text/html' }).end('<h1>Error</h1>');
    return;
  }
  const tracedPath = traces.get(trace) ?? '';
  const decided = decisionOf(trace, tracedPath);
  // A header set more than once — a cookie each — as as many of its name.
  const headers = Object.entries(decided).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map((each) => [name, each]) : [[name, String(value)]],
  );
  const ran = saidRan.get(trace) !== false || keptUnsaid.has(tracedPath);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      decision:
        !ran || unkept.has(tracedPath) || (headTraces.has(trace) && unkeptOnHead.has(tracedPath))
          ? null
          : { status: decisionStatuses.get(tracedPath) ?? 200, headers },
      regenerated: regenerations.get(tracedPath) ?? null,
      generations: capturedPartGenerations(trace, tracedPath),
    }),
  );
}

/** The part's wire snapshot, using the same metadata shape as the real trace GET. */
function capturedPartGenerations(
  trace: string,
  pathname: string,
): Record<string, unknown> | undefined {
  if (headTraces.has(trace)) return capturedHeadRecords.get(pathname);
  const record = capturedPartRecords.get(pathname);
  if (record === undefined || !traceSegments.has(trace)) return undefined;
  const [scope = '', entryId = ''] = record.split('|', 2);
  const key = kvGenerationKey(scope, entryId);
  const generations = generationsOf(record);
  const entries = Object.entries(generations);
  return Object.fromEntries(
    entries.map(([seq, generation]) => {
      const entry: [string, unknown] = [`${key}|${seq}`, generation];
      return entry;
    }),
  );
}

/** Change the global metadata only after the original redirect fetch and its replay let go. */
function releasedPartTrace(trace: string): void {
  const pathname = traces.get(trace) ?? '';
  const after = afterPartTraces.get(pathname);
  if (after === undefined || !traceSegments.has(trace)) return;
  after.remaining -= 1;
  if (after.remaining === 0) {
    afterPartTraces.delete(pathname);
    after.apply();
  }
}

/** What the backstage answers of a trace or a generation; false for a request of neither. */
function answeredBackstage(
  asked: URL,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (asked.pathname === `${BACKSTAGE}middleware`) {
    // The middleware asked on its own: by default, letting the request on.
    state.middlewareAsked = asked.searchParams.get('path');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(state.middlewareProbe ?? { kind: 'continue', status: 200 }));
    return true;
  }
  if (asked.pathname.startsWith(`${BACKSTAGE}trace/`)) {
    const id = asked.pathname.slice(`${BACKSTAGE}trace/`.length);
    if (request.method === 'DELETE') {
      traceIds.letGo.add(id);
      response.writeHead(204).end();
      releasedPartTrace(id);
      return true;
    }
    if (request.method === 'PUT') {
      registeredAs.set(id, asked.searchParams.get('as'));
      traceIds.registered.add(id);
    } else {
      traceIds.read.add(id);
    }
    answerTrace(id, request.method, response);
    return true;
  }
  if (asked.pathname.startsWith(`${BACKSTAGE}generation/`)) {
    const parts = asked.pathname.slice(`${BACKSTAGE}generation/`.length).split('/');
    const at = parts.map((part) => decodeURIComponent(part)).join('|');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(parts.length === 2 ? generationsOf(at) : (generationHeaders.get(at) ?? null)),
    );
    return true;
  }
  return answeredNonce(asked, request, response);
}

/** An output of a generation, as the backstage names one (`RecordedOutput`). */
interface Output {
  readonly role: string;
  readonly representationKey: string;
  readonly encoding: 'identity';
  readonly sha256: string;
  readonly byteLength: number;
}

/** `body` as the output `role` of `representationKey`. */
function outputOf(role: string, representationKey: string, body: string): Output {
  const bytes = Buffer.from(body);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { role, representationKey, encoding: 'identity', sha256, byteLength: bytes.length };
}

/**
 * What a generation the test names no outputs of holds: every part the test's edge answers with,
 * each as the output it is answered as (`partAskedFor`), and every page's props.
 */
function answeredOutputs(): Output[] {
  const parts = [...partAnswers].map(([key, answer]) => {
    const [, part = ''] = key.split('|', 2);
    return part.startsWith('/')
      ? outputOf('segment', `segment:${part}`, answer.body)
      : outputOf('rsc', 'rsc', answer.body);
  });
  const props = [...answers]
    .filter(([key]) => key.startsWith('/_next/data/'))
    .map(([, answer]) => outputOf('pages-data', 'pages-data', answer.body));
  return [...parts, ...props];
}

/**
 * Every generation of the record at `<scope>|<entry>` the test's edge read, by sequence, as the
 * backstage lists them (`RecordedGeneration`): the ones the test names, each with the outputs it
 * names (`generationOutputs`) or else every one it answers with, complete in itself but where the
 * test names it partial (`partialGenerations`) — or, where it names none, two recorded with no
 * headers that hold every one, the one complete and the other partial.
 */
function generationsOf(record: string): Record<string, unknown> {
  const named = [...generationHeaders].filter(([at]) => at.startsWith(`${record}|`));
  if (named.length === 0) {
    const artifacts = answeredOutputs();
    const source = 'runtime';
    return {
      '1': { headers: {}, artifacts, partial: false, source },
      '2': { headers: {}, artifacts, partial: true, source },
    };
  }
  return Object.fromEntries(
    named.map(([at, headers]) => {
      const artifacts = generationOutputs.get(at) ?? answeredOutputs();
      const partial = partialGenerations.has(at);
      const source = builtGenerations.has(at) ? 'build' : 'runtime';
      const freshness = generationFreshness.get(at);
      const status = generationStatuses.get(at);
      const generation = { headers, artifacts, partial, source, status, freshness };
      return [at.slice(record.length + 1), generation];
    }),
  );
}

/** Whether the answer `response` gives a traced request says the middleware ran (`saidRan`). */
function keepWhetherRan(request: IncomingMessage, response: ServerResponse): void {
  const trace = request.headers['x-upwind-trace'];
  if (typeof trace !== 'string') {
    return;
  }
  const writeHead = response.writeHead.bind(response);
  response.writeHead = ((status: number, headers?: OutgoingHttpHeaders) => {
    // As the account says, where it says: of an answer from what the deployment holds — a shell, a
    // file — or of one handed on for want of a route or a part, or for its route's bypassFor, which
    // the middleware runs ahead of; and never of one handed on otherwise, whatever ran ahead of it.
    const account = String(headers?.['x-arkor-edge'] ?? '');
    const fromStorage = [
      'shell',
      'static;',
      'segment;',
      'payload;',
      'data;',
      'passthrough;reason=route-not-proved',
      'passthrough;reason=bypass-for',
      'passthrough;reason=segment-prefetch',
      'passthrough;reason=rsc-payload',
    ];
    if (fromStorage.some((prefix) => account.startsWith(prefix))) {
      saidRan.set(trace, account.split(';').includes('mw=hit'));
    }
    return writeHead(status, headers);
  }) as typeof response.writeHead;
}

/**
 * The coding the test's edge sends a request in, of those it accepts: brotli first, as the edge
 * prefers it (`negotiateContentEncoding`), or none.
 */
function negotiated(header: string): string {
  const codings = new Set(header.split(',').map((coding) => coding.trim()));
  return ['br', 'gzip'].find((coding) => codings.has(coding)) ?? '';
}

/** What the test's edge compresses a document it composed with, by the coding asked for. */
const CODERS: Readonly<Record<string, (body: string | Buffer) => Buffer>> = {
  br: (body) => brotliCompressSync(body),
  gzip: (body) => gzipSync(body),
};

/**
 * What the test's edge answers a request in one coding alone with, where it compresses the answer:
 * one the test gives as compressed, under the headers it gives (`compressed`); a document it
 * composed (`answeredComposedCoded`). False for any other.
 */
function answeredCoded(
  request: IncomingMessage,
  answer: Answer,
  response: ServerResponse,
): boolean {
  const coding = negotiated(request.headers['accept-encoding'] ?? '');
  const coder = Object.hasOwn(CODERS, coding) ? CODERS[coding] : undefined;
  if (coder === undefined) {
    return false;
  }
  if (answer.compressed !== undefined && answer.compressed !== false) {
    const named = answer.compressed === 'gzip' ? gzipSync : coder;
    const compress = answer.compressed === 'zstd' ? zstdCompressSync : named;
    response.writeHead(answer.status ?? 200, answer.headers).end(compress(answer.body));
    return true;
  }
  return answeredComposedCoded(request, { answer, coding, coder }, response);
}

/**
 * A document the test's edge composed (`shell`), asked for in one coding alone, as the edge sends
 * one: compressed whole in it, varied by what the client accepts, its account saying it was
 * compressed as it went out (`enc=<coding>-live`) — but where the test has it otherwise
 * (`uncoded`). False for any other.
 */
function answeredComposedCoded(
  request: IncomingMessage,
  asked: {
    readonly answer: Answer;
    readonly coding: string;
    readonly coder: (body: string | Buffer) => Buffer;
  },
  response: ServerResponse,
): boolean {
  const { answer, coding, coder } = asked;
  const account = String(answer.headers['x-arkor-edge'] ?? '');
  if (!account.startsWith('shell') || answer.endless === true || answer.uncoded === true) {
    return false;
  }
  const layering =
    answer.layeredForAll === true || String(request.headers['user-agent']).includes('Chrome/');
  const layered = answer.layered === true && coding === 'br' && layering;
  const rendering =
    (layered ? answer.layeredRendering : undefined) ??
    answer.rendering ??
    (layered ? 'br-br' : `${coding}-live`);
  const marked = account.includes(';cont=')
    ? account.replace(';cont=', () => `;enc=${rendering};cont=`)
    : account.replace(';route=', () => `;enc=${rendering};route=`);
  const vary = [
    answer.headers.vary,
    'accept-encoding',
    ...(layered && answer.unvariedByAgent !== true ? ['user-agent'] : []),
  ].filter((name) => name !== undefined);
  response.writeHead(answer.status ?? 200, {
    ...answer.headers,
    'content-encoding': layered ? 'br, br' : coding,
    vary: vary.join(', '),
    'x-arkor-edge': marked,
  });
  const coded = coder(answer.codedBody ?? answer.body);
  response.end(layered ? coder(coded) : coded);
  return true;
}

/**
 * `answer` as the edge hands on a request a rule claims (`claimedWhen`), the Function answering it:
 * with what a test holds for it, too (`when`).
 */
function claimedAnswer(answer: Answer, request: IncomingMessage): Answer {
  const handedOn = { 'x-arkor-edge': 'passthrough;reason=route-not-proved' };
  const ruled = matchingAnswer(answer, request);
  return { ...answer, headers: { ...answer.headers, ...ruled?.headers, ...handedOn } };
}

/**
 * `answer` as a request it is answered otherwise to is: one carrying a cookie (`withCookie`), one
 * without a header (`withoutHeader`), one with it (`withHeader`), or one a test holds for (`when`).
 */
function answerCarrying(answer: Answer | undefined, request: IncomingMessage): Answer | undefined {
  if (answer === undefined) {
    return answer;
  }
  if (answer.claimedWhen?.(request.headers) === true) {
    return claimedAnswer(answer, request);
  }
  const { withCookie: cookie, withoutHeader: lacking, withHeader: having } = answer;
  const pairs = (request.headers.cookie ?? '').split(/;\s*/u);
  const carried = cookie !== undefined && pairs.some((pair) => pair.startsWith(`${cookie.name}=`));
  const lacked = lacking !== undefined && request.headers[lacking.name] === undefined;
  const had = having !== undefined && request.headers[having.name] !== undefined;
  const held = matchingAnswer(answer, request);
  return {
    ...answer,
    headers: {
      ...answer.headers,
      ...(carried && cookie.headers),
      ...(lacked && lacking.headers),
      ...(had && having.headers),
      ...held?.headers,
    },
    ...(held?.status !== undefined && { status: held.status }),
    ...(held?.hangsUp === true && { hangsUp: true }),
    ...(held?.onHead !== undefined && { onHead: held.onHead }),
  };
}

/** The fixture's conditional answer, with the same URL view for whole and handed-on responses. */
function matchingAnswer(answer: Answer, request: IncomingMessage): Answer['when'] {
  const url = new URL(request.url ?? '/', 'http://localhost');
  return answer.when?.test(request.headers, request.method, url) === true ? answer.when : undefined;
}

/**
 * The coding a GET of `pathname` asked to accept, beside the ones asked before it — but where the
 * client router asked for a part of it (`partsAsked`).
 */
function recordCoding(request: IncomingMessage, pathname: string): void {
  const coding = request.headers['accept-encoding'];
  if (typeof coding === 'string' && request.method === 'GET' && request.headers['rsc'] !== '1') {
    codingsAsked.set(pathname, [...(codingsAsked.get(pathname) ?? []), coding]);
  }
}

/** What a request the client router makes for a part of the page at `pathname` is answered with. */
function partAskedFor(
  request: IncomingMessage,
  pathname: string,
  search: string,
): Answer | undefined {
  if (request.headers['rsc'] !== '1') {
    return undefined;
  }
  const segment = request.headers['next-router-segment-prefetch'];
  // A segment by its path; a page's whole payload as a navigation asks for it, or a prefetch of
  // each kind (`rsc-prefetch` for one down to its loading boundary, `rsc-prefetch-<kind>` else).
  const prefetch = request.headers['next-router-prefetch'];
  const kind = prefetch === '1' ? '' : `-${String(prefetch)}`;
  const whole = typeof prefetch === 'string' ? `rsc-prefetch${kind}` : 'rsc';
  const key = `${pathname}|${typeof segment === 'string' ? segment : whole}`;
  // As it is under its own key, in a coding under that coding's too.
  const coding = request.headers['accept-encoding'] ?? 'identity';
  if (coding === 'identity') {
    partsAsked.set(key, { headers: request.headers, search });
    partsAskedEach.set(key, [...(partsAskedEach.get(key) ?? []), request.headers]);
  }
  partsAsked.set(`${key}|${coding}`, { headers: request.headers, search });
  // As the test answers it from the page the router is on, where it does (`<key>|from=<next-url>`).
  const from = request.headers['next-url'];
  const answer =
    (typeof from === 'string' ? partAnswers.get(`${key}|from=${from}`) : undefined) ??
    partAnswers.get(`${key}|${coding}`) ??
    partAnswers.get(key);
  if (answer?.forSearch !== undefined) {
    return answer.forSearch(search);
  }
  if (answer?.unbusted !== undefined && !new URLSearchParams(search).has('_rsc')) {
    return answer.unbusted;
  }
  if (answer !== undefined || typeof segment === 'string') {
    return answer;
  }
  // A page's whole payload the test gives no answer for: handed on to the Function, as the edge
  // hands on one it holds neither the build's nor a runtime generation's of (`composePayload`) —
  // once the middleware ran, where it covers the page.
  return {
    headers: { 'content-type': RSC, 'x-arkor-edge': 'passthrough;reason=rsc-payload;mw=hit' },
    body: 'rendered payload',
  };
}

/**
 * What the test answers a request with: a part of a page asked for apart, or what is at `keyed` —
 * in the coding the request accepts, where the test answers it apart in that (`<keyed>|<coding>`).
 */
function answerAt(
  request: IncomingMessage,
  at: { readonly pathname: string; readonly keyed: string; readonly search: string },
): Answer | undefined {
  const coding = request.headers['accept-encoding'] ?? 'identity';
  return (
    partAskedFor(request, at.pathname, at.search) ??
    answers.get(`${at.keyed}|${coding}`) ??
    answers.get(at.keyed)
  );
}

/**
 * The edge's account of the Function a probe was handed to, as the edge marks a request it took as
 * one; none of any other request.
 */
function probeAccount(probed: string | undefined): OutgoingHttpHeaders {
  return probed === undefined
    ? {}
    : {
        'x-arkor-edge': probedAs.get(probed) ?? `passthrough;reason=function-probe;fn=${probed}`,
        // As the edge marks a request it took as a probe (`EDGE_VALIDATED_HEADER`).
        'x-arkor-edge-validated': '1',
      };
}

/**
 * What the test answers a request for nothing it holds with: a navigation, as Next.js answers one
 * for a page it has none of — its not-found page — and anything else with no body at all.
 */
function answerNotFound(
  request: IncomingMessage,
  response: ServerResponse,
  account: OutgoingHttpHeaders,
): void {
  const navigated = String(request.headers.accept).includes('text/html');
  const page = navigated ? { 'content-type': HTML } : {};
  response.writeHead(404, { ...account, ...page }).end(navigated ? NOT_FOUND : undefined);
}

const server = createServer((request, response) => {
  const asked = new URL(request.url ?? '/', 'http://localhost');
  if (answeredBackstage(asked, request, response)) {
    return;
  }
  keepWhetherRan(request, response);
  // A Function, asked as the edge routes a probe of it: answered as the pathname it is asked for,
  // under the edge's account of the Function it handed the probe to.
  const probed = asked.pathname.startsWith(`${BACKSTAGE}function/`)
    ? decodeURIComponent(asked.pathname.slice(`${BACKSTAGE}function/`.length))
    : undefined;
  const pathname = probed === undefined ? asked.pathname : (asked.searchParams.get('path') ?? '/');
  // Every miss a Function is asked for, whatever its shape, is answered as the one under `MISS`.
  const keyed = probed !== undefined || pathname.startsWith(MISS) ? MISS : pathname;
  recordAsked(request, { pathname, keyed, search: asked.search });
  recordCoding(request, pathname);
  const answer = answerCarrying(
    answerAt(request, { pathname, keyed, search: asked.search }),
    request,
  );
  const account = probeAccount(probed);
  if (answer === undefined) {
    answerNotFound(request, response, account);
    return;
  }
  if (answer.hangsUp === true) {
    request.socket.destroy();
    return;
  }
  // A file the edge served from storage goes out under its digest's tag, as `fileHeaders` has it.
  const served = String(answer.headers['x-arkor-edge'] ?? '').startsWith('static;');
  // As `fileHeaders` has it: under its digest's tag, its length said, and whether a range of it is
  // asked for — all where the test gives none of its own.
  const tagged = served
    ? {
        etag: `"${sha256Of(answer.body)}"`,
        ...(answer.lengthless !== true && {
          'content-length': String(Buffer.byteLength(answer.body)),
        }),
        'accept-ranges': (answer.status ?? 200) === 200 ? 'bytes' : 'none',
        ...answer.headers,
      }
    : {};
  const fileHeaders = { ...answer.headers, ...tagged };
  if (answeredApart(request, { answer, served, headers: fileHeaders }, response)) {
    return;
  }
  if (answeredCoded(request, answer, response)) {
    return;
  }
  response.writeHead(answer.status ?? 200, { ...account, ...answer.headers, ...tagged });
  if (answer.endless === true) {
    answer.opened?.(response);
    response.flushHeaders();
    response.write(answer.body);
    return;
  }
  response.end(answer.body);
});

/** A redirect with flushed headers and an invalid gzip prefix whose body never ends. */
function streamingRedirect(location: string) {
  const closed: Promise<boolean>[] = [];
  const responses: ServerResponse[] = [];
  const answer: Answer = {
    status: 307,
    headers: {
      location,
      'content-encoding': 'gzip',
      'set-cookie': 'from=hop; Path=/',
      'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
    },
    body: 'not a gzip stream',
    endless: true,
    opened: (response) => {
      const ended = Promise.withResolvers<boolean>();
      responses.push(response);
      closed.push(ended.promise);
      response.once('close', () => {
        ended.resolve(true);
      });
    },
  };
  return { answer, responses, closed };
}

/** A redirect's initial responses, then a refresh, all recorded without retaining body streams. */
function initialPartAnswers(
  first: Answer,
  after: Answer,
  seen: string[],
  firstCount = 2,
): (search: string) => Answer {
  return () => {
    const answer = seen.length < firstCount ? first : after;
    seen.push(answer.body);
    return answer;
  };
}

/**
 * A route served from generations of its record the stack's edge read, each as recorded with the
 * route's own headers: what `routeOf` gives a route of a record (`record`).
 */
async function readGenerations(pathname: string, seqs: readonly number[]): Promise<void> {
  const entry = await entryOf(pathname, pathname);
  for (const seq of seqs) {
    generationHeaders.set(`dpl_site|${entry}|${String(seq)}`, { 'content-type': HTML });
  }
}

/** The middleware's decision for `pathname`: to let it on, with the cookie its answer carries. */
function cookieSet(pathname: string): void {
  decisions.set(pathname, { 'x-middleware-next': '1', 'set-cookie': 'seen=1; Path=/' });
}

/** The entry a page's record at `pathname` is kept under, filed under `route`, as the runtime keys it. */
async function entryOf(pathname: string, route = '/items/[id]'): Promise<string> {
  const derived = await deriveEntry('dpl_site', { kind: 'app-page', route, pathname });
  return derived.entryId;
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function blobsOf(): string {
  if (state.bundleDir === undefined) {
    throw new Error('the bundle is not written yet');
  }
  return path.join(state.bundleDir, 'blobs');
}

function fileOf(text: string, contentType: string, immutable = false): StaticFileEntry {
  return { sha256: sha256Of(text), byteLength: Buffer.byteLength(text), contentType, immutable };
}

/** A file the build wrote at `pathname`, as its bundle names one. */
function writtenAs(pathname: string, text: string): DeploymentBundle['staticFiles'][number] {
  return {
    pathname,
    blob: { sha256: sha256Of(text), byteLength: Buffer.byteLength(text), contentType: TEXT },
    immutable: false,
  };
}

/** The files a build wrote that a deploy holds as `staticFiles` holds them, but a kept build's. */
function writtenOf(
  staticFiles: Readonly<Record<string, StaticFileEntry>>,
): DeploymentBundle['staticFiles'] {
  return Object.entries(staticFiles)
    .filter(([, file]) => file.deploymentId === undefined)
    .map(([pathname, file]) => {
      const { sha256, byteLength, contentType } = file;
      return { pathname, blob: { sha256, byteLength, contentType }, immutable: file.immutable };
    });
}

function requiredMember(route: string): string {
  const member = validationPathnameFor(route);
  if (member === undefined) throw new Error('the fixture must name a dynamic class');
  return member;
}

/** A prerendered route, its shell written where the check reads it — finished, `complete`. */
async function routeOf(
  pathname: string,
  shell: string,
  options: {
    /** Whether the build finished the page; a resume completes it otherwise. */
    readonly complete?: boolean;
    readonly headers?: Record<string, string>;
    /** A page the Pages Router renders, whose record is one of its kind. */
    readonly pages?: boolean;
    /** The prefetch segments the build wrote beside the page, by their paths. */
    readonly segments?: Readonly<Record<string, string>>;
    /** The whole payload the build wrote beside a page it finished. */
    readonly payload?: string;
    /** The props the build wrote beside a Pages Router page it finished. */
    readonly pagesData?: string;
    /** Whether the deployment holds the shell in brotli as well, compressed ahead of a request. */
    readonly brShell?: boolean;
    /** Whether the deployment holds each part in brotli and gzip as well, compressed ahead. */
    readonly codedParts?: boolean;
    /**
     * Whether the build left the page a partial fallback, which a deploy seeds no record of: the
     * edge completes each member's shell behind it, into a record of the member's own.
     */
    readonly partialFallback?: boolean;
  } = {},
): Promise<RouteEntry> {
  await writeFile(path.join(blobsOf(), sha256Of(shell)), shell);
  const kind = options.pages === true ? 'pages' : 'app-page';
  const segments = Object.entries(options.segments ?? {});
  const delivery = options.complete === true ? 'complete' : 'resume';
  return {
    pathname,
    status: 200,
    shell: {
      sha256: sha256Of(shell),
      byteLength: Buffer.byteLength(shell),
      contentType: 'text/html; charset=utf-8',
      encoding: 'identity',
    },
    headers: { 'content-type': 'text/html; charset=utf-8', ...options.headers },
    ...(segments.length > 0 && {
      segments: Object.fromEntries(
        await Promise.all(
          segments.map(async ([segmentPath, bytes]) => {
            const part = heldCoded(await partOf(bytes, RSC), options.codedParts);
            return [segmentPath, part] as const;
          }),
        ),
      ),
    }),
    ...(options.payload !== undefined && {
      payload: heldCoded(await partOf(options.payload, RSC), options.codedParts),
    }),
    ...(options.pagesData !== undefined && {
      pagesData: heldCoded(await partOf(options.pagesData, JSON_TYPE), options.codedParts),
    }),
    ...(options.brShell === true && {
      shellEncodings: {
        br: { sha256: sha256Of(`br:${shell}`), byteLength: 1, contentType: HTML, encoding: 'br' },
      },
    }),
    // As the page the build prerendered it as (`prerenderOf`), which a resume names it by.
    prerenderId: `prerender${pathname}`,
    // Under the entry a deploy seeds the stack's cache with for every page it routes, but a
    // partial fallback's.
    ...(options.partialFallback === true
      ? { partialFallback: { route: pathname } }
      : { cache: { ...(await cacheOf(pathname, kind)), delivery } }),
  };
}

/** `part` held in brotli and gzip as well, where `held`: renderings the test's edge sends compressed. */
function heldCoded(part: RouteSegment, held: boolean | undefined): RouteSegment {
  if (held !== true) {
    return part;
  }
  const { artifact } = part;
  return {
    ...part,
    encodings: {
      br: { ...artifact, sha256: sha256Of(`br:${artifact.sha256}`), encoding: 'br' },
      gzip: {
        ...artifact,
        sha256: sha256Of(`gzip:${artifact.sha256}`),
        encoding: 'gzip',
        crc32: 0,
      },
    },
  };
}

/** A part of a page the build wrote as `bytes`, written where the check reads it, as a route holds it. */
async function partOf(bytes: string, contentType: string): Promise<RouteSegment> {
  await writeFile(path.join(blobsOf(), sha256Of(bytes)), bytes);
  return {
    artifact: {
      sha256: sha256Of(bytes),
      byteLength: Buffer.byteLength(bytes),
      contentType,
      encoding: 'identity',
    },
  };
}

/** The entry a deploy seeds the cache with for a page at `pathname`: a class's filed under its route. */
async function cacheOf(
  pathname: string,
  kind: RouteCache['kind'] = 'app-page',
): Promise<Omit<RouteCache, 'delivery'>> {
  const derived = await deriveEntry('dpl_site', { kind, route: pathname, pathname });
  return {
    entryId: derived.entryId,
    kind,
    ...(pathname.includes('[') && { route: pathname }),
  };
}

/** What a resumable shell's postponed state is stored as, where a test needs one at all. */
const POSTPONED_STATE = { sha256: sha256Of('state'), byteLength: 5, contentType: 'text/plain' };

/** A page the build prerendered at `pathname` as `shell`, as its bundle names one. */
function prerenderOf(pathname: string, shell: string, extra: Partial<Prerender> = {}): Prerender {
  return {
    id: `prerender${pathname}`,
    pathname,
    route: pathname,
    parentOutputId: 'app/page',
    groupId: 1,
    routeType: 'page',
    body: { sha256: sha256Of(shell), byteLength: Buffer.byteLength(shell), contentType: HTML },
    // As a deploy routes the shell, `routeOf` gives a route: its type, and to be resumed.
    initialHeaders: { 'content-type': HTML },
    postponed: POSTPONED_STATE,
    ...extra,
  };
}

/** The route of a build a class's members reach its template by, as the manifest's says. */
function routeOnto(dynamic: DynamicRoute): DeploymentBundle['routing']['dynamicRoutes'][number] {
  return {
    sourceRegex: dynamic.sourceRegex,
    destination: dynamic.route,
    ...(dynamic.has !== undefined && { has: [...dynamic.has] }),
    ...(dynamic.missing !== undefined && { missing: [...dynamic.missing] }),
  };
}

/** The query Next.js keys a partial fallback's completions by: each parameter of its class's path. */
function keyedQueryOf(pathname: string): string[] {
  return [...pathname.matchAll(/\[(\w+)\]/gu)].map(([, name]) => `nxtP${String(name)}`);
}

/**
 * The pages a build prerendered for the edge that a deploy makes `routes` of: each with the headers
 * its route holds, which a deploy takes from the shell's own, the requests it is bypassed for, and
 * left to be resumed but where its record is whole — or left a partial fallback, keyed by the
 * class's parameters, which a deploy seeds no record of (`cacheablePrerenders`).
 */
function prerenderedAs(routes: readonly RouteEntry[]): Prerender[] {
  return routes.flatMap((route) => {
    const { sha256, byteLength, contentType } = route.shell;
    const document: Prerender = {
      id: `prerender${route.pathname}`,
      pathname: route.pathname,
      route: route.pathname,
      parentOutputId: 'app/page',
      groupId: 1,
      routeType: 'page',
      body: { sha256, byteLength, contentType },
      initialHeaders: { ...route.headers },
      ...(route.cache?.delivery !== 'complete' && { postponed: POSTPONED_STATE }),
      ...(route.bypassFor !== undefined && { bypassFor: [...route.bypassFor] }),
      ...(route.partialFallback !== undefined && {
        renderingMode: 'PARTIALLY_STATIC',
        partialFallback: true,
        allowQuery: keyedQueryOf(route.pathname),
      }),
    };
    return [document, ...partsPrerenderedAs(route)];
  });
}

/** A part a route holds, as the build's output of it: its bytes, under the page's route and group. */
function partPrerender(route: RouteEntry, pathname: string, part: RouteSegment): Prerender {
  const { sha256, byteLength, contentType } = part.artifact;
  return {
    id: `prerender${pathname}`,
    pathname,
    route: route.pathname,
    parentOutputId: 'app/page',
    groupId: 1,
    body: { sha256, byteLength, contentType },
  };
}

/**
 * The outputs the build wrote beside a route's page that a deploy makes its parts of: each prefetch
 * segment, named by its path; the whole payload, as the page's twin (`/index.rsc`); the props, at
 * their own URL (`pagesDataPathnameUnder`).
 */
function partsPrerenderedAs(route: RouteEntry): Prerender[] {
  const spelled = route.pathname === '/' ? '/index' : route.pathname;
  const segments = Object.entries(route.segments ?? {}).map(([segmentPath, part]) => {
    return {
      ...partPrerender(route, `${spelled}.segments${segmentPath}.segment.rsc`, part),
      segmentPath,
    };
  });
  const { payload, pagesData } = route;
  return [
    ...segments,
    ...(payload === undefined ? [] : [partPrerender(route, `${spelled}.rsc`, payload)]),
    ...(pagesData === undefined
      ? []
      : [partPrerender(route, pagesDataPathnameUnder('test', '', route.pathname), pagesData)]),
  ];
}

/**
 * The bundle a stack holds, as far as the check reads it: a build with a page — or, `exported`, a
 * static export, which has neither a page nor a prerender — and, `catchAll`, a fallback rewrite of
 * every pathname onto the front page, of a request that lacks what `unless` names.
 */
function bundleOf(
  exported: boolean,
  catchAll: boolean,
  unless?: readonly { readonly type: 'header'; readonly key: string }[],
): DeploymentBundle {
  return {
    v: 1,
    deploymentId: 'dpl_site',
    nextVersion: 'test',
    buildId: 'test',
    projectDir: '.',
    generatedAt: AT,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: true,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: catchAll
        ? [
            {
              sourceRegex: '^(?:/(.*))$',
              destination: '/',
              ...(unless !== undefined && { missing: [...unless] }),
            },
          ]
        : [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc',
        prefetchHeader: 'next-router-prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: exported ? [] : [{ id: 'app/page', kind: 'app-page', pathname: '/' }],
    prerenders: [],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: AT.slice(0, 10),
        compatibilityFlags: [],
      },
    },
  };
}

/** How a test's stack is made: what its build holds, and how the manifest holds it. */
interface StackOptions {
  readonly exported?: boolean;
  readonly catchAll?: boolean;
  /** What the catch-all claims a request without. */
  readonly catchAllUnless?: readonly { readonly type: 'header'; readonly key: string }[];
  /** The app Functions the build names, which the check asks for a miss. */
  readonly functions?: readonly string[];
  /**
   * The redirects and rewrites of the build's `next.config` the edge leaves to the Function, as a
   * deploy reserves them: one ahead of the filesystem (`beforeFiles`), or one behind it.
   */
  readonly reservedRoutes?: readonly ReservedRoute[];
  /** The classes of the build's dynamic routes, as a deploy picks them: each onto its template. */
  readonly dynamicRoutes?: readonly DynamicRoute[];
  /** The agents the build's `next.config` sends blocking metadata to (`htmlLimitedBots`). */
  readonly htmlLimitedBots?: string;
  /** The headers the build's `next.config` sets, as a deploy carries its rules. */
  readonly headerRules?: readonly HeaderRule[];
  /** The deployment's id, as its documents name it (Skew Protection's `?dpl=`). */
  readonly dplId?: string;
  /** The files the build wrote, as its bundle names them. */
  readonly written?: DeploymentBundle['staticFiles'];
  /** The site's opt-in to a nonce the edge mints for each document. */
  readonly cspNonce?: CspNonceSetting;
  /** The pages the build prerendered, as its bundle names them. */
  readonly prerendered?: readonly Prerender[];
  /** The rewrites ahead of the filesystem the build's routing holds. */
  readonly beforeFiles?: DeploymentBundle['routing']['beforeFiles'];
  /** The path the application's pages load its `_next` files under (`assetPrefix`). */
  readonly assetPrefix?: string;
  /** Whether the build keeps `trailingSlash`: a file found with a slash after it too. */
  readonly trailingSlash?: boolean;
  /** The app Functions after the first, by name, with the script each is reached by. */
  readonly appFunctions?: Readonly<Record<string, string>>;
  /** The application's locales, where it has `i18n`. */
  readonly i18n?: { readonly defaultLocale: string; readonly locales: readonly string[] };
  /** What the manifest holds otherwise than a deploy derives it from the build: a field, or none. */
  readonly held?: HeldOtherwise;
}

/** The fields of a manifest the check holds to the build, as a test may hold them otherwise. */
type HeldOtherwise = {
  readonly [
    Field in
      | 'headerRules'
      | 'foldedHeaderRules'
      | 'reservedRoutes'
      | 'dynamicRoutes'
      | 'staticFileLocales'
      | 'staticFileTrailingSlash'
      | 'spelledPrefix'
      | 'htmlLimitedBots'
      | 'crawlersStreamed'
      | 'cache'
  ]?: ProjectManifest[Field] | undefined;
} & { readonly routes?: ProjectManifest['routes'] };

/**
 * What a deploy holds a route of the build's as: with the headers the build's shell is answered
 * with, the rules of `next.config` that name it folded in and, on a page the edge may resume, the
 * edge's recovery script permitted.
 */
function heldAsDeployed(bundle: DeploymentBundle, route: RouteEntry): RouteEntry {
  const prerender = bundle.prerenders.find((each) => each.pathname === route.pathname);
  if (prerender === undefined || state.recovery === undefined) {
    return route;
  }
  const built = shellHeaders(bundle, prerender);
  return {
    ...route,
    headers:
      route.cache?.delivery === 'complete' ? built : allowRecoveryScript(built, state.recovery),
  };
}

/** A rule as a deploy lays it on a document it composes: permitting the edge's recovery script. */
function laidOnDocuments(rule: HeaderRule): HeaderRule {
  if (state.recovery === undefined) {
    return rule;
  }
  const widened = allowRecoveryScript(rule.headers, state.recovery);
  const changed = Object.entries(rule.headers).some(([name, value]) => widened[name] !== value);
  return changed ? { ...rule, documentHeaders: widened } : rule;
}

/** `policy` as a deploy holds it on a document the edge composes: permitting its recovery script. */
function permitted(policy: string): string {
  const held = allowRecoveryScript({ 'content-security-policy': policy }, state.recovery ?? '');
  return held['content-security-policy'] ?? policy;
}

/** The bundle a test's stack holds, as the test names what it holds or as `routes` and `staticFiles` do. */
function builtFor(
  routes: readonly RouteEntry[],
  staticFiles: Readonly<Record<string, StaticFileEntry>>,
  options: StackOptions,
): DeploymentBundle {
  const built = bundleOf(
    options.exported === true,
    options.catchAll === true,
    options.catchAllUnless,
  );
  return {
    ...built,
    deploymentId: options.dplId ?? built.deploymentId,
    // As the test names them, or as the manifest holds them: what a deploy serves, the build wrote.
    staticFiles: options.written === undefined ? writtenOf(staticFiles) : [...options.written],
    // As the test names them, or as the manifest holds them: what a deploy routes, the build
    // prerendered for the edge.
    prerenders:
      options.prerendered === undefined ? prerenderedAs(routes) : [...options.prerendered],
    // A page the Pages Router renders is its own entrypoint's.
    entrypoints: [
      ...built.entrypoints,
      ...routes
        .filter((route) => route.cache?.kind === 'pages')
        .map((route) => {
          return {
            id: `pages${route.pathname}`,
            kind: 'pages' as const,
            pathname: route.pathname,
          };
        }),
    ],
    config: {
      ...built.config,
      ...(options.assetPrefix !== undefined && { assetPrefix: options.assetPrefix }),
      ...(options.htmlLimitedBots !== undefined && { htmlLimitedBots: options.htmlLimitedBots }),
      ...(options.trailingSlash === true && { trailingSlash: true }),
      ...(options.i18n !== undefined && {
        i18n: { defaultLocale: options.i18n.defaultLocale, locales: [...options.i18n.locales] },
      }),
    },
    routing: routingFor(built.routing, options),
  };
}

/**
 * A stack serving a deployment of these routes and files, answered as `answers` says: its manifest
 * as a deploy derives it from the build where the check holds it to the build — the routes'
 * headers, the rules of `next.config`, the locales a file is found behind, what the router reads of
 * a path as written — and as the test names it otherwise.
 */
function stackOf(
  routes: readonly RouteEntry[],
  staticFiles: Readonly<Record<string, StaticFileEntry>>,
  options: StackOptions = {},
): LocalStack {
  if (state.origin === undefined || state.bundleDir === undefined) {
    throw new Error('the edge is not listening yet');
  }
  const bundle = builtFor(routes, staticFiles, options);
  // A test that names the pages the build prerendered names the routes it holds them as too.
  const held =
    options.prerendered === undefined
      ? routes.map((route) => heldAsDeployed(bundle, route))
      : [...routes];
  const routing = dynamicRouting(bundle, new Set(held.map((route) => route.pathname)));
  const headerRules = headerRulesOf(bundle).map((rule) => laidOnDocuments(rule));
  const folded = foldedHeaderRulesOf(bundle)?.map((rule) => laidOnDocuments(rule));
  const locales = staticFileLocalesOf(bundle);
  const spelledPrefix = spelledPrefixOf(bundle);
  const derived = buildProjectManifest({
    projectId: 'site',
    runId: 'run_site',
    generatedAt: AT,
    originHost: 'site.example',
    deployment: {
      assetSetHash: 'a'.repeat(64),
      observedAt: AT,
      // As a deploy names it: by the build's own id (`deploymentFingerprintOf`).
      dplId: options.dplId ?? 'dpl_site',
    },
    routes: held,
    app: {
      deploymentId: 'dpl_site',
      scriptName: 'site-app',
      ...(options.appFunctions !== undefined && { functions: { ...options.appFunctions } }),
    },
    staticFiles: { ...staticFiles },
    // As a deploy with a runtime cache names its scope, whatever its routes.
    cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: 'dpl_site' },
    ...routing,
    ...(bundle.config.htmlLimitedBots !== undefined && {
      htmlLimitedBots: bundle.config.htmlLimitedBots,
    }),
    ...(held.some((route) => route.pagesData !== undefined) && {
      pagesDataUnder: { basePath: '', buildId: bundle.buildId },
    }),
    ...(headerRules.length > 0 && { headerRules }),
    ...(folded !== undefined && { foldedHeaderRules: folded }),
    ...(options.assetPrefix !== undefined && {
      staticFileAssetPrefix: { basePath: '', assetPrefix: options.assetPrefix },
    }),
    ...(locales !== undefined && { staticFileLocales: locales }),
    ...(spelledPrefix !== undefined && { spelledPrefix }),
  });
  // Rebuilt, rather than a field deleted: one the test holds as none is absent, as a deploy omits it.
  const manifest = Object.fromEntries(
    Object.entries({ ...derived, ...options.held }).filter(([, value]) => value !== undefined),
  ) as ProjectManifest;
  const registered = new URL(state.origin);
  registered.protocol = 'https:';
  return {
    url: state.origin,
    siteOrigins: [
      registered.origin,
      'https://preview.example',
      'https://site.example',
      'https://cdn.elsewhere.example',
      'https://github.io',
      'https://www.example.com',
    ],
    // The test's server stands in for the Functions too, asked on the backstage.
    functions: options.functions ?? [],
    backstage: new URL(BACKSTAGE, state.origin),
    bundleDir: state.bundleDir,
    bundle,
    deploymentId: 'dpl_site',
    manifest,
    // As the stack runs them: the Functions the manifest names, as a deploy names them.
    app: manifest.app,
    // The policy every answer of the test's edge names (`policy=default`).
    policy: { ...DEFAULT_DELIVERY_POLICY, id: 'default' },
    cspNonce: options.cspNonce,
    dispose: () => Promise.resolve(),
  };
}

/** Where a rule of the build's sends what it claims: no file of the build, so the Function's. */
const CLAIMED_DESTINATION = '/claimed-by-a-rule';

/** A redirect or rewrite of `next.config` a deploy reserves as `reserved` says, as the build routes it. */
function routeOfRule(reserved: ReservedRoute): DeploymentBundle['routing']['afterFiles'][number] {
  return {
    sourceRegex: reserved.sourceRegex,
    destination: CLAIMED_DESTINATION,
    ...(reserved.has !== undefined && { has: [...reserved.has] }),
    ...(reserved.missing !== undefined && { missing: [...reserved.missing] }),
  };
}

/** A header rule of `next.config`, as the build routes it: ahead of the middleware. */
function routeOfHeaders(rule: HeaderRule): DeploymentBundle['routing']['beforeMiddleware'][number] {
  return {
    sourceRegex: rule.sourceRegex,
    headers: { ...rule.headers },
    ...(rule.has !== undefined && { has: [...rule.has] }),
    ...(rule.missing !== undefined && { missing: [...rule.missing] }),
  };
}

/**
 * `stack` as one whose build has a middleware with `matchers`, which the stack runs: in the build,
 * and in the manifest as a deploy carries them.
 */
function withMiddleware(
  stack: LocalStack,
  matchers: readonly {
    readonly sourceRegex: string;
    readonly source?: string;
    readonly has?: readonly RouteHas[];
    readonly missing?: readonly RouteHas[];
  }[],
): LocalStack {
  const app = { ...stack.app, middlewareScriptName: 'site-middleware' };
  // A matcher's conditions, in arrays of the build's and the manifest's own.
  const conditions = (matcher: (typeof matchers)[number]) => {
    return {
      ...(matcher.has !== undefined && { has: [...matcher.has] }),
      ...(matcher.missing !== undefined && { missing: [...matcher.missing] }),
    };
  };
  const middleware = {
    matchers: matchers.map((matcher) => {
      return {
        sourceRegex: matcher.sourceRegex,
        ...(matcher.source !== undefined && { source: matcher.source }),
        ...conditions(matcher),
      };
    }),
  };
  // A deploy carries a matcher's pattern and conditions alone, not the source it was compiled from.
  const carried = {
    matchers: matchers.map((each) => ({ sourceRegex: each.sourceRegex, ...conditions(each) })),
  };
  return {
    ...stack,
    bundle: { ...stack.bundle, middleware },
    app,
    manifest: { ...stack.manifest, app, middleware: carried },
  };
}

/** The routing a test's build holds: the build's own, and what the test adds to it. */
function routingFor(
  built: DeploymentBundle['routing'],
  options: StackOptions,
): DeploymentBundle['routing'] {
  const reserved = options.reservedRoutes ?? [];
  return {
    ...built,
    beforeMiddleware: (options.headerRules ?? []).map((rule) => routeOfHeaders(rule)),
    // The rewrite `next build` writes from the asset prefix, first, ahead of the build's own.
    beforeFiles: [
      ...(options.assetPrefix === undefined ? [] : [assetPrefixRoute(options.assetPrefix)]),
      ...(options.beforeFiles ?? []),
      ...reserved.filter((rule) => rule.beforeFiles === true).map((rule) => routeOfRule(rule)),
    ],
    afterFiles: reserved
      .filter((rule) => rule.beforeFiles !== true)
      .map((rule) => routeOfRule(rule)),
    // The routes a class's members reach it by, as the build routes them to its template.
    ...(options.dynamicRoutes !== undefined && {
      dynamicRoutes: options.dynamicRoutes.map((dynamic) => routeOnto(dynamic)),
    }),
  };
}

/** A rule ahead of the filesystem that claims the front page for what `rule` asks of a request. */
function frontRule(rule: Pick<ReservedRoute, 'has' | 'missing'>): ReservedRoute {
  return { sourceRegex: '^/$', beforeFiles: true, ...rule };
}

/** A rule of `next.config` that sets `cookie` on the front page's segment prefetch of `segment`. */
function segmentCookieRule(segment: string, cookie: string): HeaderRule {
  return {
    sourceRegex: '^/$',
    has: [
      { type: 'header', key: 'rsc', value: '1' },
      { type: 'header', key: 'next-router-segment-prefetch', value: segment },
    ],
    headers: { 'set-cookie': cookie },
  };
}

/** Whether a request carries a cookie of each of `names`. */
function carryingEach(...names: string[]): (headers: IncomingMessage['headers']) => boolean {
  return (headers) => {
    const pairs = (headers.cookie ?? '').split(/;\s*/u);
    return names.every((name) => pairs.some((pair) => pair.startsWith(`${name}=`)));
  };
}

/**
 * `answer`, handed on for want of a route to a request without each of the cookies `names` — as the
 * edge hands on one a rule claims for lacking them, which a navigation another site began makes
 * where the browser keeps them from it (`SameSite=Strict`).
 */
function claimedWithout(answer: Answer, ...names: string[]): Answer {
  return { ...answer, claimedWhen: (headers) => !carryingEach(...names)(headers) };
}

/** Whether a request is Chrome's on a desktop, typed or bookmarked. */
function typedByChrome(headers: IncomingMessage['headers']): boolean {
  return headers['sec-fetch-site'] === 'none' && headers['sec-ch-ua-mobile'] === '?0';
}

/** Whether a request is a navigation from a page of the site's own origin. */
function navigatedFromOwnOrigin(headers: IncomingMessage['headers']): boolean {
  return headers['sec-fetch-site'] === 'same-origin' && headers['sec-fetch-mode'] === 'navigate';
}

/** A rule ahead of the filesystem that claims `/about` for a request without the cookie `key`. */
function aboutWithout(key: string): ReservedRoute {
  return { sourceRegex: '^/about$', beforeFiles: true, missing: [{ type: 'cookie', key }] };
}

/** A rule ahead of the filesystem that claims `/app.js` for what `rule` asks of a request. */
function appScriptRule(rule: Pick<ReservedRoute, 'has' | 'missing'>): ReservedRoute {
  return { sourceRegex: String.raw`^/app\.js$`, beforeFiles: true, ...rule };
}

/** The rewrite `next build` writes for an `assetPrefix`, onto the files under the base path. */
function assetPrefixRoute(prefix: string): DeploymentBundle['routing']['beforeFiles'][number] {
  const escaped = prefix.replaceAll('/', String.raw`\/`);
  return {
    source: `${prefix}/_next/:path+`,
    sourceRegex: String.raw`^${escaped}\/_next\/(.+)$`,
    destination: '/_next/$1',
  };
}

/** An asset of the build, which the check asks for with the deployment's id as well. */
const ASSET = '/_next/static/chunks/a.js';

/** The same ordered phrases as a single-line regex, without unbounded backtracking. */
function includesInLineOrder(value: string | undefined, before: string, after: string): boolean {
  return (
    value?.split(/[\n\r\u{2028}\u{2029}]/u).some((line) => {
      const at = line.indexOf(before);
      return at !== -1 && line.includes(after, at + before.length);
    }) ?? false
  );
}

/** A failure of `ASSET`, as each of its requests comes to it: as named, then with `?dpl=`. */
function assetFailures(reason: string): { path: string; reason: string }[] {
  return [
    { path: ASSET, reason },
    { path: `${ASSET}?dpl=dpl_site`, reason },
  ];
}

/** The edge's account of a page the build finished, answered whole from `route`'s shell. */
function finishedAccount(route: string): string {
  return `shell;strategy=edge;src=kv;m=0000;policy=default;cont=none;mw=hit;route=${route}`;
}

/** A page the build finished (`shell`), answered whole from `route`'s shell, the middleware run. */
function finishedAnswer(shell: string, route: string): Answer {
  return {
    headers: {
      ...documentAnswer(shell, `mw=hit;route=${route}`).headers,
      'x-arkor-edge': finishedAccount(route),
    },
    body: shell,
  };
}

/** A part of a page as the edge answers it from what the build wrote, its account a `kind`'s. */
function partAnswer(kind: string, body: string, headers: OutgoingHttpHeaders = {}): Answer {
  return {
    headers: {
      'content-type': RSC,
      vary: PART_VARY,
      'x-arkor-edge': `${kind};src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000`,
      ...headers,
    },
    body,
  };
}

/** A prefetch segment as the edge answers it: the postponed part of the page (`x-nextjs-postponed: 2`). */
function segmentAnswer(body: string): Answer {
  return partAnswer('segment', body, { 'x-nextjs-postponed': '2' });
}

/** A prefetch segment as the edge answers it behind the middleware, which makes it one visitor's. */
function segmentBehindMiddleware(body: string): Answer {
  const answer = segmentAnswer(body);
  const account = `${String(answer.headers['x-arkor-edge'])};mw=hit`;
  return {
    ...answer,
    headers: { ...answer.headers, 'x-arkor-edge': account, 'cache-control': GATED },
  };
}

/** A request the edge handed on to the Function, of `type`, as `account` says it did. */
function handedOnAs(account: string, type = HTML): Answer {
  return { headers: { 'content-type': type, 'x-arkor-edge': account }, body: 'rendered' };
}

/** A document the edge composed, beginning with `shell`, as `marker` says it composed it. */
function documentAnswer(shell: string, marker: string): Answer {
  return {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // As the edge holds a document it composed: one visitor's.
      'cache-control': 'no-store, no-transform',
      'x-arkor-edge': `shell;strategy=edge;src=kv;m=0000;policy=default;cont=resume;${marker}`,
    },
    body: shell + REST,
  };
}

describe('what the check makes of the middleware', () => {
  beforeAll(async () => {
    state.bundleDir = await mkdtemp(path.join(tmpdir(), 'upwind-local-check-'));
    state.recovery = await recoveryScriptCspSource();
    await mkdir(blobsOf());
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    state.origin = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  });

  beforeEach(() => {
    state.backstageFails = undefined;
    state.stamped = 0;
    state.middlewareProbe = undefined;
    state.middlewareAsked = undefined;
    generationHeaders.clear();
    generationOutputs.clear();
    capturedPartRecords.clear();
    capturedHeadRecords.clear();
    afterPartTraces.clear();
    partialGenerations.clear();
    generationStatuses.clear();
    builtGenerations.clear();
    modes.clear();
    queries.clear();
    cookies.clear();
    registeredAs.clear();
    restored.clear();
    answers.clear();
    partAnswers.clear();
    partsAsked.clear();
    partsAskedEach.clear();
    codingsAsked.clear();
    decisions.clear();
    decisionStatuses.clear();
    decidedInPart.clear();
    rangeTraces.clear();
    decidedOnCondition.clear();
    conditionTraces.clear();
    decidedOnHead.clear();
    headTraces.clear();
    traces.clear();
    for (const ids of Object.values(traceIds)) {
      ids.clear();
    }
    accepted.clear();
    agents.clear();
    agentsAsked.clear();
    regenerations.clear();
    probedAs.clear();
    hosts.clear();
    destinations.clear();
    askedHeaders.clear();
    askedHeadersEach.clear();
    unkept.clear();
    decidedInCoding.clear();
    traceCodings.clear();
    decidedForSegment.clear();
    traceSegments.clear();
    decidedFromSite.clear();
    traceSites.clear();
    generationFreshness.clear();
    saidRan.clear();
    keptUnsaid.clear();
    unkeptOnHead.clear();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    if (state.bundleDir !== undefined) {
      await rm(state.bundleDir, { recursive: true, force: true });
    }
  });

  describe('a file it ran on', () => {
    const files = { '/a.txt': fileOf('kept bytes', TEXT), '/b.txt': fileOf('other bytes', TEXT) };
    const asItself: Answer = {
      headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
      body: 'other bytes',
    };

    it('is skipped where the middleware rewrote it onto another file of the build', async () => {
      decisions.set('/a.txt', { 'x-middleware-rewrite': '/b.txt' });
      // Served as /b.txt, and held as one the middleware had a say on that set no policy of its own.
      answers.set('/a.txt', {
        ...asItself,
        headers: {
          ...asItself.headers,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
      });
      answers.set('/b.txt', asItself);

      await expect(checkStack(stackOf([], files))).resolves.toStrictEqual({
        checked: 1,
        failures: [],
        skipped: [
          { path: '/a.txt', reason: "the application's middleware rewrote it onto /b.txt" },
        ],
      });
    });

    it('fails where the Function answered it in the edge’s place, whatever it answered', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'x-arkor-edge': 'passthrough;reason=static-file' },
        body: 'kept bytes',
      });
      answers.set('/b.txt', asItself);
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            'not answered by the edge from storage (x-arkor-edge: passthrough;reason=static-file)',
        },
      ]);
    });

    it('is judged as its own answer where its own bytes came back, another file holding them too', async () => {
      const twins = { ...files, '/c.txt': fileOf('kept bytes', TEXT) };
      const wrongType = 'application/octet-stream';
      answers.set('/a.txt', {
        headers: { 'content-type': wrongType, 'x-arkor-edge': `${FILE_EDGE};mw=hit` },
        body: 'kept bytes',
      });
      answers.set('/b.txt', asItself);
      answers.set('/c.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], twins));

      expect(result.failures).toStrictEqual([
        { path: '/a.txt', reason: `answered as ${wrongType}, not ${TEXT}` },
      ]);
    });

    it('is asked for as a browser asks for a file of a page, accepting any type', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      answers.set('/b.txt', asItself);
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([]);
      expect(accepted.get('/a.txt')).toBe('*/*');
    });

    it('is skipped as the file a rewrite names, where that file holds the same bytes as its own', async () => {
      const empty = { '/empty.txt': fileOf('', TEXT), '/empty.css': fileOf('', 'text/css') };
      decisions.set('/empty.txt', { 'x-middleware-rewrite': '/empty.css' });
      answers.set('/empty.txt', {
        headers: {
          'content-type': 'text/css',
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: '',
      });
      answers.set('/empty.css', {
        headers: {
          'content-type': 'text/css',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: '',
      });
      const result = await checkStack(stackOf([], empty));

      expect(result).toStrictEqual({
        checked: 1,
        failures: [],
        skipped: [
          { path: '/empty.txt', reason: "the application's middleware rewrote it onto /empty.css" },
        ],
      });
    });

    it('fails where the file a rewrite names comes back as another type than that file', async () => {
      const empty = { '/empty.txt': fileOf('', TEXT), '/empty.css': fileOf('', 'text/css') };
      decisions.set('/empty.txt', { 'x-middleware-rewrite': '/empty.css' });
      answers.set('/empty.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: '',
      });
      answers.set('/empty.css', {
        headers: {
          'content-type': 'text/css',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: '',
      });
      const result = await checkStack(stackOf([], empty));

      expect(result.failures).toStrictEqual([
        {
          path: '/empty.txt',
          reason: `rewritten onto /empty.css, and answered as ${TEXT}, not text/css`,
        },
      ]);
    });

    it('is served under its digest as its entity tag, or under the one the middleware set', async () => {
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': REVALIDATE,
          etag: '"stale"',
          'x-arkor-edge': FILE_EDGE,
        },
        body: 'kept bytes',
      });
      answers.set('/b.txt', asItself);
      const stale = await checkStack(stackOf([], files));
      decisions.set('/a.txt', { 'x-middleware-next': '1', etag: '"its own"' });
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          etag: '"its own"',
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      });
      const own = await checkStack(stackOf([], files));

      expect(stale.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: `answered under the entity tag "stale", not "${sha256Of('kept bytes')}"`,
        },
      ]);
      expect(own.failures).toStrictEqual([]);
    });

    it("says Accept-Ranges as the middleware set it in place of the edge's, and fails saying the edge's over it", async () => {
      decisions.set('/a.txt', { 'x-middleware-next': '1', 'accept-ranges': 'none' });
      const gated = {
        'content-type': TEXT,
        'cache-control': GATED,
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      };
      answers.set('/b.txt', asItself);
      // As the edge lays the middleware's headers over its own (`fileHeaders`), ranges still served.
      answers.set('/a.txt', { headers: { ...gated, 'accept-ranges': 'none' }, body: 'kept bytes' });
      const set = await checkStack(stackOf([], files));
      answers.set('/a.txt', {
        headers: { ...gated, 'accept-ranges': 'bytes' },
        body: 'kept bytes',
      });
      const overridden = await checkStack(stackOf([], files));

      expect(set.failures).toStrictEqual([]);
      expect(overridden.failures).toStrictEqual([
        { path: '/a.txt', reason: 'answered with Accept-Ranges bytes, not none' },
      ]);
    });

    it('fails where another file came back but the middleware rewrote nothing', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'x-arkor-edge': `${FILE_EDGE};mw=hit` },
        body: 'other bytes',
      });
      answers.set('/b.txt', asItself);
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        { path: '/a.txt', reason: 'answered 11 bytes other than its own 10' },
      ]);
    });

    it('fails where its bytes are no file of the build', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'x-arkor-edge': `${FILE_EDGE};mw=hit` },
        body: 'neither',
      });
      answers.set('/b.txt', asItself);
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        { path: '/a.txt', reason: 'answered 7 bytes other than its own 10' },
      ]);
    });

    /** A rewrite ahead of the filesystem of `/a.txt` for a request carrying `x-rewrite: 1`. */
    const rewritesMarked: ReservedRoute = {
      sourceRegex: String.raw`^/a\.txt$`,
      beforeFiles: true,
      has: [{ type: 'header', key: 'x-rewrite', value: '1' }],
    };
    /** What the middleware leaves on a request it marks for that rewrite, as `NextResponse.next` lists it. */
    const marked = {
      'x-middleware-next': '1',
      'x-middleware-override-headers': 'x-rewrite',
      'x-middleware-request-x-rewrite': '1',
    };
    const handedOnClaimed: Answer = {
      headers: { 'content-type': TEXT, 'x-arkor-edge': 'passthrough;reason=reserved' },
      body: 'rewritten',
    };

    it('is skipped where the middleware changed its headers into a request a rule claims', async () => {
      decisions.set('/a.txt', marked);
      answers.set('/a.txt', handedOnClaimed);
      answers.set('/b.txt', asItself);
      const result = await checkStack(stackOf([], files, { reservedRoutes: [rewritesMarked] }));

      expect(result.failures).toStrictEqual([]);
      expect(result.skipped).toContainEqual({
        path: '/a.txt',
        reason:
          "the application's middleware changed the request into one a redirect or rewrite of next.config claims",
      });
    });

    it('fails where it was handed on as claimed, though the middleware changed nothing a rule claims', async () => {
      // The middleware lets it through as it came: no rule claims what it left.
      decisions.set('/a.txt', { 'x-middleware-next': '1' });
      answers.set('/a.txt', handedOnClaimed);
      answers.set('/b.txt', asItself);
      const result = await checkStack(stackOf([], files, { reservedRoutes: [rewritesMarked] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            'not answered by the edge from storage (x-arkor-edge: passthrough;reason=reserved)',
        },
      ]);
    });

    it('is judged no further on a range of it the middleware marks for a rule that claims it', async () => {
      // The whole file let through; the range asked again marked, with its range kept.
      decidedInPart.set('/a.txt', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'range,x-rewrite',
        'x-middleware-request-range': 'bytes=1-9',
        'x-middleware-request-x-rewrite': '1',
      });
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
        inPart: handedOnClaimed,
      });
      answers.set('/b.txt', asItself);
      const result = await checkStack(stackOf([], files, { reservedRoutes: [rewritesMarked] }));

      expect(result.failures).toStrictEqual([]);
    });
  });

  describe('how an immutable file is held', () => {
    const script = 'console.log(1);';
    const files = { [ASSET]: fileOf(script, SCRIPT, true) };
    const answerWith = (headers: OutgoingHttpHeaders): void => {
      answers.set('/_next/static/chunks/a.js', {
        headers: { 'content-type': SCRIPT, ...headers },
        body: script,
      });
    };

    it('is kept from shared caches where the middleware ran and set no Cache-Control', async () => {
      answerWith({ 'cache-control': GATED, 'x-arkor-edge': `${FILE_EDGE};mw=hit` });
      const kept = await checkStack(stackOf([], files));
      answerWith({ 'cache-control': IMMUTABLE, 'x-arkor-edge': `${FILE_EDGE};mw=hit` });
      const shared = await checkStack(stackOf([], files));

      expect(kept).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(shared.failures).toStrictEqual(
        assetFailures("answered for shared caches to keep, though the answer is one visitor's"),
      );
    });

    it("is held as the middleware set it, where nothing makes the answer one visitor's", async () => {
      decisions.set('/_next/static/chunks/a.js', {
        'x-middleware-next': '1',
        'cache-control': 'public, max-age=60',
      });
      answerWith({ 'cache-control': 'public, max-age=60', 'x-arkor-edge': `${FILE_EDGE};mw=hit` });
      const kept = await checkStack(stackOf([], files));
      answerWith({ 'cache-control': GATED, 'x-arkor-edge': `${FILE_EDGE};mw=hit` });
      const replaced = await checkStack(stackOf([], files));

      expect(kept).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(replaced.failures).toStrictEqual(
        assetFailures(
          `answered with Cache-Control ${GATED}, not the middleware's own, public, max-age=60`,
        ),
      );
    });

    it('is immutable, where nothing else had a say', async () => {
      answerWith({ 'cache-control': GATED, 'x-arkor-edge': FILE_EDGE });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual(
        assetFailures(`not answered as immutable (${IMMUTABLE}), but ${GATED}`),
      );
    });

    it('is revalidated at every use, where the build did not mark it immutable', async () => {
      const mutable = { '/robots.txt': fileOf('User-agent: *', TEXT) };
      answers.set('/robots.txt', {
        headers: { 'content-type': TEXT, 'cache-control': IMMUTABLE, 'x-arkor-edge': FILE_EDGE },
        body: 'User-agent: *',
      });
      const result = await checkStack(stackOf([], mutable));

      expect(result.failures).toStrictEqual([
        {
          path: '/robots.txt',
          reason: `not answered as one revalidated at every use (${REVALIDATE}), but ${IMMUTABLE}`,
        },
      ]);
    });

    it('keeps the year an immutable file is held for, not merely the word', async () => {
      answerWith({ 'cache-control': 'max-age=0, immutable', 'x-arkor-edge': FILE_EDGE });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual(
        assetFailures(`not answered as immutable (${IMMUTABLE}), but max-age=0, immutable`),
      );
    });

    it('is not kept from shared caches by a private naming fields, which they may store the rest of', async () => {
      cookieSet('/_next/static/chunks/a.js');
      answerWith({
        'cache-control': 'private="set-cookie, x-id", max-age=0',
        'set-cookie': ['seen=1; Path=/'],
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual(
        assetFailures("answered for shared caches to keep, though the answer is one visitor's"),
      );
    });

    it('is not kept from shared caches by a no-store that carries a value, which is none', async () => {
      cookieSet('/_next/static/chunks/a.js');
      answerWith({
        'cache-control': 'no-store=foo',
        'set-cookie': ['seen=1; Path=/'],
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual(
        assetFailures("answered for shared caches to keep, though the answer is one visitor's"),
      );
    });

    it('is held as a rule of next.config sets it, where one does', async () => {
      const ruled = {
        sourceRegex: '^/_next/static/(.*)$',
        headers: { 'Cache-Control': 'public, max-age=60' },
      };
      answerWith({ 'cache-control': IMMUTABLE, 'x-arkor-edge': FILE_EDGE });
      const result = await checkStack(stackOf([], files, { headerRules: [ruled] }));

      expect(result.failures).toStrictEqual(
        assetFailures(
          `answered with Cache-Control ${IMMUTABLE}, not the one a rule of next.config sets, public, max-age=60`,
        ),
      );
    });

    it('is held by no shared cache by a header of its own, where the answer is private', async () => {
      cookieSet('/_next/static/chunks/a.js');
      answerWith({
        'cache-control': GATED,
        'cdn-cache-control': 'public, max-age=60',
        'set-cookie': ['seen=1; Path=/'],
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual(
        assetFailures(
          "answered with cdn-cache-control, by which a shared cache keeps it, though the answer is one visitor's",
        ),
      );
    });

    it("is kept from shared caches, where a cookie makes the answer one visitor's", async () => {
      cookieSet('/_next/static/chunks/a.js');
      answerWith({
        'cache-control': IMMUTABLE,
        'set-cookie': ['seen=1; Path=/'],
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual(
        assetFailures("answered for shared caches to keep, though the answer is one visitor's"),
      );
    });
  });

  describe('a file, asked as the browsers validation asks as', () => {
    const files = { '/a.txt': fileOf('kept bytes', TEXT) };
    const chromeOnly: ReservedRoute = {
      sourceRegex: String.raw`^/a\.txt$`,
      beforeFiles: true,
      has: [{ type: 'header', key: 'user-agent', value: '.*(Chrome|upwind).*' }],
    };

    it.each([
      {
        label: 'a script destination',
        matches: (headers: IncomingMessage['headers']) => headers['sec-fetch-dest'] === 'script',
      },
      {
        label: 'a Chrome user agent',
        matches: (headers: IncomingMessage['headers']) =>
          headers['user-agent']?.includes('Chrome') === true,
      },
    ])('fails browser-specific middleware errors selected by $label', async ({ matches }) => {
      const pathname = '/chunk.js';
      const script = { [pathname]: fileOf('kept script', SCRIPT) };
      answers.set(pathname, {
        headers: {
          'content-type': SCRIPT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept script',
        when: { test: matches, status: 500 },
      });
      decisions.set(pathname, { 'x-middleware-next': '1' });

      const result = await checkStack(
        withMiddleware(stackOf([], script), [{ sourceRegex: '^/chunk[.]js$' }]),
      );

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ path: pathname });
      expect(result.failures[0]?.reason).toContain('500');
      expect(agentsAsked.get(pathname)).toContain('upwind-local-check/1.0');
    });

    it.each([
      {
        label: 'Range',
        matches: (headers: IncomingMessage['headers']) => headers.range !== undefined,
      },
      {
        label: 'If-None-Match',
        matches: (headers: IncomingMessage['headers']) => headers['if-none-match'] !== undefined,
      },
      {
        label: 'HEAD',
        matches: (headers: IncomingMessage['headers'], method: string | undefined) =>
          method === 'HEAD' && headers['sec-fetch-dest'] === 'script',
      },
    ])('checks Chrome-specific $label file follow-ups', async ({ matches }) => {
      const pathname = '/chunk.js';
      const script = { [pathname]: fileOf('kept script', SCRIPT) };
      const selected = new Set<boolean>();
      answers.set(pathname, {
        headers: {
          'content-type': SCRIPT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept script',
        when: {
          test: (headers, method) => {
            const broken =
              headers['user-agent']?.includes('Chrome') === true && matches(headers, method);
            selected.add(broken);
            return broken;
          },
          headers: { 'x-arkor-edge': 'static;policy=other;mw=hit;enc=identity' },
        },
      });
      decisions.set(pathname, { 'x-middleware-next': '1' });

      const result = await checkStack(
        withMiddleware(stackOf([], script), [{ sourceRegex: '^/chunk[.]js$' }]),
      );

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ path: pathname });
      expect(result.failures[0]?.reason).toContain('not answered under the delivery policy');
      expect(selected.has(true)).toBe(true);
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('checks browser range follow-ups when a conditional rule runs without middleware', async () => {
      const pathname = '/chunk.js';
      const script = { [pathname]: fileOf('kept script', SCRIPT) };
      const ranged: HeaderRule = {
        sourceRegex: '^/chunk[.]js$',
        has: [
          { type: 'header', key: 'user-agent', value: '.*Chrome.*' },
          { type: 'header', key: 'range' },
        ],
        headers: { 'x-ranged': '1' },
      };
      const selected = new Set<boolean>();
      answers.set(pathname, {
        headers: { 'content-type': SCRIPT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept script',
        when: {
          test: (headers) => {
            const broken =
              headers['user-agent']?.includes('Chrome') === true && headers.range !== undefined;
            selected.add(broken);
            return broken;
          },
          headers: { 'cache-control': GATED },
        },
      });

      const result = await checkStack(stackOf([], script, { headerRules: [ranged] }));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain('x-ranged');
      expect(selected.has(true)).toBe(true);
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('checks the prover before browser requests can warm pathname-specific middleware state', async () => {
      const pathname = '/chunk.js';
      const script = { [pathname]: fileOf('kept script', SCRIPT) };
      let warmed = false;
      const observedAgents: string[] = [];
      answers.set(pathname, {
        headers: {
          'content-type': SCRIPT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept script',
        when: {
          test: (headers) => {
            const agent = headers['user-agent'] ?? '';
            observedAgents.push(agent);
            if (agent.includes('Mozilla')) warmed = true;
            return agent === 'upwind-local-check/1.0' && !warmed;
          },
          status: 500,
        },
      });
      decisions.set(pathname, { 'x-middleware-next': '1' });

      const result = await checkStack(
        withMiddleware(stackOf([], script), [{ sourceRegex: '^/chunk[.]js$' }]),
      );

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain('500');
      expect(observedAgents[0]).toBe('upwind-local-check/1.0');
      expect(warmed).toBe(false);
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('checks the prover and each browser when every file response is healthy', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });

      const result = await checkStack(stackOf([], files));
      const asked = agentsAsked.get('/a.txt') ?? [];

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(asked).toContain('upwind-local-check/1.0');
      expect(asked.some((agent) => agent?.includes('Chrome') === true)).toBe(true);
      expect(asked.some((agent) => agent?.includes('iPhone') === true)).toBe(true);
      expect(asked.some((agent) => agent?.includes('Firefox') === true)).toBe(true);
      expect(asked.some((agent) => agent?.includes('Macintosh') === true)).toBe(true);
      expect(asked.some((agent) => agent?.includes('Android') === true)).toBe(true);
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('is asked as the next browser where a rule claims the check and Chrome', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files, { reservedRoutes: [chromeOnly] }));
      const asked = agentsAsked.get('/a.txt') ?? [];

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(asked.some((agent) => agent?.includes('iPhone') === true)).toBe(true);
      expect(
        asked.every(
          (agent) => agent?.includes('Chrome') !== true && agent !== 'upwind-local-check/1.0',
        ),
      ).toBe(true);
    });

    it('is asked with the Fetch Metadata a browser sends for it, where a rule claims a request without', async () => {
      const withoutMetadata: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files, { reservedRoutes: [withoutMetadata] }));
      const asked = askedHeadersEach.get('/a.txt') ?? [];

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(
        asked.some((headers) => headers['user-agent']?.includes('Windows NT 10.0') === true),
      ).toBe(true);
      expect(asked.every((headers) => headers['sec-fetch-dest'] !== undefined)).toBe(true);
    });

    it('fails where a rule that asks of the agent claims every browser the check asks as', async () => {
      const mozilla: ReservedRoute = {
        ...chromeOnly,
        has: [{ type: 'header', key: 'user-agent', value: '.+' }],
      };
      const result = await checkStack(stackOf([], files, { reservedRoutes: [mozilla] }));

      expect(result.checked).toBe(1);
      expect(result.failures[0]?.reason).toMatch(
        /claims every browser the check asks for the file as/u,
      );
    });

    it('reads a rule that asks of the encodings accepted by those the front line hands every request with', async () => {
      // Every request reaches the edge accepting what Cloudflare's front line sets in the visitor's
      // place (`gzip, br`): a rule that asks for nothing coded claims none of them.
      const unencoded: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'accept-encoding', value: 'identity' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const unclaimed = await checkStack(stackOf([], files, { reservedRoutes: [unencoded] }));
      // And one that asks for brotli claims every one, whoever asks: the application's.
      const brotli: ReservedRoute = {
        ...unencoded,
        has: [{ type: 'header', key: 'accept-encoding', value: '.*br.*' }],
      };
      const claimed = await checkStack(stackOf([], files, { reservedRoutes: [brotli] }));

      expect(unclaimed).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(claimed.failures).toStrictEqual([]);
      expect(claimed.skipped).toStrictEqual([
        { path: '/a.txt', reason: 'claimed by a redirect or rewrite of next.config' },
      ]);
    });

    it('skips a file reserved by the Via value routing always supplies', async () => {
      const rule: ReservedRoute = {
        sourceRegex: '^/a[.]txt$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'via', value: '^1[.]1 arkor-edge$' }],
      };
      answers.set('/a.txt', {
        headers: { 'x-arkor-edge': 'passthrough;reason=reserved' },
        body: 'application-owned',
      });

      const result = await checkStack(stackOf([], files, { reservedRoutes: [rule] }));

      expect(result.failures).toStrictEqual([]);
      expect(result.skipped).toStrictEqual([
        { path: '/a.txt', reason: 'claimed by a redirect or rewrite of next.config' },
      ]);
      expect(agentsAsked.has('/a.txt')).toBe(false);
    });

    it('checks a file a missing-Via rule cannot claim after forwarding', async () => {
      const rule: ReservedRoute = {
        sourceRegex: '^/a[.]txt$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'via' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });

      const result = await checkStack(stackOf([], files, { reservedRoutes: [rule] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(agentsAsked.get('/a.txt')).toContain('upwind-local-check/1.0');
    });

    it.each([
      { type: 'image/png', failures: [] },
      {
        type: TEXT,
        failures: [
          {
            path: '/a.txt',
            reason: `asked for as the request a rule of next.config types it for (x-deployment-id: canary), answered as ${TEXT}, not image/png`,
          },
        ],
      },
    ])('checks a deployment-header file type rule answered as $type', async (example) => {
      const rule: HeaderRule = {
        sourceRegex: '^/a[.]txt$',
        has: [{ type: 'header', key: 'x-deployment-id', value: '^canary$' }],
        headers: { 'content-type': 'image/png' },
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
        withHeader: {
          name: 'x-deployment-id',
          headers: { 'content-type': example.type, 'cache-control': GATED },
        },
      });

      const result = await checkStack(stackOf([], files, { headerRules: [rule] }));

      expect(
        (askedHeadersEach.get('/a.txt') ?? []).some(
          (headers) => headers['x-deployment-id'] === 'canary',
        ),
      ).toBe(true);
      expect(result).toStrictEqual({ checked: 1, failures: example.failures, skipped: [] });
    });

    it.each([
      {
        key: 'connection',
        // No request carries a hop's own header past forwarding, so routing never selects the
        // rule, and the build is not failed for a branch nothing can take (greptile).
        failures: [],
      },
      {
        key: 'x-feature',
        failures: [
          {
            path: '/a.txt',
            reason: `asked for as the request a rule of next.config types it for (x-feature: on), answered as ${TEXT}, not image/png`,
          },
        ],
      },
    ])('asks for a file type rule over $key only where forwarding hands it on', async (example) => {
      const rule: HeaderRule = {
        sourceRegex: '^/a[.]txt$',
        has: [{ type: 'header', key: example.key, value: '^on$' }],
        headers: { 'content-type': 'image/png' },
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });

      const result = await checkStack(stackOf([], files, { headerRules: [rule] }));

      expect(result).toStrictEqual({ checked: 1, failures: example.failures, skipped: [] });
    });

    it('does not take a request for each of two overlapping deployment-header type rules as proof of both', async () => {
      // A type over `foo` and `bar`, and another over `foo` after it, whose witnesses both carry
      // `foo`: what `bar` is answered as no request would ask (greptile).
      const broad: HeaderRule = {
        sourceRegex: '^/a[.]txt$',
        has: [{ type: 'header', key: 'x-deployment-id', value: 'foo|bar' }],
        headers: { 'content-type': 'image/png' },
      };
      const narrow: HeaderRule = {
        ...broad,
        has: [{ type: 'header', key: 'x-deployment-id', value: 'foo' }],
        headers: { 'content-type': 'image/gif' },
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
        when: {
          test: (headers) => headers['x-deployment-id'] === 'foo',
          headers: { 'content-type': 'image/gif', 'cache-control': GATED },
        },
      });

      const result = await checkStack(stackOf([], files, { headerRules: [broad, narrow] }));

      expect(result).toStrictEqual({
        checked: 1,
        failures: [
          {
            path: '/a.txt',
            reason:
              'distinct conditioned header rules are not proved disjoint, and the check does not cover every overlapping branch: no request proves them',
          },
        ],
        skipped: [],
      });
    });

    it('is asked as the page a visitor goes to, where it is an HTML file a rule claims a fetch of', async () => {
      const page = { '/about': fileOf(FRONT + REST, HTML) };
      const fetchesOnly: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-mode', value: 'navigate' }],
      };
      answers.set('/about', {
        headers: { 'content-type': HTML, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: FRONT + REST,
      });
      const result = await checkStack(stackOf([], page, { reservedRoutes: [fetchesOnly] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(modes.get('/about')).toBe('navigate');
      expect(accepted.get('/about')).toMatch(/^text\/html,/u);
    });

    it('is asked as a page frames it, where rules claim it as the page visited and as a fetch', async () => {
      const page = { '/about': fileOf(FRONT + REST, HTML) };
      const sourced = (
        has: RouteHas[] | undefined,
        missing: RouteHas[] | undefined,
      ): ReservedRoute => {
        return {
          sourceRegex: '^/about$',
          beforeFiles: true,
          ...(has !== undefined && { has }),
          ...(missing !== undefined && { missing }),
        };
      };
      const rules = [
        sourced(undefined, [{ type: 'header', key: 'sec-fetch-dest' }]),
        sourced([{ type: 'header', key: 'sec-fetch-dest', value: 'document' }], undefined),
        sourced([{ type: 'header', key: 'sec-fetch-dest', value: 'empty' }], undefined),
      ];
      answers.set('/about', {
        headers: { 'content-type': HTML, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: FRONT + REST,
      });
      const result = await checkStack(stackOf([], page, { reservedRoutes: rules }));
      const asked = askedHeadersEach.get('/about') ?? [];

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(asked.some((headers) => headers['sec-fetch-dest'] === 'iframe')).toBe(true);
      expect(
        asked.every((headers) => {
          const destination = headers['sec-fetch-dest'];
          return destination !== undefined && destination !== 'document' && destination !== 'empty';
        }),
      ).toBe(true);
    });

    it('is asked with the deployment named too, as the documents of a build that names one ask', async () => {
      const assets = { '/_next/static/chunks/a.js': fileOf('chunk', SCRIPT, true) };
      answers.set('/_next/static/chunks/a.js', {
        headers: { 'content-type': SCRIPT, 'cache-control': IMMUTABLE, 'x-arkor-edge': FILE_EDGE },
        body: 'chunk',
      });
      const result = await checkStack(stackOf([], assets, { dplId: 'dpl_site' }));

      expect(result).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      // The second ask, with the deployment's id.
      expect(queries.get('/_next/static/chunks/a.js')).toBe('?dpl=dpl_site');
    });

    it('is asked carrying what a rule claims every request of the check without', async () => {
      const withoutQuery: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'query', key: 'v' }],
      };
      const byHost: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'host', value: 'example.com' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const escaped = await checkStack(stackOf([], files, { reservedRoutes: [withoutQuery] }));
      const hosted = await checkStack(stackOf([], files, { reservedRoutes: [byHost] }));

      expect(escaped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(queries.get('/a.txt')).toBe('?v=1');
      // A host the site is not asked under is no request the check can make.
      expect(hosted.skipped).toStrictEqual([
        { path: '/a.txt', reason: 'claimed by a redirect or rewrite of next.config' },
      ]);
    });

    it('is asked as a worker loads it, where rules claim a script asked for as an element loads one', async () => {
      const script = { '/w.js': fileOf('self.onmessage = () => {};', SCRIPT) };
      const unnamed: ReservedRoute = {
        sourceRegex: String.raw`^/w\.js$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const asElement: ReservedRoute = {
        sourceRegex: String.raw`^/w\.js$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: 'script' }],
      };
      answers.set('/w.js', {
        headers: { 'content-type': SCRIPT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'self.onmessage = () => {};',
      });
      const result = await checkStack(
        stackOf([], script, { reservedRoutes: [unnamed, asElement] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(
        (askedHeadersEach.get('/w.js') ?? []).some(
          (headers) => headers['sec-fetch-mode'] === 'same-origin',
        ),
      ).toBe(true);
    });

    it('is asked as a module worker loads it, where rules claim it asked for by an element or a classic worker', async () => {
      const script = { '/w.js': fileOf('self.onmessage = () => {};', SCRIPT) };
      const unnamed: ReservedRoute = {
        sourceRegex: String.raw`^/w\.js$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const asElement: ReservedRoute = {
        sourceRegex: String.raw`^/w\.js$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: 'script' }],
      };
      const asClassicWorker: ReservedRoute = {
        sourceRegex: String.raw`^/w\.js$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-mode', value: 'same-origin' }],
      };
      answers.set('/w.js', {
        headers: { 'content-type': SCRIPT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'self.onmessage = () => {};',
      });
      const result = await checkStack(
        stackOf([], script, { reservedRoutes: [unnamed, asElement, asClassicWorker] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // A module worker's, under CORS: an element's under CORS is claimed as a script's.
      expect(modes.get('/w.js')).toBe('cors');
    });

    it("is asked for its headers alone, which have to be the whole file's", async () => {
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      const unmeasured = { ...whole.headers, etag: `"${sha256Of('kept bytes')}"` };
      const head = { ...unmeasured, 'content-length': '10' };
      answers.set('/a.txt', { ...whole, onHead: { ...head, 'content-type': HTML } });
      const typed = await checkStack(stackOf([], files));
      answers.set('/a.txt', { ...whole, onHead: { ...head, 'content-length': '3' } });
      const measured = await checkStack(stackOf([], files));
      answers.set('/a.txt', { ...whole, onHead: unmeasured });
      const unsaid = await checkStack(stackOf([], files));

      expect(typed.failures).toStrictEqual([
        { path: '/a.txt', reason: `asked for with HEAD, answered as ${HTML}, not ${TEXT}` },
      ]);
      expect(measured.failures).toStrictEqual([
        { path: '/a.txt', reason: "answered HEAD with Content-Length 3, not the file's 10" },
      ]);
      expect(unsaid.failures).toStrictEqual([
        { path: '/a.txt', reason: "answered HEAD with Content-Length none, not the file's 10" },
      ]);
    });

    it('is held on its entity tag to how the file is held and to its cookies, but not to its type', async () => {
      const tag = `"${sha256Of('kept bytes')}"`;
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      const unmodified = { 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE, etag: tag };
      answers.set('/a.txt', { ...whole, unmodifiedHeaders: unmodified });
      const untyped = await checkStack(stackOf([], files));
      answers.set('/a.txt', {
        ...whole,
        unmodifiedHeaders: { ...unmodified, 'cache-control': 'no-store' },
      });
      const held = await checkStack(stackOf([], files));
      cookieSet('/a.txt');
      const cookied: Answer = {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'set-cookie': ['seen=1; Path=/'],
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      };
      answers.set('/a.txt', {
        ...cookied,
        unmodifiedHeaders: {
          ...unmodified,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
      });
      const uncookied = await checkStack(stackOf([], files));

      expect(untyped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(held.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: `asked for on If-None-Match ${tag}, not answered as one revalidated at every use (${REVALIDATE}), but no-store`,
        },
      ]);
      expect(uncookied.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: `asked for on If-None-Match ${tag}, answered without the cookie seen=1; Path=/ the application set`,
        },
      ]);
    });

    it('fails where a range of it is answered without saying its length', async () => {
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      const part = {
        'content-type': TEXT,
        'content-range': 'bytes 1-9/10',
        'accept-ranges': 'bytes',
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
        etag: `"${sha256Of('kept bytes')}"`,
      };
      // Sent chunked, as an answer that names no length is.
      answers.set('/a.txt', {
        ...whole,
        inPart: { status: 206, headers: part, body: 'ept bytes' },
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: "answered bytes=1-9 with Content-Length none, not the range's 9",
        },
      ]);
    });

    it("is held, asked for a range of it, to the whole file's headers", async () => {
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      const part = {
        'content-range': 'bytes 1-9/10',
        'content-length': '9',
        'accept-ranges': 'bytes',
        'cache-control': REVALIDATE,
        etag: `"${sha256Of('kept bytes')}"`,
        'x-arkor-edge': FILE_EDGE,
      };
      answers.set('/a.txt', {
        ...whole,
        inPart: { status: 206, headers: part, body: 'ept bytes' },
      });
      const untyped = await checkStack(stackOf([], files));
      answers.set('/a.txt', {
        ...whole,
        inPart: { status: 206, headers: { ...part, 'content-type': TEXT }, body: 'ept bytes' },
      });
      const typed = await checkStack(stackOf([], files));

      expect(untyped.failures).toStrictEqual([
        { path: '/a.txt', reason: `asked for bytes=1-9, answered as no type, not ${TEXT}` },
      ]);
      expect(typed).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is held, asked for a range of it, to the rules the request for the range selects', async () => {
      const ranged: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        has: [{ type: 'header', key: 'range' }],
        headers: { 'x-ranged': '1' },
      };
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      // A rule the request selected keeps the answer from shared caches, as the edge holds it.
      const part = {
        'content-type': TEXT,
        'content-range': 'bytes 1-9/10',
        'content-length': '9',
        'accept-ranges': 'bytes',
        'cache-control': GATED,
        etag: `"${sha256Of('kept bytes')}"`,
        'x-arkor-edge': FILE_EDGE,
      };
      answers.set('/a.txt', {
        ...whole,
        inPart: { status: 206, headers: { ...part, 'x-ranged': '1' }, body: 'ept bytes' },
        // Answered whole to a range asked for on a stale validator, the rule's headers all the same.
        withHeader: { name: 'range', headers: { 'x-ranged': '1', 'cache-control': GATED } },
      });
      const set = await checkStack(stackOf([], files, { headerRules: [ranged] }));
      answers.set('/a.txt', {
        ...whole,
        inPart: { status: 206, headers: part, body: 'ept bytes' },
      });
      const unset = await checkStack(stackOf([], files, { headerRules: [ranged] }));

      expect(set).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unset.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: 'asked for bytes=1-9, answered with x-ranged none, not the 1 the application set',
        },
      ]);
    });

    it("is asked under the hostname a host's validation names, where one is given", async () => {
      const elsewhere: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'host', value: String.raw`preview\.example` }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const stack = stackOf([], files, { reservedRoutes: [elsewhere] });
      const own = await checkStack(stack);
      const named = await checkStack(stack, { hostname: 'preview.example' });

      // Under the stack's own host, a rule for every other host claims it.
      expect(own.skipped).toStrictEqual([
        { path: '/a.txt', reason: 'claimed by a redirect or rewrite of next.config' },
      ]);
      expect(named).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(hosts.get('/a.txt')).toBe('preview.example');
    });

    it('is asked under HTTPS, as validation forwards it, whatever scheme reaches the stack', async () => {
      const overHttp: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        // Anchored: a pattern matches part of a value as well (`conditionMatches`).
        has: [{ type: 'header', key: 'x-forwarded-proto', value: '^http$' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files, { reservedRoutes: [overHttp] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is asked past every rule one way passes over at once, however many there are', async () => {
      const rules: ReservedRoute[] = Array.from({ length: 70 }, (_, at) => {
        return {
          sourceRegex: String.raw`^/a\.txt$`,
          beforeFiles: true,
          missing: [{ type: 'header', key: `x-wanted-${String(at)}` }],
        };
      });
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files, { reservedRoutes: rules }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('fails where each way past a rule brings on another, past every request the check tries', async () => {
      const chained: ReservedRoute[] = Array.from({ length: 70 }, (_, at) => {
        return {
          sourceRegex: String.raw`^/a\.txt$`,
          beforeFiles: true,
          ...(at > 0 && { has: [{ type: 'header' as const, key: `x-link-${String(at - 1)}` }] }),
          missing: [{ type: 'header', key: `x-link-${String(at)}` }],
        };
      });
      const result = await checkStack(stackOf([], files, { reservedRoutes: chained }));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            'rules of next.config claim every request the check makes for what it lacks, and passing each over brings on another past every request the check tries: no request proves it',
        },
      ]);
    });

    it('is asked as a video element loads it, where rules claim it asked for by a fetch', async () => {
      const video = { '/a.mp4': fileOf('mp4 bytes', 'video/mp4') };
      const unnamed: ReservedRoute = {
        sourceRegex: String.raw`^/a\.mp4$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const fetched: ReservedRoute = {
        sourceRegex: String.raw`^/a\.mp4$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: 'empty' }],
      };
      answers.set('/a.mp4', {
        headers: {
          'content-type': 'video/mp4',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: 'mp4 bytes',
      });
      const result = await checkStack(stackOf([], video, { reservedRoutes: [unnamed, fetched] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(modes.get('/a.mp4')).toBe('no-cors');
    });

    it('is asked past the rules by a value only one of two ways past the first could come to', async () => {
      const rule = (has: RouteHas[] | undefined, missing: RouteHas[]): ReservedRoute => {
        return {
          sourceRegex: String.raw`^/a\.txt$`,
          beforeFiles: true,
          ...(has !== undefined && { has }),
          missing,
        };
      };
      // Two ways past the first, each carrying `x: 1` alike — but only the second's may come to `foo`.
      const first = rule(undefined, [
        { type: 'header', key: 'x', value: '(?:1|bar)' },
        { type: 'header', key: 'x', value: '(?:1|foo)' },
      ]);
      // Then one passed over by `x: foo`, or by `y: 1`, which a third claims.
      const second = rule(
        [{ type: 'header', key: 'x', value: '1' }],
        [
          { type: 'header', key: 'x', value: 'foo' },
          { type: 'header', key: 'y', value: '1' },
        ],
      );
      const third: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'y', value: '1' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(
        stackOf([], files, { reservedRoutes: [first, second, third] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(askedHeaders.get('/a.txt')?.['x']).toBe('foo');
    });

    it('is asked past a rule by a way that brings on no other, where the first way would', async () => {
      const withoutEither: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [
          { type: 'cookie', key: 'a' },
          { type: 'cookie', key: 'b' },
        ],
      };
      const withA: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'cookie', key: 'a' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(
        stackOf([], files, { reservedRoutes: [withoutEither, withA] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(cookies.get('/a.txt')).toBe('b=1');
    });

    it('is answered in part to a request for a range of it, as the bytes the range names', async () => {
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      answers.set('/a.txt', whole);
      const ranged = await checkStack(stackOf([], files));
      answers.set('/a.txt', { ...whole, rangeless: true });
      const wholeOnly = await checkStack(stackOf([], files));

      expect(ranged).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(wholeOnly.failures).toStrictEqual([
        { path: '/a.txt', reason: 'answered bytes=1-9 with 200, not 206' },
      ]);
    });

    it('is answered 416 to a range of it where it has no byte past its first', async () => {
      const tiny = { '/one.txt': fileOf('x', TEXT), '/none.txt': fileOf('', TEXT) };
      const asFile = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
      };
      answers.set('/one.txt', { headers: asFile, body: 'x' });
      answers.set('/none.txt', { headers: asFile, body: '' });
      const unsatisfied = await checkStack(stackOf([], tiny));
      answers.set('/one.txt', { headers: asFile, body: 'x', rangeless: true });
      answers.set('/none.txt', { headers: asFile, body: '', rangeless: true });
      const whole = await checkStack(stackOf([], tiny));

      expect(unsatisfied).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(whole.failures).toStrictEqual([
        {
          path: '/one.txt',
          reason: 'answered bytes=1-1 with 200, not 416 under Content-Range bytes */1',
        },
        {
          path: '/none.txt',
          reason: 'answered bytes=1-1 with 200, not 416 under Content-Range bytes */0',
        },
      ]);
    });

    it("is answered 416 with no body, and with the whole file's headers, where no byte of it satisfies a range", async () => {
      const tiny = { '/one.txt': fileOf('x', TEXT) };
      const asFile = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
      };
      const unsatisfied = { 'content-range': 'bytes */1', 'x-arkor-edge': FILE_EDGE };
      answers.set('/one.txt', {
        headers: asFile,
        body: 'x',
        inPart: { status: 416, headers: { ...asFile, ...unsatisfied }, body: 'x' },
      });
      const bodied = await checkStack(stackOf([], tiny));
      answers.set('/one.txt', {
        headers: asFile,
        body: 'x',
        inPart: { status: 416, headers: { ...unsatisfied, 'cache-control': REVALIDATE }, body: '' },
      });
      const untyped = await checkStack(stackOf([], tiny));
      // Kept as the file is, where a cache keyed on the URL alone would hand it to every request.
      const tagged = { ...asFile, etag: `"${sha256Of('x')}"`, 'accept-ranges': 'bytes' };
      answers.set('/one.txt', {
        headers: asFile,
        body: 'x',
        inPart: { status: 416, headers: { ...tagged, ...unsatisfied }, body: '' },
      });
      const kept = await checkStack(stackOf([], tiny));

      expect(bodied.failures).toStrictEqual([
        {
          path: '/one.txt',
          reason: 'answered bytes=1-1 with a body, though no byte of the file satisfies it',
        },
      ]);
      expect(untyped.failures).toStrictEqual([
        { path: '/one.txt', reason: `asked for bytes=1-1, answered as no type, not ${TEXT}` },
      ]);
      expect(kept.failures).toStrictEqual([
        {
          path: '/one.txt',
          reason: `asked for bytes=1-1, not kept by nobody (private, no-store), but ${REVALIDATE}`,
        },
      ]);
    });

    it('is asked for a range as a request of its own, which a rule or the middleware may take', async () => {
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
        // Were the range the edge's to answer, this would fail it.
        rangeless: true,
      };
      answers.set('/a.txt', whole);
      const ranges: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'range' }],
      };
      const claimed = await checkStack(stackOf([], files, { reservedRoutes: [ranges] }));
      answers.set('/a.txt', {
        ...whole,
        rangeless: false,
        inPart: {
          status: 307,
          headers: { location: '/', 'x-arkor-edge': 'passthrough;reason=middleware' },
          body: '',
        },
      });
      const answeredByMiddleware = await checkStack(stackOf([], files));

      expect(claimed).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(answeredByMiddleware).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('fails where it is served from storage, though the middleware answered the request itself', async () => {
      // A redirect of the middleware's own, which is the answer.
      decisions.set('/a.txt', { location: '/login' });
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            "the application's middleware answered it itself, and the edge served what the deployment holds in its place",
        },
      ]);
    });

    it("fails where the build's middleware covers it, and the edge says it did not run", async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      // A middleware of the build's whose matcher covers the file, which the stack runs.
      const stack = withMiddleware(stackOf([], files), [{ sourceRegex: String.raw`^/a\.txt$` }]);
      const result = await checkStack(stack);

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: "the application's middleware covers it, and the edge says it did not run",
        },
      ]);
    });

    it('is answered in part to a range by its end and from a byte on, as the bytes those name', async () => {
      const asFile = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
      };
      const sized = { '/a.txt': fileOf('kept bytes', TEXT), '/none.txt': fileOf('', TEXT) };
      answers.set('/a.txt', { headers: asFile, body: 'kept bytes' });
      answers.set('/none.txt', { headers: asFile, body: '' });
      const ranged = await checkStack(stackOf([], sized));
      answers.set('/a.txt', { headers: asFile, body: 'kept bytes', openRangeless: true });
      answers.set('/none.txt', { headers: asFile, body: '', openRangeless: true });
      const whole = await checkStack(stackOf([], sized));

      expect(ranged).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(whole.failures).toStrictEqual([
        { path: '/a.txt', reason: 'answered bytes=-10 with 200, not 206' },
        {
          path: '/none.txt',
          reason: 'answered bytes=-1 with 200, not 416 under Content-Range bytes */0',
        },
      ]);
    });

    it('fails where a range of it on the tag it is served under is answered whole', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
        ifRangeRefused: true,
      });
      const result = await checkStack(stackOf([], files));
      const tag = `"${sha256Of('kept bytes')}"`;

      expect(result.failures).toStrictEqual([
        { path: '/a.txt', reason: `answered bytes=1-9 on If-Range ${tag} with 200, not 206` },
      ]);
    });

    it('fails where a range of it on a stale validator is answered in part', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
        ifRangeIgnored: true,
      });
      const result = await checkStack(stackOf([], files));
      const tag = `W/"${sha256Of('kept bytes')}"`;

      expect(result.failures).toStrictEqual([
        { path: '/a.txt', reason: `asked for bytes=1-9 on If-Range ${tag}, answered 206, not 200` },
      ]);
    });

    it('fails where the stack kept what the middleware decided for it, and the edge says it did not run', async () => {
      keptUnsaid.add('/a.txt');
      decisions.set('/a.txt', { 'x-middleware-next': '1', 'x-variant': 'b' });
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            "the stack kept what the application's middleware decided for it, and the edge says it did not run",
        },
      ]);
    });

    it('fails where the middleware ran on it and the stack kept nothing of what it decided', async () => {
      unkept.add('/a.txt');
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            "the edge says the application's middleware ran on it, and the stack kept nothing of what it decided",
        },
      ]);
    });

    it('fails where a range of it is said to be served under another policy', async () => {
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      const elsewhere = 'static;src=bucket;project=site;policy=paas-v4;m=0000';
      answers.set('/a.txt', {
        ...whole,
        inPart: {
          status: 206,
          headers: {
            ...whole.headers,
            'content-range': 'bytes 1-9/10',
            'accept-ranges': 'bytes',
            etag: `"${sha256Of('kept bytes')}"`,
            'x-arkor-edge': elsewhere,
          },
          body: 'ept bytes',
        },
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: `asked for bytes=1-9, not answered under the delivery policy default (x-arkor-edge: ${elsewhere})`,
        },
      ]);
    });

    it('is asked carrying one value every rule that wants one in the same header takes', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const shared = await checkStack(
        stackOf([], files, {
          reservedRoutes: [wanting('(?:foo|shared)'), wanting('(?:bar|shared)')],
        }),
      );
      const sharedValue = askedHeaders.get('/a.txt')?.['x-mode'];
      const apart = await checkStack(
        stackOf([], files, { reservedRoutes: [wanting('foo'), wanting('bar')] }),
      );

      expect(shared).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(sharedValue).toBe('shared');
      expect(apart.failures[0]?.reason).toMatch(/only a value its pattern names/u);
    });

    it('is asked from a page of another site, where rules claim every request from its own', async () => {
      const unsited: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-site' }],
      };
      const ownSite: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-site', value: 'same-origin' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files, { reservedRoutes: [unsited, ownSite] }));
      const asked = askedHeaders.get('/a.txt');
      // And from another site's, where a page of the same site under another host is claimed too.
      const sameSite: ReservedRoute = {
        ...ownSite,
        has: [{ type: 'header', key: 'sec-fetch-site', value: 'same-site' }],
      };
      const fromAfar = await checkStack(
        stackOf([], files, { reservedRoutes: [unsited, ownSite, sameSite] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // A page of the same site under another origin's: for a site that is its address alone, the
      // address under another port.
      expect(asked?.['sec-fetch-site']).toBe('same-site');
      expect(asked?.referer).toBe('https://127.0.0.1:8443/');
      expect(fromAfar).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(askedHeaders.get('/a.txt')?.['sec-fetch-site']).toBe('cross-site');
      expect(askedHeaders.get('/a.txt')?.referer).toBe('https://elsewhere.example/');
    });

    it('is asked as the type a rule serves it as, where rules claim it asked as its own', async () => {
      const typed: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        headers: { 'Content-Type': 'image/png' },
      };
      const unnamed: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const fetched: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: 'empty' }],
      };
      answers.set('/a.txt', {
        headers: {
          'content-type': 'image/png',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: 'kept bytes',
      });
      const result = await checkStack(
        stackOf([], files, { headerRules: [typed], reservedRoutes: [unnamed, fetched] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/a.txt')).toBe('image');
    });

    it('is asked as the type a rule serves it as to a request of a kind, whatever the rule asks', async () => {
      const typed: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: 'image' }],
        headers: { 'Content-Type': 'image/png' },
      };
      const unnamed: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const fetched: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: 'empty' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
        when: {
          test: (headers) => headers['sec-fetch-dest'] === 'image',
          headers: { 'content-type': 'image/png', 'cache-control': GATED },
        },
      });
      const result = await checkStack(
        stackOf([], files, { headerRules: [typed], reservedRoutes: [unnamed, fetched] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/a.txt')).toBe('image');
    });

    it('uses the shared middleware merge contract for a shipped file type', async () => {
      const pathname = '/a.txt';
      const fileHeaders = {
        'content-type': TEXT,
        'cache-control': GATED,
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      };
      decisions.set(pathname, { 'x-middleware-next': '1', 'content-type': 'image/png' });
      const stack = withMiddleware(stackOf([], files), [{ sourceRegex: '^/a[.]txt$' }]);
      answers.set(pathname, { headers: fileHeaders, body: 'kept bytes' });

      const correct = await checkStack(stack);
      answers.set(pathname, {
        headers: { ...fileHeaders, 'content-type': 'image/png' },
        body: 'kept bytes',
      });
      const broken = await checkStack(stack);

      expect(correct).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(broken.failures).toHaveLength(1);
      expect(broken.failures[0]?.reason).toContain(`answered as image/png, not ${TEXT}`);
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('is asked for as a request a rule of next.config alone types it for, and held to that type', async () => {
      const variant: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        has: [{ type: 'cookie', key: 'variant' }],
        headers: { 'Content-Type': 'image/png' },
      };
      const asFile = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
      };
      // As the edge holds an answer a rule judged a cookie for: the visitor's alone.
      const png = { 'content-type': 'image/png', 'cache-control': GATED };
      answers.set('/a.txt', {
        headers: asFile,
        body: 'kept bytes',
        withCookie: { name: 'variant', headers: png },
      });
      const typed = await checkStack(stackOf([], files, { headerRules: [variant] }));
      answers.set('/a.txt', { headers: asFile, body: 'kept bytes' });
      const untyped = await checkStack(stackOf([], files, { headerRules: [variant] }));

      expect(typed).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(untyped.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: `asked for as the request a rule of next.config types it for (the cookie variant=1), answered as ${TEXT}, not image/png`,
        },
      ]);
    });

    it('reports an unwitnessed quantified type condition instead of passing it over', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const quantified: HeaderRule = {
        sourceRegex: '^/a[.]txt$',
        has: [{ type: 'header', key: 'x-site', value: String.raw`\d{2}` }],
        headers: { 'Content-Type': 'image/png' },
      };
      const unproved = await checkStack(stackOf([], files, { headerRules: [quantified] }));
      const elsewhere = await checkStack(
        stackOf([], files, {
          headerRules: [{ ...quantified, sourceRegex: '^/other[.]txt$' }],
        }),
      );

      expect(unproved.failures).toHaveLength(1);
      expect(unproved.failures[0]?.reason).toContain('no request proves it');
      expect(elsewhere).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('reports overlapping file type selectors as unproved when one witness selects both', async () => {
      const broad: HeaderRule = {
        sourceRegex: '^/a[.]txt$',
        has: [{ type: 'header', key: 'x-mode', value: 'foo|bar' }],
        headers: { 'Content-Type': 'image/png' },
      };
      const narrow: HeaderRule = {
        ...broad,
        has: [{ type: 'header', key: 'x-mode', value: 'foo' }],
        headers: { 'Content-Type': TEXT },
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });

      const result = await checkStack(stackOf([], files, { headerRules: [broad, narrow] }));
      const elsewhere = await checkStack(
        stackOf([], files, {
          headerRules: [broad, { ...narrow, sourceRegex: '^/other[.]txt$' }],
        }),
      );

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain('distinct conditioned header rules');
      expect(result.failures[0]?.reason).toContain('no request proves them');
      // The single remaining rule is exercised and fails its declared image type.
      expect(elsewhere.failures).toHaveLength(1);
      expect(elsewhere.failures[0]?.reason).toContain('image/png');
      expect(elsewhere.failures[0]?.reason).not.toContain('distinct conditioned header rules');
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('is asked for as a request a rule of next.config types it for where a header is missing', async () => {
      const unencoded: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        missing: [{ type: 'header', key: 'accept' }],
        headers: { 'Content-Type': 'image/png' },
      };
      const asFile = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
      };
      // As the edge holds an answer a rule judged the request for: the client's alone.
      const png = { 'content-type': 'image/png', 'cache-control': GATED };
      answers.set('/a.txt', {
        headers: asFile,
        body: 'kept bytes',
        withoutHeader: { name: 'accept', headers: png },
      });
      const typed = await checkStack(stackOf([], files, { headerRules: [unencoded] }));
      answers.set('/a.txt', { headers: asFile, body: 'kept bytes' });
      const untyped = await checkStack(stackOf([], files, { headerRules: [unencoded] }));

      expect(typed).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(untyped.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: `asked for as the request a rule of next.config types it for (without accept), answered as ${TEXT}, not image/png`,
        },
      ]);
    });

    it('is asked as a page embeds it, where rules claim every fetch of it', async () => {
      const pdf = '%PDF-1.7';
      answers.set('/doc.pdf', {
        headers: {
          'content-type': 'application/pdf',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: pdf,
      });
      const undestined: ReservedRoute = {
        sourceRegex: String.raw`^/doc\.pdf$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const fetched: ReservedRoute = {
        sourceRegex: String.raw`^/doc\.pdf$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: '(empty|document)' }],
      };
      const result = await checkStack(
        stackOf(
          [],
          { '/doc.pdf': fileOf(pdf, 'application/pdf') },
          {
            reservedRoutes: [undestined, fetched],
          },
        ),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/doc.pdf')).toBe('embed');
      expect(modes.get('/doc.pdf')).toBe('navigate');
    });

    it('is asked as a page frames it, where rules claim every fetch and embedding of it', async () => {
      const pdf = '%PDF-1.7';
      answers.set('/doc.pdf', {
        headers: {
          'content-type': 'application/pdf',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: pdf,
      });
      const undestined: ReservedRoute = {
        sourceRegex: String.raw`^/doc\.pdf$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const fetchedOrEmbedded: ReservedRoute = {
        sourceRegex: String.raw`^/doc\.pdf$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: '(empty|document|embed|object)' }],
      };
      const result = await checkStack(
        stackOf(
          [],
          { '/doc.pdf': fileOf(pdf, 'application/pdf') },
          { reservedRoutes: [undestined, fetchedOrEmbedded] },
        ),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/doc.pdf')).toBe('iframe');
      expect(modes.get('/doc.pdf')).toBe('navigate');
    });

    it('is asked as a link navigates to it, where rules claim a navigation typed and every frame and fetch of it', async () => {
      const page = '<!doctype html><html><body>Static</body></html>';
      answers.set('/page.html', {
        headers: { 'content-type': HTML, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: page,
      });
      const unsited: ReservedRoute = {
        sourceRegex: String.raw`^/page\.html$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-site' }],
      };
      const framedOrFetched: ReservedRoute = {
        sourceRegex: String.raw`^/page\.html$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: '(iframe|empty)' }],
      };
      const result = await checkStack(
        stackOf(
          [],
          { '/page.html': fileOf(page, HTML) },
          {
            reservedRoutes: [unsited, framedOrFetched],
          },
        ),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/page.html')).toBe('document');
      expect(askedHeaders.get('/page.html')?.['sec-fetch-site']).toBe('none');
    });

    it('is asked as a page embeds it, where rules claim every navigation, frame and fetch of it', async () => {
      const page = '<!doctype html><html><body>Static</body></html>';
      answers.set('/page.html', {
        headers: { 'content-type': HTML, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: page,
      });
      const undestined: ReservedRoute = {
        sourceRegex: String.raw`^/page\.html$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const navigatedFramedOrFetched: ReservedRoute = {
        sourceRegex: String.raw`^/page\.html$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: '(document|iframe|empty)' }],
      };
      const result = await checkStack(
        stackOf(
          [],
          { '/page.html': fileOf(page, HTML) },
          { reservedRoutes: [undestined, navigatedFramedOrFetched] },
        ),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/page.html')).toBe('embed');
      expect(modes.get('/page.html')).toBe('navigate');
    });

    it('is asked as a JSON module imports it, where rules claim a fetch of it', async () => {
      const json = '{"a":1}';
      answers.set('/data.json', {
        headers: {
          'content-type': 'application/json',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: json,
      });
      const undestined: ReservedRoute = {
        sourceRegex: String.raw`^/data\.json$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const fetched: ReservedRoute = {
        sourceRegex: String.raw`^/data\.json$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-dest', value: 'empty' }],
      };
      const result = await checkStack(
        stackOf(
          [],
          { '/data.json': fileOf(json, 'application/json') },
          {
            reservedRoutes: [undestined, fetched],
          },
        ),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/data.json')).toBe('json');
      expect(accepted.get('/data.json')).toBe('application/json,*/*;q=0.5');
    });

    it("is asked as a module script of its own page asks, naming that page's origin", async () => {
      const script = 'console.log(1);';
      const originless: ReservedRoute = {
        sourceRegex: String.raw`^/app\.js$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'origin' }],
      };
      answers.set('/app.js', {
        headers: { 'content-type': SCRIPT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: script,
      });
      const result = await checkStack(
        stackOf([], { '/app.js': fileOf(script, SCRIPT) }, { reservedRoutes: [originless] }),
        { hostname: 'site.example' },
      );
      const asked = askedHeaders.get('/app.js');

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(asked?.['sec-fetch-site']).toBe('same-origin');
      expect(asked?.['sec-fetch-mode']).toBe('cors');
      expect(asked?.origin).toBe('https://site.example');
    });

    it("is asked as a page's script fetches it, where rules claim every element that loads it", async () => {
      const script = 'console.log(1);';
      const undestined: ReservedRoute = {
        sourceRegex: String.raw`^/app\.js$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-dest' }],
      };
      const loaded: ReservedRoute = {
        sourceRegex: String.raw`^/app\.js$`,
        beforeFiles: true,
        has: [
          {
            type: 'header',
            key: 'sec-fetch-dest',
            value: '(script|worker|sharedworker|serviceworker|document|embed|object|iframe)',
          },
        ],
      };
      answers.set('/app.js', {
        headers: { 'content-type': SCRIPT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: script,
      });
      const result = await checkStack(
        stackOf(
          [],
          { '/app.js': fileOf(script, SCRIPT) },
          { reservedRoutes: [undestined, loaded] },
        ),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/app.js')).toBe('empty');
      expect(modes.get('/app.js')).toBe('cors');
    });

    it('is asked from a page of another site than its own, whatever its own is named', async () => {
      const originless: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'origin' }],
      };
      const sameSite: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-site', value: 'same-site' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      // Named as the other site the check puts a page under would be.
      const result = await checkStack(
        stackOf([], files, { reservedRoutes: [originless, sameSite] }),
        { hostname: 'cdn.elsewhere.example' },
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(askedHeaders.get('/a.txt')?.['sec-fetch-site']).toBe('cross-site');
      expect(askedHeaders.get('/a.txt')?.origin).toBe('https://elsewhere.test');
    });

    it('is asked as a module a worker of another origin imports, where rules claim every other request of it', async () => {
      const script = 'console.log(1);';
      const rules = [
        appScriptRule({ missing: [{ type: 'header', key: 'sec-fetch-dest' }] }),
        appScriptRule({ has: [{ type: 'header', key: 'sec-fetch-site', value: 'same-origin' }] }),
        appScriptRule({
          has: [
            {
              type: 'header',
              key: 'sec-fetch-dest',
              value: '(script|empty|document|embed|object|iframe)',
            },
          ],
        }),
      ];
      answers.set('/app.js', {
        headers: { 'content-type': SCRIPT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: script,
      });
      const result = await checkStack(
        stackOf([], { '/app.js': fileOf(script, SCRIPT) }, { reservedRoutes: rules }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(destinations.get('/app.js')).toBe('worker');
      expect(modes.get('/app.js')).toBe('cors');
      expect(askedHeaders.get('/app.js')?.['sec-fetch-site']).toBe('same-site');
    });

    it('is asked as the type the last rule that holds for every request sets, not one it sets over', async () => {
      const typed = (type: string): HeaderRule => {
        return {
          sourceRegex: String.raw`^/a\.txt$`,
          headers: { 'content-type': type },
        };
      };
      // Every request that a stylesheet would not be asked by, claimed: the prover's, and a script's.
      const unloaded = appScriptRule({ missing: [{ type: 'header', key: 'sec-fetch-dest' }] });
      const scripted: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [
          {
            type: 'header',
            key: 'sec-fetch-dest',
            value: '(script|worker|sharedworker|serviceworker|empty|document|embed|object|iframe)',
          },
        ],
      };
      answers.set('/a.txt', {
        headers: {
          'content-type': 'application/javascript',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: 'kept bytes',
      });
      const result = await checkStack(
        stackOf([], files, {
          headerRules: [typed('text/css'), typed('application/javascript')],
          reservedRoutes: [{ ...unloaded, sourceRegex: String.raw`^/a\.txt$` }, scripted],
        }),
      );

      // Not proved by a stylesheet's request, which no browser makes of a script.
      expect(result.checked).toBe(1);
      expect(result.failures.map((failure) => failure.path)).toStrictEqual(['/a.txt']);
      expect(destinations.get('/a.txt')).not.toBe('style');
    });

    it('fails where rules that ask of what a request is for claim every request a service worker of any origin makes for it', async () => {
      const script = 'console.log(1);';
      // Every request a service worker's update makes says so, a module of another origin's
      // worker's graph among them; every other request is claimed by what it is for.
      const rules = [
        appScriptRule({ missing: [{ type: 'header', key: 'sec-fetch-dest' }] }),
        appScriptRule({ has: [{ type: 'header', key: 'service-worker' }] }),
        // Every destination but a service worker's, which a value matches in part as well.
        appScriptRule({
          has: [
            {
              type: 'header',
              key: 'sec-fetch-dest',
              value: '(script|(?<!service)worker|empty|document|embed|object|iframe)',
            },
          ],
        }),
      ];
      answers.set('/app.js', {
        headers: { 'content-type': SCRIPT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: script,
      });
      const result = await checkStack(
        stackOf([], { '/app.js': fileOf(script, SCRIPT) }, { reservedRoutes: rules }),
      );

      // Not by a request no browser makes: a module another origin's service worker imports
      // without the header its update sends with every one.
      expect(result).toStrictEqual({
        checked: 1,
        failures: [
          {
            path: '/app.js',
            reason:
              'a rule of next.config that asks of the user agent, its client hints, its language, its accept or upgrade-insecure-requests header, its origin, its referrer or its fetch metadata claims every browser the check asks for the file as, but not every agent: no browser proves the file',
          },
        ],
        skipped: [],
      });
    });

    it('is asked from another site as its page asks, naming its origin', async () => {
      const originless: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'origin' }],
      };
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files, { reservedRoutes: [originless] }), {
        hostname: 'site.example',
      });
      const asked = askedHeaders.get('/a.txt');
      // Under a host that is a public suffix itself, whose subdomains are each a site of their own.
      await checkStack(stackOf([], files, { reservedRoutes: [originless] }), {
        hostname: 'github.io',
      });

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // From a page of another origin of the same site first — the host under another port — by
      // that origin.
      expect(asked?.origin).toBe('https://site.example:8443');
      expect(asked?.['sec-fetch-site']).toBe('same-site');
      expect(askedHeaders.get('/a.txt')?.origin).toBe('https://github.io:8443');
    });

    it('fails where the middleware rewrote it onto no file of the build, and it came from storage', async () => {
      decisions.set('/a.txt', { 'x-middleware-rewrite': '/elsewhere' });
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            "the application's middleware rewrote it onto /elsewhere, which is no file of the build, and the edge answered it from storage",
        },
      ]);
    });

    it('fails where the middleware rewrote a range of it onto no file of the build, and it came from storage', async () => {
      const whole: Answer = {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      };
      decidedInPart.set('/a.txt', { 'x-middleware-rewrite': '/elsewhere' });
      answers.set('/a.txt', whole);
      const ignored = await checkStack(stackOf([], files));
      // As the edge hands one on to the Function: the application's to answer.
      const handedOn: Answer = {
        status: 404,
        headers: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=rewritten;mw=hit' },
        body: NOT_FOUND,
      };
      answers.set('/a.txt', { ...whole, inPart: handedOn });
      const answered = await checkStack(stackOf([], files));

      expect(ignored.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            "asked for bytes=1-9, the application's middleware rewrote it onto /elsewhere, which is no file of the build, and the edge answered it from storage",
        },
      ]);
      expect(answered).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is held, asked for a range the middleware rewrote onto another file, to that file', async () => {
      const other = 'other bytes!';
      await writeFile(path.join(blobsOf(), sha256Of(other)), other);
      const held = { ...files, '/b.txt': fileOf(other, TEXT) };
      const asItself = (body: string): Answer => {
        return {
          headers: {
            'content-type': TEXT,
            'cache-control': GATED,
            'x-arkor-edge': `${FILE_EDGE};mw=hit`,
          },
          body,
        };
      };
      answers.set('/b.txt', asItself(other));
      // The range alone is rewritten onto `/b.txt`.
      decidedInPart.set('/a.txt', { 'x-middleware-rewrite': '/b.txt' });
      const ofOther: Answer = {
        status: 206,
        headers: {
          ...asItself(other).headers,
          'content-range': 'bytes 1-9/12',
          'content-length': '9',
          'accept-ranges': 'bytes',
          etag: `"${sha256Of(other)}"`,
        },
        body: other.slice(1, 10),
      };
      answers.set('/a.txt', { ...asItself('kept bytes'), inPart: ofOther });
      const served = await checkStack(stackOf([], held));
      // The rewrite ignored: the range of the file asked for, as the edge would serve it unrewritten.
      answers.set('/a.txt', asItself('kept bytes'));
      const ignored = await checkStack(stackOf([], held));

      expect(served).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(ignored.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            'rewritten onto /b.txt, answered bytes=1-9 under Content-Range bytes 1-9/10, not bytes 1-9/12',
        },
      ]);
    });

    it('fails where it is answered without its length, or saying no range of it is asked for', async () => {
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      answers.set('/a.txt', { ...whole, lengthless: true });
      const unmeasured = await checkStack(stackOf([], files));
      answers.set('/a.txt', { ...whole, headers: { ...whole.headers, 'accept-ranges': 'none' } });
      const rangeless = await checkStack(stackOf([], files));

      expect(unmeasured.failures).toStrictEqual([
        { path: '/a.txt', reason: "answered with Content-Length none, not the file's 10" },
      ]);
      expect(rangeless.failures).toStrictEqual([
        { path: '/a.txt', reason: 'answered with Accept-Ranges none, not bytes' },
      ]);
    });

    it('fails where a file the build wrote is held by no entry of the manifest, or as other bytes', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const written = [
        writtenAs('/a.txt', 'kept bytes'),
        writtenAs('/gone.txt', 'gone'),
        writtenAs('/b.txt', 'other'),
      ];
      const held = { ...files, '/b.txt': fileOf('not the build', TEXT) };
      answers.set('/b.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'not the build',
      });
      const result = await checkStack(stackOf([], held, { written }));

      expect(result.failures).toStrictEqual([
        {
          path: '/gone.txt',
          reason: 'written by the build, and held by no entry of the manifest the edge serves by',
        },
        {
          path: '/b.txt',
          reason: 'held by the manifest the edge serves by as other bytes than the build wrote',
        },
      ]);
    });

    it("fails where the manifest holds a file the build wrote nowhere, or a kept build's", async () => {
      const asFile = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
      };
      answers.set('/a.txt', { headers: asFile, body: 'kept bytes' });
      answers.set('/stray.txt', { headers: asFile, body: 'kept bytes' });
      const held = {
        ...files,
        '/stray.txt': fileOf('kept bytes', TEXT),
        '/_next/static/chunks/old.js': {
          ...fileOf('old', SCRIPT, true),
          deploymentId: 'dpl_before',
        },
      };
      const result = await checkStack(
        stackOf([], held, { written: [writtenAs('/a.txt', 'kept bytes')] }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/stray.txt',
          reason:
            'held by the manifest the edge serves by, though the build wrote no file there and no rewrite of it names one',
        },
        {
          path: '/_next/static/chunks/old.js',
          reason:
            'held by the manifest the edge serves by as a file of dpl_before, though the stack deploys no deployment before it',
        },
      ]);
    });

    it("fails where the manifest holds a deployment's bytes beside the build's, though there is none before it", async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const kept = {
        ...fileOf('kept bytes', TEXT),
        previous: { ...fileOf('stale bytes', TEXT), deploymentId: 'dpl_before' },
      };
      const result = await checkStack(stackOf([], { '/a.txt': kept }));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            "held by the manifest the edge serves by with dpl_before's bytes beside the build's, though the stack deploys no deployment before it",
        },
      ]);
    });

    it('fails where the manifest names the deployment, or the prefix its pages load assets under, otherwise than the build', async () => {
      const script = 'self.chunk = 1;';
      const asServed: Answer = {
        headers: { 'content-type': SCRIPT, 'cache-control': IMMUTABLE, 'x-arkor-edge': FILE_EDGE },
        body: script,
      };
      answers.set(ASSET, asServed);
      answers.set(`/assets${ASSET}`, asServed);
      const stack = stackOf(
        [],
        { [ASSET]: fileOf(script, SCRIPT, true) },
        { assetPrefix: '/assets' },
      );
      const { deployment } = stack.manifest;
      const renamed = await checkStack({
        ...stack,
        manifest: { ...stack.manifest, deployment: { ...deployment, dplId: 'dpl_other' } },
      });
      const { staticFileAssetPrefix, ...unprefixed } = stack.manifest;
      const unloaded = await checkStack({ ...stack, manifest: unprefixed });

      expect(staticFileAssetPrefix).toBeDefined();
      expect(renamed.failures).toStrictEqual([
        {
          path: '?dpl=dpl_site',
          reason:
            "named by the manifest the edge serves by as the deployment dpl_other, not the dpl_site the build's documents name it by",
        },
      ]);
      expect(unloaded.failures).toContainEqual({
        path: '/assets/_next/',
        reason:
          "held by the manifest the edge serves by under the asset prefix none, not the /assets the build's pages load its files under",
      });
    });

    it('fails where the manifest names a Function as another script than the stack runs it as', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const stack = stackOf([], files);
      const result = await checkStack({
        ...stack,
        app: { ...stack.app, functions: { 'app-2': 'site-app-2' } },
        // The second Function's routes sent to the first's script.
        manifest: { ...stack.manifest, app: { ...stack.app, functions: { 'app-2': 'site-app' } } },
      });

      expect(result.failures).toStrictEqual([
        {
          path: 'app-2',
          reason:
            'named by the manifest the edge serves by as the script site-app, not the site-app-2 the stack runs it as',
        },
      ]);
    });

    it('holds a file a rewrite ahead of the filesystem serves another file in place of as that file', async () => {
      const media = '/_next/static/media/b.txt';
      const asServed: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'rewritten bytes',
      };
      answers.set('/a.txt', asServed);
      answers.set(media, asServed);
      const written = [writtenAs('/a.txt', 'kept bytes'), writtenAs(media, 'rewritten bytes')];
      const beforeFiles = [
        { source: '/a.txt', sourceRegex: String.raw`^/a\.txt$`, destination: media },
      ];
      // As a deploy holds it: the file the rewrite names, under the pathname it rewrites.
      const held = {
        '/a.txt': fileOf('rewritten bytes', TEXT),
        [media]: fileOf('rewritten bytes', TEXT),
      };
      const result = await checkStack(stackOf([], held, { written, beforeFiles }));

      // The asset asked for with the deployment's id, too.
      expect(result).toStrictEqual({ checked: 3, failures: [], skipped: [] });
    });

    it('fails where a file a rewrite names, or one the build wrote, is held otherwise than written', async () => {
      const dmg = '/_next/static/media/app.dmg';
      const asServed: Answer = {
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: 'disk image',
      };
      answers.set(dmg, asServed);
      answers.set('/download', asServed);
      const image = { ...writtenAs(dmg, 'disk image') };
      const written = [
        { ...image, blob: { ...image.blob, contentType: 'application/octet-stream' } },
      ];
      // A rewrite of a pathname the build wrote nothing at, onto a file the Function does not carry.
      const beforeFiles = [{ source: '/download', sourceRegex: '^/download$', destination: dmg }];
      const held = fileOf('disk image', 'application/octet-stream');
      const both = await checkStack(
        stackOf([], { [dmg]: held, '/download': held }, { written, beforeFiles }),
      );
      const unaliased = await checkStack(stackOf([], { [dmg]: held }, { written, beforeFiles }));
      const retyped = await checkStack(
        stackOf(
          [],
          { [dmg]: { ...held, contentType: TEXT }, '/download': held },
          {
            written,
            beforeFiles,
          },
        ),
      );

      // The asset asked for with the deployment's id, too.
      expect(both).toStrictEqual({ checked: 3, failures: [], skipped: [] });
      expect(unaliased.failures).toStrictEqual([
        {
          path: '/download',
          reason:
            'named by an unconditional rewrite of the build onto a file, and held by no entry of the manifest the edge serves by',
        },
      ]);
      expect(retyped.failures).toContainEqual({
        path: dmg,
        reason: `held by the manifest the edge serves by with type ${TEXT}, not the application/octet-stream the build wrote`,
      });
    });

    it('is asked under the asset prefix its pages load it by, too', async () => {
      const script = 'self.chunk = 1;';
      const chunk = '/_next/static/chunks/a.js';
      const prefixed = '/assets/_next/static/chunks/a.js';
      const asServed: Answer = {
        headers: { 'content-type': SCRIPT, 'cache-control': IMMUTABLE, 'x-arkor-edge': FILE_EDGE },
        body: script,
      };
      const held = { [chunk]: fileOf(script, SCRIPT, true) };
      answers.set(chunk, asServed);
      answers.set(prefixed, asServed);
      const both = await checkStack(stackOf([], held, { assetPrefix: '/assets' }));
      answers.delete(prefixed);
      const unprefixed = await checkStack(stackOf([], held, { assetPrefix: '/assets' }));

      // Each asked for with the deployment's id, too.
      expect(both).toStrictEqual({ checked: 4, failures: [], skipped: [] });
      expect(unprefixed.failures.map((failure) => failure.path)).toStrictEqual([
        prefixed,
        `${prefixed}?dpl=dpl_site`,
      ]);
    });

    it('is asked with a slash after it too, where the application keeps its pages behind one', async () => {
      const manual = 'the manual';
      const asServed: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: manual,
      };
      const held = { '/manual': fileOf(manual, TEXT) };
      answers.set('/manual', asServed);
      answers.set('/manual/', asServed);
      const both = await checkStack(stackOf([], held, { trailingSlash: true }));
      answers.delete('/manual/');
      const unslashed = await checkStack(stackOf([], held, { trailingSlash: true }));

      expect(both).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(unslashed.failures.map((failure) => failure.path)).toStrictEqual(['/manual/']);
    });

    it('is asked with a slash after it as the build keeps it, whatever the manifest says', async () => {
      const manual = 'the manual';
      const asServed: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: manual,
      };
      const held = { '/manual': fileOf(manual, TEXT) };
      answers.set('/manual', asServed);
      // The edge, holding no slash, hands the slashed spelling on to the Function.
      answers.set('/manual/', {
        status: 404,
        headers: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=miss;m=0000' },
        body: NOT_FOUND,
      });
      const result = await checkStack(
        stackOf([], held, { trailingSlash: true, held: { staticFileTrailingSlash: undefined } }),
      );

      expect(result.failures.map((failure) => failure.path)).toStrictEqual([
        'staticFileTrailingSlash',
        '/manual/',
      ]);
    });

    it('is asked as a browser says which page loads it, where rules claim a request that says none', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const unreferred: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'referer' }],
      };
      // And one that claims what a check would make up to pass the first over.
      const madeUp: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'referer', value: '1' }],
      };
      const result = await checkStack(
        stackOf([], files, { reservedRoutes: [unreferred, madeUp] }),
        { hostname: 'site.example' },
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(askedHeaders.get('/a.txt')?.referer).toBe('https://site.example/');
    });

    it('is answered whole on the entity tag it was served under, where the middleware tags that request otherwise', async () => {
      const asTagged: Answer = {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
          etag: '"a"',
        },
        body: 'kept bytes',
      };
      decisions.set('/a.txt', { 'x-middleware-next': '1', etag: '"a"' });
      decidedOnCondition.set('/a.txt', { 'x-middleware-next': '1' });
      // As the edge answers it: the tag the browser holds is not the one the request's answer has.
      const whole: Answer = {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      };
      answers.set('/a.txt', { ...asTagged, onCondition: whole });
      const resent = await checkStack(stackOf([], files));
      // And a `304` in its place, which leaves the browser holding what is no longer the file.
      answers.set('/a.txt', asTagged);
      const unmodified = await checkStack(stackOf([], files));

      expect(resent).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unmodified.failures).toStrictEqual([
        { path: '/a.txt', reason: 'asked for on If-None-Match "a", answered 304, not 200' },
      ]);
    });

    it('is answered as one a browser already has, asked for on its entity tag', async () => {
      const whole: Answer = {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      };
      answers.set('/a.txt', whole);
      const revalidated = await checkStack(stackOf([], files));
      answers.set('/a.txt', { ...whole, unconditional: true });
      const resent = await checkStack(stackOf([], files));

      expect(revalidated).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(resent.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: `answered If-None-Match "${sha256Of('kept bytes')}" with 200, not 304`,
        },
      ]);
    });

    it('fails where it does not carry the cookie the middleware set beside it', async () => {
      const ranOn = {
        'content-type': TEXT,
        'cache-control': GATED,
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      };
      decisions.set('/a.txt', { 'x-middleware-next': '1', 'set-cookie': 'session=abc; Path=/' });
      answers.set('/a.txt', { headers: ranOn, body: 'kept bytes' });
      const dropped = await checkStack(stackOf([], files));
      answers.set('/a.txt', {
        headers: { ...ranOn, 'set-cookie': ['session=abc; Path=/'] },
        body: 'kept bytes',
      });
      const kept = await checkStack(stackOf([], files));

      expect(dropped.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: 'answered without the cookie session=abc; Path=/ the application set',
        },
      ]);
      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("is held to the middleware's cookie as the edge scopes it to the site's hostname, and to none of the edge's own headers", async () => {
      const ranOn = {
        'content-type': TEXT,
        'cache-control': GATED,
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      };
      // For every host of a domain the stack's own hostname is not in, which the edge takes off.
      const set = 'session=abc; Domain=example.com; Path=/';
      decisions.set('/a.txt', { 'x-middleware-next': '1', 'set-cookie': set });
      answers.set('/a.txt', {
        headers: { ...ranOn, 'set-cookie': ['session=abc; Path=/'] },
        body: 'kept bytes',
      });
      const scoped = await checkStack(stackOf([], files));
      answers.set('/a.txt', { headers: { ...ranOn, 'set-cookie': [set] }, body: 'kept bytes' });
      const unscoped = await checkStack(stackOf([], files));
      // Under a hostname of that domain, which keeps it.
      const named = await checkStack(stackOf([], files), { hostname: 'www.example.com' });
      // A header of the edge's own, which it sends none of a middleware's.
      decisions.set('/a.txt', { 'x-middleware-next': '1', 'x-arkor-note': 'set' });
      answers.set('/a.txt', { headers: ranOn, body: 'kept bytes' });
      const unmarked = await checkStack(stackOf([], files));

      expect(scoped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unscoped.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: 'answered without the cookie session=abc; Path=/ the application set',
        },
      ]);
      expect(named).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unmarked).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('fails where a range of it is answered other than from storage', async () => {
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
        inPart: {
          status: 206,
          headers: {
            'content-type': TEXT,
            'content-range': 'bytes 1-9/10',
            'accept-ranges': 'bytes',
            'x-arkor-edge': 'passthrough;reason=route-not-proved',
          },
          body: 'ept bytes',
        },
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            'answered bytes=1-9 not from storage (x-arkor-edge: passthrough;reason=route-not-proved)',
        },
      ]);
    });

    it('is judged no further where the middleware changed what the request selects of it', async () => {
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': REVALIDATE,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        // What the edge answers the range the middleware added with.
        status: 206,
        body: 'ept bytes',
      });
      decisions.set('/a.txt', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'range',
        'x-middleware-request-range': 'bytes=1-9',
      });
      const result = await checkStack(stackOf([], files));

      expect(result.skipped).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            "the application's middleware changed what the request selects of the file (a range, a condition)",
        },
      ]);
    });

    it('is judged on, asked for a range of it, where the middleware passed on every header it was sent', async () => {
      // As `NextResponse.next({ request: { headers } })` lists them, from the request's own.
      decisions.set('/a.txt', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'x-seen',
        'x-middleware-request-x-seen': '1',
      });
      decidedInPart.set('/a.txt', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'range,x-seen',
        'x-middleware-request-range': 'bytes=1-9',
        'x-middleware-request-x-seen': '1',
      });
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
        inPart: {
          status: 206,
          headers: {
            'content-type': TEXT,
            'content-range': 'bytes 1-9/10',
            'accept-ranges': 'bytes',
            'x-arkor-edge': 'passthrough;reason=route-not-proved',
          },
          body: 'ept bytes',
        },
      });
      const result = await checkStack(stackOf([], files));

      expect(result.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            'answered bytes=1-9 not from storage (x-arkor-edge: passthrough;reason=route-not-proved)',
        },
      ]);
    });

    it('is answered with every header a rule of next.config sets on it', async () => {
      const named: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        headers: { 'X-Content-Type-Options': 'nosniff' },
      };
      const asSet = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
      };
      answers.set('/a.txt', { headers: asSet, body: 'kept bytes' });
      const dropped = await checkStack(stackOf([], files, { headerRules: [named] }));
      answers.set('/a.txt', {
        headers: { ...asSet, 'x-content-type-options': 'nosniff' },
        body: 'kept bytes',
      });
      const kept = await checkStack(stackOf([], files, { headerRules: [named] }));

      expect(dropped.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: 'answered with x-content-type-options none, not the nosniff the application set',
        },
      ]);
      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("is held to a rule's cookie as the edge scopes it to the site's hostname", async () => {
      // For every host of a domain the stack's own hostname is not in, which the edge takes off.
      const set = 'ruled=1; Domain=example.com; Path=/';
      const named: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        headers: { 'Set-Cookie': set },
      };
      const asSet = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
      };
      answers.set('/a.txt', {
        headers: { ...asSet, 'set-cookie': ['ruled=1; Path=/'] },
        body: 'kept bytes',
      });
      const scoped = await checkStack(stackOf([], files, { headerRules: [named] }));
      answers.set('/a.txt', { headers: { ...asSet, 'set-cookie': [set] }, body: 'kept bytes' });
      const unscoped = await checkStack(stackOf([], files, { headerRules: [named] }));
      // Under a hostname of that domain, which keeps it.
      const hosted = await checkStack(stackOf([], files, { headerRules: [named] }), {
        hostname: 'www.example.com',
      });

      expect(scoped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unscoped.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: 'answered without the cookie ruled=1; Path=/ the application set',
        },
      ]);
      expect(hosted).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is asked as a module script where rules claim a script asked for without CORS', async () => {
      const script = { '/a.js': fileOf('module', SCRIPT) };
      const unmoded: ReservedRoute = {
        sourceRegex: String.raw`^/a\.js$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-mode' }],
      };
      const classic: ReservedRoute = {
        sourceRegex: String.raw`^/a\.js$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-mode', value: 'no-cors' }],
      };
      answers.set('/a.js', {
        headers: { 'content-type': SCRIPT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'module',
      });
      const result = await checkStack(stackOf([], script, { reservedRoutes: [unmoded, classic] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(modes.get('/a.js')).toBe('cors');
    });

    it('is asked as a browser asks for an image, by the types it names for one', async () => {
      const image = { '/a.png': fileOf('png bytes', 'image/png') };
      // A rule for a request that names no image type: the check's own, which accepts any type.
      const notForImages: ReservedRoute = {
        sourceRegex: String.raw`^/a\.png$`,
        beforeFiles: true,
        missing: [{ type: 'header', key: 'accept', value: '.*image/.*' }],
      };
      answers.set('/a.png', {
        headers: {
          'content-type': 'image/png',
          'cache-control': REVALIDATE,
          'x-arkor-edge': FILE_EDGE,
        },
        body: 'png bytes',
      });
      const result = await checkStack(stackOf([], image, { reservedRoutes: [notForImages] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(accepted.get('/a.png')).toBe(
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      );
    });

    it('is said to be in no coding, but one a rule of next.config names', async () => {
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': REVALIDATE,
          'content-encoding': 'br',
          'x-arkor-edge': FILE_EDGE,
        },
        body: 'kept bytes',
      });
      const named: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        headers: { 'Content-Encoding': 'br' },
      };
      const unnamed = await checkStack(stackOf([], files));
      const ruled = await checkStack(stackOf([], files, { headerRules: [named] }));

      expect(unnamed.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason:
            'answered with Content-Encoding br, not none, to a request that accepts identity alone',
        },
      ]);
      expect(ruled).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });
  });

  describe('a page, asked as the browsers validation asks as', () => {
    it("is asked first as a host's prover, where its validation proves a build as one", async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set(MISS, { status: 404, headers: { 'content-type': HTML }, body: '' });
      const proverAgent = 'host-prover/2.0';
      const result = await checkStack(stackOf(routes, {}, { functions: ['app'] }), { proverAgent });

      expect(result).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      // The page, as it is asked first, and the Function's miss.
      expect([agentsAsked.get('/')?.[0], agents.get(MISS)]).toStrictEqual([
        proverAgent,
        proverAgent,
      ]);
    });

    it('is judged by the rules as it is sent, under the forwarding headers validation sends', async () => {
      const routes = [await routeOf('/', FRONT)];
      // Handed on, as the edge hands on a request a rule claims, whatever coding it accepts.
      answers.set('/', handedOnAs('passthrough;reason=route-not-proved'));
      const forwardedOnly: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'x-forwarded-proto' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [forwardedOnly] }));

      // Every request validation sends carries it, so the rule claims every one of them.
      expect(result.skipped).toStrictEqual([
        { path: '/', reason: 'claimed by a redirect or rewrite of next.config' },
      ]);
    });

    it('is asked carrying a value the pattern of a rule that claims it without one matches', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', claimedWithout(documentAnswer(FRONT, 'mw=miss;route=/'), 'role'));
      // Next.js matches the pattern against the whole value: `^(admin|editor)$` is no value of it.
      const staffOnly: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'role', value: '^(admin|editor)$' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [staffOnly] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(askedHeadersEach.get('/')?.[0]?.cookie).toBe('role=admin');
    });

    it('fails where only a value the check finds none of would pass a rule over', async () => {
      const routes = [await routeOf('/', FRONT)];
      const dated: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'since', value: '[0-9]{4}-[0-9]{2}' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [dated] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'a rule of next.config claims every request the check makes for what it lacks, and only a value its pattern names, of which the check finds none it matches, would pass it over: no request proves it',
        },
      ]);
    });

    it("is the rule's where only a request of another class would pass it over", async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', handedOnAs('passthrough;reason=route-not-proved'));
      // A request with `_rsc` is a payload's, which the edge hands on: no navigation passes it.
      const payloadsOnly: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'query', key: '_rsc' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [payloadsOnly] }));

      expect(result.skipped).toStrictEqual([
        { path: '/', reason: 'claimed by a redirect or rewrite of next.config' },
      ]);
    });

    it("is asked carrying the stack's own trace header where a rule claims a request without it", async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const untraced: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'x-upwind-trace' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [untraced] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // The check's id goes under the name, and the value the rule asks for back in its place.
      expect(restored.get('/')).toBe('1');
    });

    it('is asked carrying the cookie a rule claims every request of the check without', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', claimedWithout(documentAnswer(FRONT, 'mw=miss;route=/'), 'session'));
      // Sent to its login when signed out: a signed-in visitor is served the shell.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'session' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [signedOut] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(askedHeadersEach.get('/')?.[0]?.cookie).toBe('session=1');
    });

    it('is asked as Chrome, Client Hints and all, where a rule claims a request without them', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const withoutHints: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-ch-ua' }],
      };
      // Each browser that sends none — Safari, Firefox — handed on for want of a route, as the edge
      // hands on one claimed.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        withoutHeader: {
          name: 'sec-ch-ua',
          headers: { 'x-arkor-edge': 'passthrough;reason=route-not-proved' },
        },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [withoutHints] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(agentsAsked.get('/')?.[0]).toContain('Windows NT 10.0');
    });

    it('is asked as the next browser where the application sends the check and Chrome blocking metadata', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}, { htmlLimitedBots: 'Chrome|upwind' }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(agentsAsked.get('/')?.[0]).toContain('iPhone');
    });

    it("is asked as the check's own agent where the application sends every browser blocking metadata", async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}, { htmlLimitedBots: 'Mozilla' }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // First, as the page is asked; each browser's navigation after, for what it keeps of it.
      expect(agentsAsked.get('/')?.[0]).toBe('upwind-local-check/1.0');
    });

    it('is asked without a User-Agent where the application sends every agent blocking metadata', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}, { htmlLimitedBots: '.' }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // First, as the page is asked; each browser's navigation after, for what it keeps of it.
      expect(agentsAsked.get('/')).toContain(undefined);
      expect(agentsAsked.get('/')?.[0]).toBeUndefined();
    });

    it('fails where a rule that asks of the agent claims every browser the check asks as', async () => {
      const routes = [await routeOf('/', FRONT)];
      const mozilla: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'user-agent', value: '.+' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [mozilla] }));

      expect(result.checked).toBe(1);
      expect(result.failures[0]?.reason).toMatch(
        /claims every browser the check asks as, but not every agent/u,
      );
    });

    it('is skipped where its bypassFor holds for every request the check could make', async () => {
      const route = await routeOf('/', FRONT);
      const routes = [{ ...route, bypassFor: [{ type: 'header' as const, key: 'accept' }] }];
      // Handed on for it, in every coding asked for as well.
      answers.set('/', handedOnAs('passthrough;reason=bypass-for'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result).toStrictEqual({
        checked: 0,
        failures: [],
        skipped: [
          {
            path: '/',
            reason:
              "its route's bypassFor holds for every request the check could make, which Next.js renders itself",
          },
        ],
      });
    });

    it('reads a rule that asks of the encodings accepted by those the front line hands every request with', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // Every navigation reaches the edge accepting what Cloudflare's front line sets in the
      // visitor's place (`gzip, br`): a rule that asks for nothing coded claims none of them.
      const unencoded: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'accept-encoding', value: 'identity' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [unencoded] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is asked where a rule claims only a request without the Host every request carries', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const hostless: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'host' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [hostless] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is skipped where a rule claims it whichever browser asks', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', handedOnAs('passthrough;reason=route-not-proved'));
      // On what every request carries: a rule that claims the page whatever a request is, a deploy
      // routes none for (`claimedBeforeFiles`).
      const every: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'host' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [every] }));

      expect(result).toStrictEqual({
        checked: 0,
        failures: [],
        skipped: [{ path: '/', reason: 'claimed by a redirect or rewrite of next.config' }],
      });
    });
  });

  describe('a page', () => {
    it('has the stack let go of what it kept of each request it traced, read or not', async () => {
      const routes = [await routeOf('/', FRONT)];
      // Its `HEAD` answered by the middleware, of which the check reads nothing kept.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        onHead: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
      });
      // And a file the middleware answered, likewise.
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: 'theirs',
      });
      const result = await checkStack(stackOf(routes, { '/a.txt': fileOf('kept bytes', TEXT) }));
      const kept = [...traceIds.registered].filter(
        (id) => !traceIds.read.has(id) && !traceIds.letGo.has(id),
      );

      expect(result.failures).toStrictEqual([]);
      expect(traceIds.registered.size).toBeGreaterThan(2);
      expect(kept).toStrictEqual([]);
    });

    /**
     * A page Next.js names with a `%` and a space in a parameter (`prerender-encoding`), asked as
     * validation asks it: by the path a request names it by. Written into the URL as it is, its `%`
     * starts no escape, and the edge finds no page there.
     */
    it('asks for a page whose name holds a percent sign by the path a request names it by', async () => {
      const name = '/closed/docs/space here/100%';
      const asked = '/closed/docs/space%20here/100%25';
      const routes = [await routeOf('/', FRONT), await routeOf(name, ABOUT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set(asked, documentAnswer(ABOUT, `mw=miss;route=${name}`));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
      expect(agents.has(asked)).toBe(true);
    });

    /** A parameter whose value is `..` names a page no URL reaches: it is reported, not asked. */
    it('passes over a page no request reaches, rather than ask for another in its place', async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/docs/..', ABOUT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
      expect(result.skipped).toContainEqual({ path: '/docs/..', reason: 'no request reaches it' });
    });

    it('fails where a page the build prerendered for the edge is held by no route, or as another shell', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const front = prerenderOf('/', FRONT);
      const held = await checkStack(stackOf(routes, {}, { prerendered: [front] }));
      const about = prerenderOf('/about', ABOUT);
      const dropped = await checkStack(stackOf(routes, {}, { prerendered: [front, about] }));
      const swapped = await checkStack(
        stackOf(routes, {}, { prerendered: [prerenderOf('/', ABOUT)] }),
      );
      // A resumable shell whose policy sandboxes away the recovery script, which a deploy leaves to
      // the Function on purpose.
      const sandboxed = prerenderOf('/about', ABOUT, {
        postponed: { sha256: sha256Of('state'), byteLength: 5, contentType: 'text/plain' },
        initialHeaders: { 'content-security-policy': 'sandbox' },
      });
      const leftOut = await checkStack(stackOf(routes, {}, { prerendered: [front, sandboxed] }));

      expect(held).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // And resolved exactly where the build routes it, as no route of the manifest is.
      expect(dropped.failures).toStrictEqual([
        {
          path: 'exactPathnames',
          reason:
            'held by the manifest the edge serves by with the exactPathnames entry "/about", which the build has none of',
        },
        {
          path: '/about',
          reason:
            'prerendered by the build for the edge to serve, and held by no route of the manifest the edge serves by',
        },
      ]);
      expect(swapped.failures).toStrictEqual([
        {
          path: '/',
          reason: 'held by the manifest the edge serves by as another shell than the build wrote',
        },
      ]);
      expect(leftOut).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("fails where the manifest holds a route as another Function's than the build places it in", async () => {
      const route = { ...(await routeOf('/', FRONT)), function: 'app-2' };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(
        stackOf(
          [route],
          {},
          {
            prerendered: [prerenderOf('/', FRONT)],
            appFunctions: { 'app-2': 'site-app-2' },
          },
        ),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'held by the manifest the edge serves by as a route of the app-2 Function, not of the app one the build places it in',
        },
      ]);
    });

    it("fails where the manifest holds a route with other headers, bypasses or delivery than the build's page", async () => {
      const front = prerenderOf('/', FRONT);
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A header the build's shell is never answered with.
      const framed = {
        ...(await routeOf('/', FRONT)),
        headers: { 'content-type': HTML, 'x-frame-options': 'DENY' },
      };
      const reheaded = await checkStack(stackOf([framed], {}, { prerendered: [front] }));
      // Bypassed for a draft's cookie the build never named.
      const preview = { type: 'cookie' as const, key: 'preview' };
      const bypassed = { ...(await routeOf('/', FRONT)), bypassFor: [preview] };
      const rebypassed = await checkStack(stackOf([bypassed], {}, { prerendered: [front] }));
      // Served whole, though the build left it to be resumed.
      const finished = await routeOf('/', FRONT, { complete: true });
      const completed = await checkStack(stackOf([finished], {}, { prerendered: [front] }));

      expect(reheaded.failures).toContainEqual({
        path: '/',
        reason:
          "held by the manifest the edge serves by with x-frame-options DENY, not the none the build's shell is answered with",
      });
      expect(rebypassed.failures).toContainEqual({
        path: '/',
        reason:
          'held by the manifest the edge serves by as bypassed for [{"type":"cookie","key":"preview"}], not the [] the build prerendered it with',
      });
      expect(completed.failures).toContainEqual({
        path: '/',
        reason:
          'held by the manifest the edge serves by as a page whole in itself, though the build prerendered it to be resumed',
      });
    });

    it('fails where the manifest holds a route the build prerendered no page for', async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/stray', ABOUT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/stray', documentAnswer(ABOUT, 'mw=miss;route=/stray'));
      const front = prerenderOf('/', FRONT);
      const stray = await checkStack(stackOf(routes, {}, { prerendered: [front] }));

      expect(stray.failures).toStrictEqual([
        {
          path: '/stray',
          reason:
            'held by the manifest the edge serves by as a route, though the build prerendered no page for the edge to serve under its name',
        },
      ]);
    });

    it('fails where a shell is held as another type than the build wrote, or held where the Function has to answer', async () => {
      const front = prerenderOf('/', FRONT);
      const retyped = {
        ...(await routeOf('/', FRONT)),
        shell: { ...(await routeOf('/', FRONT)).shell, contentType: TEXT },
      };
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        headers: { ...documentAnswer(FRONT, 'mw=miss;route=/').headers, 'content-type': TEXT },
      });
      const asText = await checkStack(stackOf([retyped], {}, { prerendered: [front] }));
      // A resumable shell whose policy sandboxes away the recovery script, held as a route all the same.
      const sandboxed = prerenderOf('/about', ABOUT, {
        postponed: { sha256: sha256Of('state'), byteLength: 5, contentType: 'text/plain' },
        initialHeaders: { 'content-security-policy': 'sandbox' },
      });
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/about', documentAnswer(ABOUT, 'mw=miss;route=/about'));
      const routes = [await routeOf('/', FRONT), await routeOf('/about', ABOUT)];
      const kept = await checkStack(stackOf(routes, {}, { prerendered: [front, sandboxed] }));

      expect(asText.failures).toContainEqual({
        path: '/',
        reason: `held by the manifest the edge serves by with its shell's type ${TEXT}, not the ${HTML} the build wrote`,
      });
      // And not resolved exactly, as a pathname the build routes no page at is.
      expect(kept.failures).toStrictEqual([
        {
          path: 'exactPathnames',
          reason:
            'held by the manifest the edge serves by without the exactPathnames entry "/about" the build has',
        },
        {
          path: '/about',
          reason:
            "held by the manifest the edge serves by as a shell, though its policy sandboxes away the script that recovers a failed continuation, which leaves it to the deployment's Function",
        },
      ]);
    });

    it("is a member's own render where the edge served the first generation of the member's own record", async () => {
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const routes = [await routeOf('/items/[id]', ITEM)];
      const dynamicRoutes: DynamicRoute[] = [
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[id]' },
      ];
      const member = validationPathnameFor('/items/[id]') ?? '';
      generationHeaders.set(`dpl_site|${await entryOf(member)}|1`, { 'content-type': HTML });
      const rendered = '<!doctype html><html><head><title>Item, its own</title></head><body>';
      answers.set(
        member,
        documentAnswer(rendered, 'mw=miss;route=/items/[id];cache=fresh;seq=1;member=1'),
      );
      const own = await checkStack(stackOf(routes, {}, { dynamicRoutes }));

      expect(own).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is named by its whole pathname, a semicolon in it included', async () => {
      const routes = [await routeOf('/docs/a;b', FRONT)];
      await readGenerations('/docs/a;b', [1]);
      answers.set('/docs/a;b', documentAnswer(FRONT, 'mw=miss;route=/docs/a;b;cache=fresh;seq=1'));

      await expect(checkStack(stackOf(routes, {}))).resolves.toStrictEqual({
        checked: 1,
        failures: [],
        skipped: [],
      });
    });

    it('ends with </body></html>, not with </html> alone', async () => {
      const routes = [await routeOf('/', FRONT)];
      const answered = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', { ...answered, body: `${FRONT}<main>rendered</main></html>` });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        { path: '/', reason: 'the document does not end with </body></html>' },
      ]);
    });

    it('is kept from shared caches even when the application set an overriding header', async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/about', ABOUT)];
      // A header a shell is never recorded with (`SHELL_RESPONSE_HEADER_ALLOWLIST`), which a rule of
      // the application's sets on it at every request.
      const cdn: HeaderRule = {
        sourceRegex: '^/about$',
        headers: { 'CDN-Cache-Control': 'max-age=60' },
      };
      const shared = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...shared,
        headers: { ...shared.headers, 'cache-control': 'public, max-age=60' },
      });
      const recorded = documentAnswer(ABOUT, 'mw=miss;route=/about');
      answers.set('/about', {
        ...recorded,
        headers: { ...recorded.headers, 'cdn-cache-control': 'max-age=60' },
      });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [cdn] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: "answered for shared caches to keep, though the answer is one visitor's",
        },
        {
          path: '/about',
          reason:
            "answered with cdn-cache-control, by which a shared cache keeps it, though the answer is one visitor's",
        },
      ]);
    });

    it('is its shell, whole and no more, where the build finished it', async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const routes = [await routeOf('/', finished, { complete: true })];
      const whole = {
        headers: { ...documentAnswer(finished, 'mw=miss;route=/').headers },
        body: finished,
      };
      answers.set('/', {
        ...whole,
        headers: {
          ...whole.headers,
          'x-arkor-edge':
            'shell;strategy=edge;src=kv;m=0000;policy=default;cont=none;mw=miss;route=/',
        },
      });
      const served = await checkStack(stackOf(routes, {}));
      answers.set('/', {
        ...whole,
        body: `${finished}<p>more</p></body></html>`,
        headers: {
          ...whole.headers,
          'x-arkor-edge':
            'shell;strategy=edge;src=kv;m=0000;policy=default;cont=none;mw=miss;route=/',
        },
      });
      const longer = await checkStack(stackOf(routes, {}));
      answers.set('/', whole);
      const continued = await checkStack(stackOf(routes, {}));

      expect(served).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(longer.failures[0]?.reason).toMatch(
        /^answered \d+ bytes, not the \d+ the build finished$/u,
      );
      expect(continued.failures[0]?.reason).toMatch(/^continued, though the build finished it/u);
    });

    it("is resumed from a generation rendered since that holds a resume's state, though the build finished it", async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const routes = [await routeOf('/', finished, { complete: true })];
      await readGenerations('/', [1, 2]);
      const rendered = '<!doctype html><html><head><title>Front, again</title></head><body>';
      const entry = await entryOf('/', '/');
      const later: RecordedGeneration = {
        headers: { 'content-type': HTML },
        artifacts: [],
        partial: true,
        source: 'runtime',
      };
      // Resumed from the later render, which reached a postponed boundary (greptile), as its HEAD
      // is handed on for the resume.
      answers.set('/', {
        ...documentAnswer(rendered, 'mw=miss;route=/;cache=fresh;seq=2'),
        onHead: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=head-resumed;mw=hit' },
      });
      partialGenerations.add(`dpl_site|${entry}|2`);
      capturedHeadRecords.set('/', { [`${kvGenerationKey('dpl_site', entry)}|2`]: later });
      const postponed = await checkStack(stackOf(routes, {}));
      partialGenerations.clear();
      capturedHeadRecords.set('/', {
        [`${kvGenerationKey('dpl_site', entry)}|2`]: { ...later, partial: false },
      });
      const complete = await checkStack(stackOf(routes, {}));

      expect(postponed).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(complete.failures[0]?.reason).toMatch(
        /^continued, though the build finished it and the generation it was served from is complete/u,
      );
    });

    it("is the application's where the middleware has its headers alone bypass its prerender", async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const preview = { type: 'header' as const, key: 'x-preview' };
      const routes = [
        { ...(await routeOf('/', finished, { complete: true })), bypassFor: [preview] },
      ];
      const account = 'shell;strategy=edge;src=kv;m=0000;policy=default;cont=none;mw=hit;route=/';
      const whole = {
        headers: {
          ...documentAnswer(finished, 'mw=hit;route=/').headers,
          'x-arkor-edge': account,
        },
        body: finished,
      };
      // The `HEAD` handed to the Function, its middleware having set the header the bypass holds for.
      const handedOn = { ...whole.headers, 'x-arkor-edge': 'passthrough;reason=bypass-for;mw=hit' };
      answers.set('/', { ...whole, onHead: handedOn });
      decidedOnHead.set('/', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'x-preview',
        'x-middleware-request-x-preview': '1',
      });
      const bypassed = await checkStack(stackOf(routes, {}));
      // Left as it came, a `HEAD` handed on is no bypass's.
      decidedOnHead.clear();
      const unmoved = await checkStack(stackOf(routes, {}));

      expect(bypassed).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unmoved.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'asked for with HEAD, not answered from the shell of its own route (x-arkor-edge: passthrough;reason=bypass-for;mw=hit)',
        },
      ]);
    });

    it('fails where its headers alone are answered as a route the middleware did not move it to', async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const routes = [await routeOf('/', finished, { complete: true })];
      const account = 'shell;strategy=edge;src=kv;m=0000;policy=default;cont=none;mw=miss;route=/';
      const whole = {
        headers: {
          ...documentAnswer(finished, 'mw=miss;route=/').headers,
          'x-arkor-edge': account,
        },
        body: finished,
      };
      const elsewhere = account.replace('route=/', 'route=/about');
      answers.set('/', { ...whole, onHead: { ...whole.headers, 'x-arkor-edge': elsewhere } });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: `asked for with HEAD, not answered from the shell of its own route (x-arkor-edge: ${elsewhere})`,
        },
      ]);
    });

    it('holds its headers alone, which the middleware rewrote to another finished route, to that route', async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const aboutFinished = `${ABOUT}<main>finished</main></body></html>`;
      const routes = [
        await routeOf('/', finished, { complete: true }),
        await routeOf('/about', aboutFinished, { complete: true }),
      ];
      const front = finishedAnswer(finished, '/');
      const about = finishedAnswer(aboutFinished, '/about');
      answers.set('/about', about);
      decidedOnHead.set('/', { 'x-middleware-rewrite': '/about' });
      answers.set('/', { ...front, onHead: about.headers });
      const landed = await checkStack(stackOf(routes, {}));
      answers.set('/', { ...front, onHead: front.headers });
      const unmoved = await checkStack(stackOf(routes, {}));
      const handedOn = { ...about.headers, 'x-arkor-edge': 'passthrough;reason=head;mw=hit' };
      answers.set('/', { ...front, onHead: handedOn });
      const passedOn = await checkStack(stackOf(routes, {}));

      expect(landed).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(unmoved.failures).toStrictEqual([
        {
          path: '/',
          reason: `asked for with HEAD, rewritten to /about, the route /about, and answered from the shell of the route / (x-arkor-edge: ${finishedAccount('/')})`,
        },
      ]);
      expect(passedOn.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'asked for with HEAD, rewritten to /about, the route /about, and not answered from its shell (x-arkor-edge: passthrough;reason=head;mw=hit)',
        },
      ]);
    });

    it("fails where it is regenerated where the build's middleware covers it, and did not run", async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      // Nothing kept of the middleware, which did not run; and nothing said of it.
      unkept.add('/');
      answers.set('/', {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${FRONT}${REST}`,
      });
      const stack = stackOf(routes, {});
      const uncovered = await checkStack(stack);
      // A middleware of the build's whose matcher covers the page, which the stack runs.
      const covered = await checkStack(withMiddleware(stack, [{ sourceRegex: '^/$' }]));

      expect(uncovered).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(covered.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "the application's middleware covers it, and the edge regenerated it without running the middleware",
        },
      ]);
    });

    it('fails where it is regenerated where the middleware did not run, before what its policy says', async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      unkept.add('/');
      // Under another policy than the stack's, as well.
      answers.set('/', {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=paas-v4;scope=dpl_site',
        },
        body: `${FRONT}${REST}`,
      });
      const result = await checkStack(
        withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "the application's middleware covers it, and the edge regenerated it without running the middleware",
        },
      ]);
    });

    it('is handed on to the Function where it is asked for its headers alone and a resume completes it', async () => {
      const routes = [await routeOf('/', FRONT)];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', composed);
      const handedOn = await checkStack(stackOf(routes, {}));
      answers.set('/', { ...composed, onHead: composed.headers });
      const fromShell = await checkStack(stackOf(routes, {}));
      // Its `GET` behind the middleware that covers it, its `HEAD` handed on without it.
      const ran = documentAnswer(FRONT, 'mw=hit;route=/');
      answers.set('/', {
        ...ran,
        onHead: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=head-resumed' },
      });
      unkeptOnHead.add('/');
      const unrun = await checkStack(withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]));

      expect(handedOn).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(fromShell.failures).toStrictEqual([
        {
          path: '/',
          reason: `asked for with HEAD, not handed on to the Function, as a page a resume completes is (x-arkor-edge: ${String(composed.headers['x-arkor-edge'])})`,
        },
      ]);
      expect(unrun.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "asked for with HEAD, the application's middleware covers it, and the edge handed it on without running the middleware",
        },
      ]);
    });

    it.each([
      { getComplete: true, headMode: 'resumed', partials: [] },
      { getComplete: false, headMode: 'whole', partials: [2, 3] },
    ])(
      'judges a $headMode HEAD from its own generation after the GET changed mode',
      async ({ getComplete, partials }) => {
        const finished = `${FRONT}${REST}`;
        const routes = [
          await routeOf('/', getComplete ? finished : FRONT, { complete: getComplete }),
        ];
        const entry = await entryOf('/', '/');
        const record = `dpl_site|${entry}`;
        const initial = getComplete
          ? finishedAnswer(finished, '/')
          : documentAnswer(FRONT, 'mw=hit;route=/');
        generationHeaders.set(`${record}|2`, { 'content-type': HTML });
        // A later lookup disagrees with the HEAD's captured partial flag and headers.
        generationHeaders.set(`${record}|3`, { 'content-type': HTML, 'x-recorded': 'later-live' });
        for (const seq of partials) partialGenerations.add(`${record}|${seq}`);
        const ownHeaders = { 'content-type': HTML, 'x-recorded': 'head-snapshot' };
        capturedHeadRecords.set('/', {
          [`${kvGenerationKey('dpl_site', entry)}|3`]: {
            headers: ownHeaders,
            artifacts: [],
            partial: getComplete,
            source: 'runtime',
          },
        });
        answers.set('/', {
          ...initial,
          headers: {
            ...initial.headers,
            'x-arkor-edge': `${String(initial.headers['x-arkor-edge'])};cache=HIT;seq=2`,
          },
          onHead: {
            ...initial.headers,
            ...ownHeaders,
            'x-arkor-edge': getComplete
              ? 'passthrough;reason=head-resumed;mw=hit'
              : `${finishedAccount('/')};cache=HIT;seq=3`,
          },
        });

        const result = await checkStack(stackOf(routes, {}));

        expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
        expect(headTraces.size).toBeGreaterThan(0);
      },
    );

    it('rejects a resumed HEAD whose own trace read only complete generations', async () => {
      const finished = `${FRONT}${REST}`;
      const routes = [await routeOf('/', finished, { complete: true })];
      const entry = await entryOf('/', '/');
      const complete = finishedAnswer(finished, '/');
      capturedHeadRecords.set('/', {
        [`${kvGenerationKey('dpl_site', entry)}|3`]: {
          headers: { 'content-type': HTML },
          artifacts: [],
          partial: false,
          source: 'runtime',
        },
      });
      answers.set('/', {
        ...complete,
        onHead: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=head-resumed;mw=hit' },
      });

      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'asked for with HEAD, handed on for a resume, though this HEAD read only complete generations',
        },
      ]);
    });

    it('rejects a whole HEAD whose selected captured generation still needs a resume', async () => {
      const routes = [await routeOf('/', FRONT)];
      const entry = await entryOf('/', '/');
      const resumed = documentAnswer(FRONT, 'mw=hit;route=/');
      // The live endpoint would hide the bad HEAD by calling this generation complete.
      generationHeaders.set(`dpl_site|${entry}|3`, { 'content-type': HTML });
      capturedHeadRecords.set('/', {
        [`${kvGenerationKey('dpl_site', entry)}|3`]: {
          headers: { 'content-type': HTML },
          artifacts: [],
          partial: true,
          source: 'runtime',
        },
      });
      answers.set('/', {
        ...resumed,
        onHead: {
          'content-type': HTML,
          'x-arkor-edge': `${finishedAccount('/')};cache=HIT;seq=3`,
        },
      });

      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: 'asked for with HEAD, answered whole from a generation this HEAD read as partial',
        },
      ]);
    });

    it.each(['absent', 'other entry', 'other sequence'] as const)(
      'rejects a whole HEAD with only %s generation evidence',
      async (evidence) => {
        const routes = [await routeOf('/', FRONT)];
        const entry = evidence === 'other entry' ? 'ent_other' : await entryOf('/', '/');
        const seq = evidence === 'other sequence' ? 4 : 3;
        const captured =
          evidence === 'absent'
            ? {}
            : {
                [`${kvGenerationKey('dpl_site', entry)}|${seq}`]: {
                  headers: { 'content-type': HTML },
                  artifacts: [],
                  partial: false,
                  source: 'runtime' as const,
                },
              };
        capturedHeadRecords.set('/', captured);
        answers.set('/', {
          ...documentAnswer(FRONT, 'mw=hit;route=/'),
          onHead: {
            'content-type': HTML,
            'x-arkor-edge': `${finishedAccount('/')};cache=HIT;seq=3`,
          },
        });

        const result = await checkStack(stackOf(routes, {}));

        expect(result.failures).toStrictEqual([
          {
            path: '/',
            reason: 'asked for with HEAD, answered whole from a generation this HEAD did not read',
          },
        ]);
      },
    );

    it.each(['expired', 'unbounded'] as const)(
      'accepts an expired HEAD with its own %s record without guessing local condemnation',
      async (lifetime) => {
        const finished = `${FRONT}${REST}`;
        const routes = [await routeOf('/', finished, { complete: true })];
        const entry = await entryOf('/', '/');
        const complete = finishedAnswer(finished, '/');
        capturedHeadRecords.set('/', {
          [`${kvGenerationKey('dpl_site', entry)}|3`]: {
            headers: { 'content-type': HTML },
            artifacts: [],
            partial: false,
            source: 'runtime',
            freshness: {
              cacheTimestamp: 0,
              policy: {
                revalidateAfter:
                  lifetime === 'expired' ? { kind: 'finite', seconds: 1 } : { kind: 'unbounded' },
                expireAfter:
                  lifetime === 'expired' ? { kind: 'finite', seconds: 1 } : { kind: 'unbounded' },
                clientStale: { kind: 'unbounded' },
                source: 'runtime-output',
              },
            },
          },
        });
        answers.set('/', {
          ...complete,
          onHead: {
            'content-type': HTML,
            'x-arkor-edge': 'passthrough;reason=head-expired;mw=hit',
          },
        });

        const result = await checkStack(stackOf(routes, {}));

        expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      },
    );

    it.each(['missing', 'another entry', 'invalid sequence'] as const)(
      'rejects an expired HEAD whose applicable captured record is %s',
      async (evidence) => {
        const finished = `${FRONT}${REST}`;
        const routes = [await routeOf('/', finished, { complete: true })];
        const entry = await entryOf('/', '/');
        const complete = finishedAnswer(finished, '/');
        // A live record exists, but it is not evidence that this HEAD read it.
        generationHeaders.set(`dpl_site|${entry}|2`, { 'content-type': HTML });
        const capturedEntry =
          evidence === 'another entry' ? await entryOf('/other', '/other') : entry;
        const seq = evidence === 'invalid sequence' ? 0 : 3;
        capturedHeadRecords.set(
          '/',
          evidence === 'missing'
            ? {}
            : {
                [`${kvGenerationKey('dpl_site', capturedEntry)}|${String(seq)}`]: {
                  headers: { 'content-type': HTML },
                  artifacts: [],
                  partial: false,
                  source: 'runtime',
                },
              },
        );
        answers.set('/', {
          ...complete,
          onHead: {
            'content-type': HTML,
            'x-arkor-edge': 'passthrough;reason=head-expired;mw=hit',
          },
        });

        const result = await checkStack(stackOf(routes, {}));

        expect(result.failures).toStrictEqual([
          {
            path: '/',
            reason:
              'asked for with HEAD, handed on as expired, though this HEAD read none of its applicable records',
          },
        ]);
      },
    );

    it('still rejects an unrelated HEAD handoff for a complete build page', async () => {
      const finished = `${FRONT}${REST}`;
      const routes = [await routeOf('/', finished, { complete: true })];
      const complete = finishedAnswer(finished, '/');
      answers.set('/', {
        ...complete,
        onHead: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=head' },
      });

      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'asked for with HEAD, not answered from the shell of its own route (x-arkor-edge: passthrough;reason=head)',
        },
      ]);
    });

    it('still rejects an expired HEAD handed on without its covering middleware', async () => {
      const finished = `${FRONT}${REST}`;
      const routes = [await routeOf('/', finished, { complete: true })];
      const entry = await entryOf('/', '/');
      const complete = finishedAnswer(finished, '/');
      capturedHeadRecords.set('/', {
        [`${kvGenerationKey('dpl_site', entry)}|3`]: {
          headers: { 'content-type': HTML },
          artifacts: [],
          partial: false,
          source: 'runtime',
        },
      });
      answers.set('/', {
        ...complete,
        onHead: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=head-expired' },
      });
      unkeptOnHead.add('/');

      const result = await checkStack(
        withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "asked for with HEAD, the application's middleware covers it, and the edge handed it on without running the middleware",
        },
      ]);
    });

    it('fails where it is regenerated where the middleware ran, and the stack kept nothing of it', async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      unkept.add('/');
      answers.set('/', {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge':
            'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site;mw=hit',
        },
        body: `${FRONT}${REST}`,
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "the edge says the application's middleware ran on it, and the stack kept nothing of what it decided",
        },
      ]);
    });

    it('stamps each shell the site mints nonces for once, to size what is read of its documents', async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/again', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/again', documentAnswer(FRONT, 'mw=miss;route=/again'));
      const enforce = { mode: 'enforce', strictDynamic: false } as const;
      const result = await checkStack(stackOf(routes, {}, { cspNonce: enforce }));

      expect(result).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(state.stamped).toBe(1);
    });

    it('is answered as itself to a request for its headers alone, where the build finished it', async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const routes = [await routeOf('/', finished, { complete: true })];
      const whole = {
        headers: {
          ...documentAnswer(finished, 'mw=miss;route=/').headers,
          'x-arkor-edge':
            'shell;strategy=edge;src=kv;m=0000;policy=default;cont=none;mw=miss;route=/',
        },
        body: finished,
      };
      answers.set('/', whole);
      const asItself = await checkStack(stackOf(routes, {}));
      answers.set('/', { ...whole, onHead: { ...whole.headers, 'content-type': TEXT } });
      const typed = await checkStack(stackOf(routes, {}));

      expect(asItself).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(typed.failures).toStrictEqual([
        {
          path: '/',
          reason: `asked for with HEAD, answered as ${TEXT}, not text/html; charset=utf-8`,
        },
      ]);
    });

    it("is the runtime's render, not the build's shell, where a generation since the build's served it", async () => {
      const routes = [await routeOf('/', FRONT)];
      await readGenerations('/', [1, 2]);
      const rendered = '<!doctype html><html><head><title>Front, again</title></head><body>';
      answers.set('/', documentAnswer(rendered, 'mw=miss;route=/;cache=fresh;seq=2'));
      const since = await checkStack(stackOf(routes, {}));
      answers.set('/', documentAnswer(rendered, 'mw=miss;route=/;cache=fresh;seq=1'));
      const build = await checkStack(stackOf(routes, {}));

      expect(since).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(build.failures).toStrictEqual([
        { path: '/', reason: 'does not begin with the shell the build wrote for it' },
      ]);
    });

    it('is an HTML document where the edge regenerated it in the foreground', async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      answers.set('/', {
        headers: {
          'content-type': TEXT,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${FRONT}${REST}`,
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        { path: '/', reason: `answered as ${TEXT}, not an HTML document` },
      ]);
    });

    it('is the not-found page a refresh found the page deleted with, where the edge regenerated it in the foreground', async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      const rendered = (status: number): Answer => {
        return {
          status,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'private, no-cache',
            'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
          },
          body: `${FRONT}<h1>Not found</h1>${REST}`,
        };
      };
      answers.set('/', rendered(404));
      const deleted = await checkStack(stackOf(routes, {}));
      answers.set('/', rendered(500));
      const broken = await checkStack(stackOf(routes, {}));

      expect(deleted.failures).toStrictEqual([]);
      expect(broken.failures).toStrictEqual([{ path: '/', reason: 'answered 500' }]);
    });

    it("is the application's where the edge hands it on for a record a render answered other than 200", async () => {
      const routes = [await routeOf('/', FRONT)];
      await readGenerations('/', [1, 2]);
      const at = `dpl_site|${await entryOf('/', '/')}|2`;
      answers.set('/', {
        status: 404,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=generation-status-404',
        },
        body: `${FRONT}<h1>Not found</h1>${REST}`,
      });
      // The refresh found the page deleted, and the runtime recorded it so (greptile).
      generationStatuses.set(at, 404);
      const deleted = await checkStack(stackOf(routes, {}));
      generationStatuses.set(at, 200);
      const unread = await checkStack(stackOf(routes, {}));

      expect(deleted).toStrictEqual({
        checked: 0,
        failures: [],
        skipped: [
          {
            path: '/',
            reason:
              "the application's: a render since the build answered it 404, which the Function answers",
          },
        ],
      });
      expect(unread.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'handed on for a record of status 404, though this request read no generation of its record with it',
        },
      ]);
    });

    it('fails where the file the middleware rewrote it onto is said to be served under another policy', async () => {
      const routes = [await routeOf('/', FRONT)];
      const files = { '/a.txt': fileOf('kept bytes', TEXT) };
      decisions.set('/', { 'x-middleware-next': '1', 'x-middleware-rewrite': '/a.txt' });
      const onto = (policy: string): Answer => {
        return {
          headers: {
            'content-type': TEXT,
            'cache-control': GATED,
            'x-arkor-edge': `static;src=bucket;project=site;policy=${policy};m=0000;mw=hit`,
          },
          body: 'kept bytes',
        };
      };
      answers.set('/', onto('default'));
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const same = await checkStack(stackOf(routes, files));
      answers.set('/', onto('paas-v4'));
      const other = await checkStack(stackOf(routes, files));

      expect(same.skipped).toContainEqual({
        path: '/',
        reason: "the application's middleware rewrote it onto /a.txt",
      });
      expect(other.failures[0]?.reason).toMatch(
        /^not answered under the delivery policy default /u,
      );
    });

    it('is asked as a navigation from another site, where rules claim every other', async () => {
      const routes = [await routeOf('/', FRONT)];
      // Each request a rule claims handed on, in whatever coding it accepts.
      const servedFrom = (site: string): Answer => {
        return {
          ...documentAnswer(FRONT, 'mw=miss;route=/'),
          claimedWhen: (headers) => headers['sec-fetch-site'] !== site,
        };
      };
      answers.set('/', servedFrom('cross-site'));
      const sourced = (
        has: RouteHas[] | undefined,
        missing: RouteHas[] | undefined,
      ): ReservedRoute => {
        return {
          sourceRegex: '^/$',
          beforeFiles: true,
          ...(has !== undefined && { has }),
          ...(missing !== undefined && { missing }),
        };
      };
      const claiming = (site: string): ReservedRoute =>
        sourced([{ type: 'header', key: 'sec-fetch-site', value: site }], undefined);
      const unsaid = sourced(undefined, [{ type: 'header', key: 'sec-fetch-site' }]);
      const rules = [unsaid, claiming('none'), claiming('same-origin'), claiming('same-site')];
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: rules }));
      const asked = askedHeadersEach.get('/')?.[0];
      // And from a page of the same site under another host, where every other is claimed.
      const sameSite = [unsaid, claiming('none'), claiming('same-origin'), claiming('cross-site')];
      answers.set('/', servedFrom('same-site'));
      askedHeadersEach.clear();
      const sibling = await checkStack(stackOf(routes, {}, { reservedRoutes: sameSite }));
      const siblings = askedHeadersEach.get('/')?.[0];

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(asked?.['sec-fetch-site']).toBe('cross-site');
      // Saying which page it came from, by its origin alone, as a browser says it of another's.
      expect(asked?.referer).toBe('https://elsewhere.example/');
      expect(sibling).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(siblings?.['sec-fetch-site']).toBe('same-site');
      expect(siblings?.referer).toBe('https://127.0.0.1:8443/');
      // Made by the visitor, as a navigation from a link is.
      expect(siblings?.['sec-fetch-user']).toBe('?1');
    });

    it('is asked as a navigation a page makes of itself, where rules claim one a visitor made and one from nowhere', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        claimedWhen: (headers) =>
          headers['sec-fetch-site'] === undefined || headers['sec-fetch-user'] === '?1',
      });
      const unsited: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-site' }],
      };
      const made: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'sec-fetch-user', value: String.raw`\?1` }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [unsited, made] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(askedHeadersEach.get('/')?.[0]?.['sec-fetch-site']).toBeDefined();
      expect(askedHeadersEach.get('/')?.[0]).not.toHaveProperty('sec-fetch-user');
    });

    it("is asked as no navigation from nowhere a visitor did not make, which no browser's page makes", async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const rules = [
        frontRule({ missing: [{ type: 'header', key: 'sec-fetch-site' }] }),
        frontRule({ has: [{ type: 'header', key: 'sec-fetch-user' }] }),
        frontRule({
          has: [
            { type: 'header', key: 'sec-fetch-site', value: '(same-origin|same-site|cross-site)' },
          ],
        }),
      ];
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: rules }));

      // Every navigation a browser makes is claimed: none proves the shell.
      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'a rule of next.config that asks of the user agent, its client hints, its language, its accept or upgrade-insecure-requests header, its origin, its referrer, its fetch metadata or a prefetch hint claims every browser the check asks as, but not every agent: no browser proves the shell',
        },
      ]);
    });

    it('is asked as a navigation a visitor makes, where rules claim one no visitor made', async () => {
      const routes = [await routeOf('/', FRONT)];
      // Handed on where the rule claims it: a navigation no visitor made.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        claimedWhen: (headers) => headers['sec-fetch-user'] === undefined,
      });
      const unmade: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'sec-fetch-user' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [unmade] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // The navigation the page is asked as, which the check asks first.
      expect(askedHeadersEach.get('/')?.[0]?.['sec-fetch-user']).toBe('?1');
    });

    it('is asked as a browser says which page a request came from, where rules claim one that says none', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        claimedWhen: (headers) => headers.referer === undefined || headers.referer.includes('1'),
      });
      const unreferred: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'referer' }],
      };
      // And one that claims what a check would make up to pass the first over.
      const madeUp: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'referer', value: '1' }],
      };
      // Under a name no made-up value is part of, as a rule's value matches part of one too.
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [unreferred, madeUp] }),
        { hostname: 'site.example' },
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(askedHeadersEach.get('/')?.[0]?.referer).toBe('https://site.example/');
      expect(askedHeadersEach.get('/')?.[0]?.['sec-fetch-site']).toBe('same-origin');
    });

    it('carries what the middleware set in the headers the edge adds to, first', async () => {
      const routes = [await routeOf('/', FRONT)];
      decisions.set('/', {
        'x-middleware-next': '1',
        vary: 'x-variant',
        'server-timing': 'app;dur=5',
        link: '</a.css>; rel=preload; as=style',
      });
      const composed = documentAnswer(FRONT, 'mw=hit;route=/');
      const kept = {
        vary: 'x-variant, accept-encoding',
        'server-timing': 'app;dur=5, edge;dur=1',
        link: '</a.css>; rel=preload; as=style, </b.js>; rel=preload; as=script',
      };
      answers.set('/', { ...composed, headers: { ...composed.headers, ...kept } });
      const whole = await checkStack(stackOf(routes, {}));
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, ...kept, vary: 'accept-encoding' },
      });
      const unvaried = await checkStack(stackOf(routes, {}));
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, ...kept, 'server-timing': 'edge;dur=1' },
      });
      const untimed = await checkStack(stackOf(routes, {}));

      expect(whole).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unvaried.failures).toStrictEqual([
        {
          path: '/',
          reason: 'answered with vary accept-encoding, without the x-variant the application set',
        },
      ]);
      expect(untimed.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'answered with server-timing edge;dur=1, not beginning with the app;dur=5 the application set',
        },
      ]);
    });

    it('holds a page regenerated in the foreground to its policy and to what the application set', async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      cookieSet('/');
      const framing: HeaderRule = { sourceRegex: '^/$', headers: { 'X-Frame-Options': 'DENY' } };
      const regenerated = (policy: string, set: OutgoingHttpHeaders): Answer => {
        return {
          headers: {
            'content-type': HTML,
            'cache-control': 'private, no-cache',
            'x-arkor-edge': `passthrough;reason=regenerate;m=0000;policy=${policy};scope=dpl_site`,
            ...set,
          },
          body: `${FRONT}${REST}`,
        };
      };
      const stack = stackOf(routes, {}, { headerRules: [framing] });
      // The render's own copy of the middleware's cookie beside the one the edge laid over it.
      const set = { 'x-frame-options': 'DENY', 'set-cookie': ['seen=1; Path=/', 'seen=1; Path=/'] };
      answers.set('/', regenerated('default', set));
      const whole = await checkStack(stack);
      answers.set('/', regenerated('paas-v4', set));
      const otherPolicy = await checkStack(stack);
      answers.set('/', regenerated('default', { 'set-cookie': ['seen=1; Path=/'] }));
      const unruled = await checkStack(stack);
      answers.set('/', regenerated('default', { 'x-frame-options': 'DENY' }));
      const uncookied = await checkStack(stack);

      expect(whole).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(otherPolicy.failures[0]?.reason).toMatch(
        /^not answered under the delivery policy default /u,
      );
      expect(unruled.failures).toStrictEqual([
        {
          path: '/',
          reason: 'answered with x-frame-options none, not the DENY the application set',
        },
      ]);
      expect(uncookied.failures).toStrictEqual([
        { path: '/', reason: 'answered without the cookie seen=1; Path=/ the application set' },
      ]);
    });

    it('holds a page to the policy a rule sets as it is laid: permitting the recovery script where the edge composed it', async () => {
      const policy = "script-src 'self'";
      // What a deploy lays of the rule on a document the edge composes (`documentHeaders`).
      const laid = permitted(policy);
      const rule: HeaderRule = {
        sourceRegex: '^/$',
        headers: { 'Content-Security-Policy': policy },
      };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      const composedUnder = (set: string): Answer => {
        const headers = { ...composed.headers, 'content-security-policy': set };
        return { ...composed, headers };
      };
      const regeneratedUnder = (set: string): Answer => {
        return {
          headers: {
            'content-type': HTML,
            'cache-control': 'private, no-cache',
            'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
            'content-security-policy': set,
          },
          body: `${FRONT}${REST}`,
        };
      };
      const shellStack = stackOf([await routeOf('/', FRONT)], {}, { headerRules: [rule] });
      answers.set('/', composedUnder(laid));
      const composedPermitted = await checkStack(shellStack);
      answers.set('/', composedUnder(policy));
      const composedAsSet = await checkStack(shellStack);
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      const regeneratedStack = stackOf(
        [await routeOf('/', FRONT, { complete: true })],
        {},
        {
          headerRules: [rule],
        },
      );
      answers.set('/', regeneratedUnder(policy));
      const regeneratedAsSet = await checkStack(regeneratedStack);
      answers.set('/', regeneratedUnder(laid));
      const regeneratedPermitted = await checkStack(regeneratedStack);

      expect(composedPermitted).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(composedAsSet.failures).toStrictEqual([
        {
          path: '/',
          reason: `answered with content-security-policy ${policy}, not the ${laid} the application set`,
        },
      ]);
      expect(regeneratedAsSet).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(regeneratedPermitted.failures).toStrictEqual([
        {
          path: '/',
          reason: `answered with content-security-policy ${laid}, not the ${policy} the application set`,
        },
      ]);
    });

    it.each(['query', 'cookie', 'header'] as const)(
      'checks document headers selected only by a preexisting %s value',
      async (type) => {
        const condition = { type, key: 'variant', value: 'dark' };
        const rule: HeaderRule = {
          sourceRegex: '^/$',
          has: [condition],
          headers: { 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "script-src 'self'" },
        };
        const stack = stackOf([await routeOf('/', FRONT)], {}, { headerRules: [rule] });
        const selected = new Set<boolean>();
        const test = (
          headers: IncomingMessage['headers'],
          _method: string | undefined,
          url: URL,
        ) => {
          let matches = headers['variant'] === 'dark';
          if (type === 'query') {
            matches = url.searchParams.get('variant') === 'dark';
          } else if (type === 'cookie') {
            matches = headers.cookie?.includes('variant=dark') === true;
          }
          selected.add(matches);
          return matches;
        };
        const answer = documentAnswer(FRONT, 'mw=miss;route=/');
        answers.set('/', {
          ...answer,
          when: {
            test,
            headers: {
              'x-robots-tag': 'noindex',
              'content-security-policy': permitted("script-src 'self'"),
            },
          },
        });

        const correct = await checkStack(stack);
        answers.set('/', { ...answer, when: { test } });
        const broken = await checkStack(stack);

        expect(correct).toStrictEqual({ checked: 1, failures: [], skipped: [] });
        expect(broken.failures).toHaveLength(1);
        expect(broken.failures[0]?.reason).toContain('the header rule');
        expect(broken.failures[0]?.reason).toContain('the application set');
        expect(selected.has(true)).toBe(true);
        expect(traceIds.letGo).toStrictEqual(traceIds.registered);
      },
    );

    it.each(['query', 'header'] as const)(
      'follows cookies set only by a document selected with a %s rule',
      async (type) => {
        const rule: HeaderRule = {
          sourceRegex: '^/$',
          has: [{ type, key: 'variant', value: 'dark' }],
          missing: [{ type: 'header', key: 'rsc' }],
          headers: { 'X-Robots-Tag': 'noindex' },
        };
        const stack = withMiddleware(
          stackOf(
            [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })],
            {},
            { headerRules: [rule] },
          ),
          [
            { sourceRegex: rule.sourceRegex, has: rule.has ?? [], missing: rule.missing ?? [] },
            { sourceRegex: '^/middleware-probe$', source: '/middleware-probe' },
          ],
        );
        const setCookie = 'seen=dark; Path=/';
        decisions.set('/', { 'x-middleware-next': '1', 'set-cookie': setCookie });
        decisions.set('/middleware-probe', { 'x-middleware-next': '1' });
        const composed = documentAnswer(FRONT, 'mw=miss;route=/');
        const throughMiddleware = documentAnswer(FRONT, 'mw=hit;route=/');
        answers.set('/', {
          ...composed,
          when: {
            test: (headers, _method, url) => {
              return (
                (type === 'query' ? url.searchParams.get('variant') : headers['variant']) === 'dark'
              );
            },
            headers: {
              ...throughMiddleware.headers,
              'x-robots-tag': 'noindex',
              'set-cookie': setCookie,
            },
          },
        });
        const tree = segmentAnswer('tree bytes');
        const privateTree = { ...tree, headers: { ...tree.headers, 'cache-control': GATED } };
        partAnswers.set('/|/_tree', privateTree);
        const correct = await checkStack(stack);
        const witnessedCookies = new Set<string>();
        partAnswers.set('/|/_tree', {
          ...privateTree,
          when: {
            test: (headers) => {
              const sentCookie = headers.cookie ?? '';
              witnessedCookies.add(sentCookie);
              return sentCookie.includes('seen=dark');
            },
            status: 500,
          },
        });
        const broken = await checkStack(stack);

        expect(correct).toStrictEqual({ checked: 2, failures: [], skipped: [] });
        expect(broken.failures).toHaveLength(1);
        expect(broken.failures[0]?.reason).toContain('the header rule');
        expect(broken.failures[0]?.reason).toContain('500');
        expect(witnessedCookies.has('seen=dark')).toBe(true);
        expect(traceIds.letGo).toStrictEqual(traceIds.registered);
      },
    );

    it('does not prove an overlapping rule from a request that selects its overriding rule too', async () => {
      const broad: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'x-mode', value: 'foo|bar' }],
        missing: [{ type: 'header', key: 'rsc' }],
        headers: { 'X-Robots-Tag': 'index' },
      };
      const narrow: HeaderRule = {
        ...broad,
        has: [{ type: 'header', key: 'x-mode', value: 'foo' }],
        headers: { 'X-Robots-Tag': 'noindex' },
      };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      // This drops the broad rule's bar branch while preserving its foo override.
      answers.set('/', {
        ...composed,
        when: {
          test: (headers) => headers['x-mode']?.includes('foo') === true,
          headers: { 'x-robots-tag': 'noindex' },
        },
      });

      const result = await checkStack(
        stackOf([await routeOf('/', FRONT)], {}, { headerRules: [broad, narrow] }),
      );

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain('distinct conditioned header rules');
      expect(result.failures[0]?.reason).toContain('no request proves them');
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('keeps identical header selectors in different casing as the same rule branch', async () => {
      const first: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'x-mode', value: 'foo' }],
        headers: { 'X-Robots-Tag': 'index' },
      };
      const last: HeaderRule = {
        ...first,
        has: [{ type: 'header', key: 'X-Mode', value: 'foo' }],
        headers: { 'X-Robots-Tag': 'noindex' },
      };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...composed,
        when: {
          test: (headers) => headers['x-mode'] === 'foo',
          headers: { 'x-robots-tag': 'noindex' },
        },
      });

      const result = await checkStack(
        stackOf([await routeOf('/', FRONT)], {}, { headerRules: [first, last] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('keeps a condition and its missing complement as disjoint document branches', async () => {
      const present: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'x-mode', value: 'foo' }],
        headers: { 'X-Robots-Tag': 'noindex' },
      };
      const absent: HeaderRule = {
        sourceRegex: '^/$',
        missing: [{ type: 'header', key: 'x-mode', value: 'foo' }],
        headers: { 'X-Robots-Tag': 'index' },
      };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'x-robots-tag': 'index' },
        when: {
          test: (headers) => headers['x-mode'] === 'foo',
          headers: { 'x-robots-tag': 'noindex' },
        },
      });

      const result = await checkStack(
        stackOf([await routeOf('/', FRONT)], {}, { headerRules: [present, absent] }),
      );

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(traceIds.letGo).toStrictEqual(traceIds.registered);
    });

    it('holds a page the edge composed whole to the policy a rule sets as the application set it', async () => {
      const policy = "script-src 'self'";
      const laid = permitted(policy);
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const rule: HeaderRule = {
        sourceRegex: '^/$',
        headers: { 'Content-Security-Policy': policy },
      };
      const wholeUnder = (set: string): Answer => {
        const whole = documentAnswer(finished, 'mw=miss;route=/');
        const account =
          'shell;strategy=edge;src=kv;m=0000;policy=default;cont=none;mw=miss;route=/';
        return {
          headers: { ...whole.headers, 'x-arkor-edge': account, 'content-security-policy': set },
          body: finished,
        };
      };
      const routes = [await routeOf('/', finished, { complete: true })];
      const stack = stackOf(routes, {}, { headerRules: [rule] });
      answers.set('/', wholeUnder(policy));
      const asSet = await checkStack(stack);
      answers.set('/', wholeUnder(laid));
      const widened = await checkStack(stack);

      expect(asSet).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(widened.failures).toStrictEqual([
        {
          path: '/',
          reason: `answered with content-security-policy ${laid}, not the ${policy} the application set`,
        },
      ]);
    });

    it('holds a generation the edge served whole to the policy a folded rule sets as the application set it', async () => {
      const policy = "script-src 'self'";
      const laid = permitted(policy);
      const rendered = '<!doctype html><html><head><title>Front, again</title></head><body>';
      const rule: HeaderRule = {
        sourceRegex: '^/en$',
        headers: { 'Content-Security-Policy': policy },
      };
      const servedUnder = (continuation: string, set: string): Answer => {
        const served = documentAnswer(rendered, 'mw=miss;route=/en;cache=fresh;seq=2');
        const account = `shell;strategy=edge;src=kv;m=0000;policy=default;cont=${continuation};mw=miss;route=/en;cache=fresh;seq=2`;
        return {
          headers: { ...served.headers, 'x-arkor-edge': account, 'content-security-policy': set },
          body: served.body,
        };
      };
      const routes = [await routeOf('/en', FRONT)];
      await readGenerations('/en', [1, 2]);

      const headKey = `${kvGenerationKey('dpl_site', await entryOf('/en', '/en'))}|2`;
      const headRecord: RecordedGeneration = {
        headers: { 'content-type': HTML },
        artifacts: [],
        partial: false,
        source: 'runtime',
      };
      // The whole HEAD reads this complete generation; the later resumed HEAD reads it partial.
      capturedHeadRecords.set('/en', { [headKey]: headRecord });
      // A build the edge does not route publishes its unconditional rules apart (`foldedHeaderRules`).
      const i18n = { defaultLocale: 'en', locales: ['en'] };
      const stack = stackOf(routes, {}, { headerRules: [rule], i18n });
      answers.set('/en', servedUnder('none', policy));
      const wholeAsSet = await checkStack(stack);
      answers.set('/en', servedUnder('none', laid));
      const wholeWidened = await checkStack(stack);
      capturedHeadRecords.set('/en', { [headKey]: { ...headRecord, partial: true } });
      answers.set('/en', servedUnder('resume', laid));
      const resumedPermitted = await checkStack(stack);

      expect(stack.manifest.foldedHeaderRules).toStrictEqual([
        {
          sourceRegex: '^/en$',
          headers: { 'Content-Security-Policy': policy },
          documentHeaders: { 'Content-Security-Policy': laid },
        },
      ]);
      expect(wholeAsSet).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(wholeWidened.failures).toStrictEqual([
        {
          path: '/en',
          reason: `answered with content-security-policy ${laid}, not the ${policy} the application set`,
        },
      ]);
      expect(resumedPermitted).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("fails where the edge regenerated another route's record in its place, or none", async () => {
      const routes = [
        await routeOf('/', FRONT, { complete: true }),
        await routeOf('/about', ABOUT, { complete: true }),
      ];
      const regenerated: Answer = {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${ABOUT}${REST}`,
      };
      answers.set('/', regenerated);
      answers.set('/about', regenerated);
      const about = await entryOf('/about', '/about');
      regenerations.set('/', { entry: about, route: '/about', member: false });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: `regenerated as the entry ${about}, not its own ${await entryOf('/', '/')}`,
        },
        {
          path: '/about',
          reason: 'said to be regenerated, where the edge had its Function regenerate nothing',
        },
      ]);
    });

    it('fails where the edge had its Function regenerate its entry as another route', async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      answers.set('/', {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${ABOUT}${REST}`,
      });
      // The front page's entry, rendered as `/about`: a whole document of the same status.
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/about', member: false });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: 'regenerated as the route /about, under which / is kept as no such entry',
        },
      ]);
    });

    it("is the regeneration of a member's own entry, where the edge regenerated that", async () => {
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const routes = [await routeOf('/items/[id]', ITEM, { complete: true })];
      const dynamicRoutes: DynamicRoute[] = [
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[id]' },
      ];
      // The member the check asks the class through, as validation asks it.
      const member = validationPathnameFor('/items/[id]') ?? '';
      answers.set(member, {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${ITEM}${REST}`,
      });
      regenerations.set(member, {
        entry: await entryOf(member),
        route: '/items/[id]',
        member: true,
      });
      const own = await checkStack(stackOf(routes, {}, { dynamicRoutes }));
      // Another member of the same class, regenerated in its place.
      const another = await entryOf('/items/another');
      regenerations.set(member, { entry: another, route: '/items/[id]', member: true });
      const swapped = await checkStack(stackOf(routes, {}, { dynamicRoutes }));

      expect(own).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(swapped.failures).toStrictEqual([
        {
          path: member,
          reason: `regenerated as the entry ${another}, not the member ${member}'s ${await entryOf(member)}`,
        },
      ]);
    });

    it('fails where it is said to be regenerated, though it is held with no record', async () => {
      const route = await routeOf('/', FRONT);
      // Held as no deploy with a runtime cache holds a route: under no entry.
      const { cache, ...unrecorded } = route;
      answers.set('/', {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${FRONT}${REST}`,
      });
      const result = await checkStack(
        stackOf([route], {}, { held: { routes: { '/': unrecorded } } }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: `held by the manifest the edge serves by under no entry, though the cache was seeded with the app-page entry ${String(cache?.entryId)} for the page`,
        },
        {
          path: '/',
          reason: 'regenerated in the foreground, though the route has no record to regenerate',
        },
      ]);
    });

    it('is not judged where the backstage fails to say what it kept, which ends the check', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      state.backstageFails = 500;
      const broken = checkStack(stackOf(routes, {}));

      await expect(broken).rejects.toThrow(
        "the stack's backstage answered 500 for what it kept of a traced request",
      );

      // Let go of before the check read it, as a record past the stack's bound is.
      state.backstageFails = 404;

      await expect(checkStack(stackOf(routes, {}))).rejects.toThrow(
        'the stack let go of what it kept of a traced request before the check read it',
      );
    });

    it("is judged by the headers its record's generation was recorded with, where one served it", async () => {
      const routes = [await routeOf('/', FRONT)];
      const rendered = '<!doctype html><html><head><title>Front, again</title></head><body>';
      const answered = documentAnswer(rendered, 'mw=miss;route=/;cache=fresh;seq=2');
      answers.set('/', {
        ...answered,
        headers: { ...answered.headers, 'content-language': 'en' },
      });
      // A manifest that publishes its dynamic routes, whose routes' headers hold no rule of its own.
      const routed = { dynamicRoutes: [] };
      const front = `dpl_site|${await entryOf('/', '/')}|2`;
      generationHeaders.set(front, { 'content-language': 'en' });
      const recorded = await checkStack(stackOf(routes, {}, routed));
      generationHeaders.set(front, { 'content-language': 'fr' });
      const mismatched = await checkStack(stackOf(routes, {}, routed));
      // A later render that set none: what an earlier one set is not what this one went out with.
      generationHeaders.set(front, {});
      answers.set('/', {
        ...answered,
        headers: { ...answered.headers, 'cdn-cache-control': 'max-age=60' },
      });
      const dropped = await checkStack(stackOf(routes, {}, routed));
      generationHeaders.clear();
      const unread = await checkStack(stackOf(routes, {}, routed));

      expect(recorded).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(mismatched.failures).toStrictEqual([
        {
          path: '/',
          reason: 'answered with content-language en, not the fr the application set',
        },
      ]);
      expect(dropped.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "answered with cdn-cache-control, by which a shared cache keeps it, though the answer is one visitor's",
        },
      ]);
      expect(unread.failures).toStrictEqual([
        {
          path: '/',
          reason: "served from generation 2 of its record, which the stack's edge never read",
        },
      ]);
    });

    it('fails where it is said to be in a coding, asked for as it is', async () => {
      const routes = [await routeOf('/', FRONT)];
      const answered = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...answered,
        headers: { ...answered.headers, 'content-encoding': 'gzip' },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: 'answered with Content-Encoding gzip to a request that accepts identity alone',
        },
      ]);
    });

    it('is held to its shell where only its pathname reads like a later generation', async () => {
      const routes = [await routeOf('/docs/a;seq=2', FRONT)];
      await readGenerations('/docs/a;seq=2', [1]);
      const corrupted = '<!doctype html><html><head><title>Not the shell</title></head><body>';
      answers.set(
        '/docs/a;seq=2',
        documentAnswer(corrupted, 'mw=miss;route=/docs/a;seq=2;cache=fresh;seq=1'),
      );
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        { path: '/docs/a;seq=2', reason: 'does not begin with the shell the build wrote for it' },
      ]);
    });

    it('fails where it is said to be served from a record of a route held with none', async () => {
      const route = await routeOf('/', FRONT);
      const { cache, ...unrecorded } = route;
      const rendered = '<!doctype html><html><head><title>Not the shell</title></head><body>';
      answers.set('/', documentAnswer(rendered, 'mw=miss;route=/;cache=fresh;seq=2'));
      const result = await checkStack(
        stackOf([route], {}, { held: { routes: { '/': unrecorded } } }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: `held by the manifest the edge serves by under no entry, though the cache was seeded with the app-page entry ${String(cache?.entryId)} for the page`,
        },
        {
          path: '/',
          reason: 'said to be served from generation 2 of a record, where the route has none',
        },
      ]);
    });

    it('fails where it carries a cookie the application did not set', async () => {
      const routes = [await routeOf('/', FRONT)];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'set-cookie': ['injected=1; Path=/'] },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: 'answered with the cookie injected=1; Path=/, which the application did not set',
        },
      ]);
    });

    it('fails where it does not carry the cookie its middleware set', async () => {
      const routes = [await routeOf('/', FRONT)];
      decisions.set('/', { 'x-middleware-next': '1', 'set-cookie': 'seen=1; Path=/' });
      const composed = documentAnswer(FRONT, 'mw=hit;route=/');
      answers.set('/', composed);
      const dropped = await checkStack(stackOf(routes, {}));
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'set-cookie': ['seen=1; Path=/'] },
      });
      const kept = await checkStack(stackOf(routes, {}));

      expect(dropped.failures).toStrictEqual([
        { path: '/', reason: 'answered without the cookie seen=1; Path=/ the application set' },
      ]);
      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("is held to its middleware's cookie as the edge scopes it to the site's hostname, and to none of the edge's own headers", async () => {
      const routes = [await routeOf('/', FRONT)];
      // For every host of a domain the stack's own hostname is not in, which the edge takes off.
      const set = 'seen=1; Domain=example.com; Path=/';
      decisions.set('/', { 'x-middleware-next': '1', 'set-cookie': set });
      const composed = documentAnswer(FRONT, 'mw=hit;route=/');
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'set-cookie': ['seen=1; Path=/'] },
      });
      const scoped = await checkStack(stackOf(routes, {}));
      answers.set('/', { ...composed, headers: { ...composed.headers, 'set-cookie': [set] } });
      const unscoped = await checkStack(stackOf(routes, {}));
      // Under a hostname of that domain, which keeps it.
      const named = await checkStack(stackOf(routes, {}), { hostname: 'www.example.com' });
      // A header of the edge's own, which it sends none of a middleware's.
      decisions.set('/', { 'x-middleware-next': '1', 'x-arkor-note': 'set' });
      answers.set('/', composed);
      const unmarked = await checkStack(stackOf(routes, {}));

      expect(scoped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unscoped.failures).toStrictEqual([
        { path: '/', reason: 'answered without the cookie seen=1; Path=/ the application set' },
      ]);
      expect(named).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unmarked).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it.each(SHARED_CACHE_CONTROL_HEADERS)(
      'requires middleware %s to be removed from a composed document',
      async (name) => {
        const routes = [await routeOf('/', FRONT)];
        decisions.set('/', { 'x-middleware-next': '1', [name]: 'public, max-age=60' });
        const composed = documentAnswer(FRONT, 'mw=hit;route=/');
        answers.set('/', composed);
        const safe = await checkStack(stackOf(routes, {}));
        answers.set('/', {
          ...composed,
          headers: { ...composed.headers, [name]: 'public, max-age=60' },
        });
        const unsafe = await checkStack(stackOf(routes, {}));

        expect(safe).toStrictEqual({ checked: 1, failures: [], skipped: [] });
        expect(unsafe.failures).toStrictEqual([
          {
            path: '/',
            reason: `answered with ${name}, by which a shared cache keeps it, though the answer is one visitor's`,
          },
        ]);
      },
    );

    it('fails where it does not carry a header its route was recorded with', async () => {
      const routes = [
        await routeOf('/', FRONT, { headers: { 'content-security-policy': "default-src 'self'" } }),
      ];
      // As a deploy records it: permitting the edge's recovery script.
      const recorded = permitted("default-src 'self'");
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', composed);
      const dropped = await checkStack(stackOf(routes, {}));
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'content-security-policy': recorded },
      });
      const kept = await checkStack(stackOf(routes, {}));

      expect(dropped.failures).toStrictEqual([
        {
          path: '/',
          reason: `answered with content-security-policy none, not the ${recorded} the application set`,
        },
      ]);
      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is held to the nonce the edge minted for it: stamped in its shell, put in its policy', async () => {
      const scripted = '<!doctype html><html><head><script>self.a=1</script></head><body>';
      const routes = [
        await routeOf('/', scripted, {
          headers: { 'content-security-policy': "script-src 'self'" },
        }),
      ];
      const enforce = { mode: 'enforce', strictDynamic: false } as const;
      // The route's policy as a deploy records it, with the nonce the edge minted beside it.
      const recorded = permitted("script-src 'self'");
      const nonced = { 'content-security-policy': `${recorded} 'nonce-n0nce'` };
      const stampedShell = stampedWith(scripted, 'n0nce');
      answers.set('/', mintedAnswer(stampedShell, ';csp=nonce', nonced));
      const stamped = await checkStack(stackOf(routes, {}, { cspNonce: enforce }));
      answers.set('/', mintedAnswer(scripted, ';csp=nonce', nonced));
      const unstamped = await checkStack(stackOf(routes, {}, { cspNonce: enforce }));
      answers.set('/', mintedAnswer(scripted, '', { 'content-security-policy': recorded }));
      const unminted = await checkStack(stackOf(routes, {}, { cspNonce: enforce }));
      answers.set('/', mintedAnswer(stampedShell, ';csp=nonce', nonced));
      const unasked = await checkStack(stackOf(routes, {}));

      expect(stamped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unstamped.failures).toStrictEqual([
        { path: '/', reason: 'does not begin with the shell the build wrote for it' },
      ]);
      expect(unminted.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'stamped no nonce, though the site asks for one and its policies have somewhere for it',
        },
      ]);
      expect(unasked.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'stamped a nonce, though the site asks for none or its policies have nowhere for it',
        },
      ]);
    });

    it('is held to the nonce the edge minted for it past its shell, as in it', async () => {
      const scripted = '<!doctype html><html><head><script>self.a=1</script></head><body>';
      const routes = [
        await routeOf('/', scripted, {
          headers: { 'content-security-policy': "script-src 'self'" },
        }),
      ];
      const enforce = { mode: 'enforce', strictDynamic: false } as const;
      const nonced = {
        'content-security-policy': `${permitted("script-src 'self'")} 'nonce-n0nce'`,
      };
      const stampedShell = stampedWith(scripted, 'n0nce');
      const late = '<script>self.b=1</script></body></html>';
      const minted = (rest: string): Answer =>
        mintedAnswer(stampedShell, ';csp=nonce', nonced, rest);
      answers.set('/', minted(stampedWith(late, 'n0nce')));
      const stamped = await checkStack(stackOf(routes, {}, { cspNonce: enforce }));
      answers.set('/', minted(late));
      const unstamped = await checkStack(stackOf(routes, {}, { cspNonce: enforce }));
      answers.set('/', minted(stampedWith(late, 'old')));
      const stale = await checkStack(stackOf(routes, {}, { cspNonce: enforce }));
      const reason =
        'does not name the nonce the edge minted for it on every script, every preload of one and every element that names a nonce, past its shell as in it';

      expect(stamped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unstamped.failures).toStrictEqual([{ path: '/', reason }]);
      expect(stale.failures).toStrictEqual([{ path: '/', reason }]);
    });

    it('is held to the nonce the edge minted for it past its shell in each coding, read undone', async () => {
      const scripted = '<!doctype html><html><head><script>self.a=1</script></head><body>';
      const routes = [
        await routeOf('/', scripted, {
          headers: { 'content-security-policy': "script-src 'self'" },
        }),
      ];
      const enforce = { mode: 'enforce', strictDynamic: false } as const;
      const nonced = {
        'content-security-policy': `${permitted("script-src 'self'")} 'nonce-n0nce'`,
      };
      const stampedShell = stampedWith(scripted, 'n0nce');
      const late = '<script>self.b=1</script></body></html>';
      // As it is, stamped throughout; in a coding, past its shell with another nonce.
      answers.set('/', {
        ...mintedAnswer(stampedShell, ';csp=nonce', nonced, stampedWith(late, 'n0nce')),
        codedBody: `${stampedShell}${stampedWith(late, 'old')}`,
      });
      const result = await checkStack(stackOf(routes, {}, { cspNonce: enforce }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'asked for in br, does not name the nonce the edge minted for it on every script, every preload of one and every element that names a nonce, past its shell as in it',
        },
      ]);
    });

    it('is held to the setting the site minted its nonce by: a report-only copy, strict-dynamic beside it', async () => {
      const scripted = '<!doctype html><html><head><script>self.a=1</script></head><body>';
      const routes = [
        await routeOf('/', scripted, {
          headers: { 'content-security-policy': "script-src 'self'" },
        }),
      ];
      const reported = { mode: 'report-only', strictDynamic: true } as const;
      const recorded = permitted("script-src 'self'");
      const policies = {
        'content-security-policy': recorded,
        'content-security-policy-report-only': `${recorded} 'nonce-n0nce' 'strict-dynamic'`,
      };
      const stampedShell = stampedWith(scripted, 'n0nce');
      answers.set(
        '/',
        mintedAnswer(stampedShell, ';csp=nonce;csp-mode=report-only;csp-strict-dynamic', policies),
      );
      const said = await checkStack(stackOf(routes, {}, { cspNonce: reported }));
      answers.set('/', mintedAnswer(stampedShell, ';csp=nonce;csp-strict-dynamic', policies));
      const unsaid = await checkStack(stackOf(routes, {}, { cspNonce: reported }));

      expect(said).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unsaid.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "does not say the site's nonce goes in a report-only policy (csp-mode=report-only)",
        },
      ]);
    });

    it('fails where the edge says it served it under another delivery policy', async () => {
      const routes = [await routeOf('/', FRONT)];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...composed,
        headers: {
          ...composed.headers,
          'x-arkor-edge':
            'shell;strategy=edge;src=kv;m=0000;policy=paas-v4;cont=resume;mw=miss;route=/',
        },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'not answered under the delivery policy default (x-arkor-edge: shell;strategy=edge;src=kv;m=0000;policy=paas-v4;cont=resume;mw=miss;route=/)',
        },
      ]);
    });

    it('fails where the edge answers it by another way than its shell, however sound its bytes', async () => {
      const routes = [await routeOf('/', FRONT)];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'x-arkor-edge': 'other;src=kv;route=/' },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: 'not answered by the edge from its shell (x-arkor-edge: other;src=kv;route=/)',
        },
      ]);
    });

    it('is served as the type its shell was written as', async () => {
      const routes = [await routeOf('/', FRONT)];
      const answered = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', { ...answered, headers: { ...answered.headers, 'content-type': TEXT } });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        { path: '/', reason: `answered as ${TEXT}, not text/html; charset=utf-8` },
      ]);
    });
  });

  describe("an export's Function, asked for a miss", () => {
    const files = { '/404': { ...fileOf(NOT_FOUND, HTML), status: 404 } };
    const notFoundFile: Answer = {
      status: 404,
      headers: { 'content-type': HTML, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
      body: NOT_FOUND,
    };

    it('answers with the not-found document the build wrote, as the type it was written as', async () => {
      answers.set('/404', notFoundFile);
      answers.set(MISS, { status: 404, headers: { 'content-type': HTML }, body: NOT_FOUND });
      const answered = await checkStack(stackOf([], files, { exported: true, functions: ['app'] }));
      // The same bytes as text: the browser shows the document's source.
      answers.set(MISS, { status: 404, headers: { 'content-type': TEXT }, body: NOT_FOUND });
      const asText = await checkStack(stackOf([], files, { exported: true, functions: ['app'] }));

      expect(answered).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(asText.failures).toStrictEqual([
        {
          path: 'app',
          reason: `answered a miss as ${TEXT}, not as the not-found document's ${HTML}`,
        },
      ]);
    });

    it('answers a range of the not-found document whole, as a file of an error status answers one', async () => {
      const end = Buffer.byteLength(NOT_FOUND) - 1;
      answers.set('/404', {
        ...notFoundFile,
        inPart: {
          status: 206,
          headers: {
            'content-type': HTML,
            'content-range': `bytes 1-${end}/${end + 1}`,
            'x-arkor-edge': FILE_EDGE,
          },
          body: NOT_FOUND.slice(1),
        },
      });
      const ranged = await checkStack(stackOf([], files, { exported: true }));
      answers.set('/404', notFoundFile);
      const whole = await checkStack(stackOf([], files, { exported: true }));

      expect(whole).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(ranged.failures).toStrictEqual([
        { path: '/404', reason: `asked for bytes=1-${end}, answered 206, not 404` },
      ]);
    });

    it('fails with any other answer, however little it fails', async () => {
      answers.set('/404', notFoundFile);
      answers.set(MISS, { status: 404, headers: { 'content-type': HTML }, body: '' });
      const exported = await checkStack(stackOf([], files, { exported: true, functions: ['app'] }));
      const routed = await checkStack(stackOf([], files, { functions: ['app'] }));

      expect(exported.failures).toStrictEqual([
        {
          path: 'app',
          reason: 'answered a miss with other than the not-found document the build wrote',
        },
      ]);
      // A build with routes renders its miss with code, which is held to not failing alone.
      expect(routed.failures).toStrictEqual([]);
    });

    it('is asked for a miss past a rule that claims the first shape of one', async () => {
      answers.set('/404', notFoundFile);
      answers.set(MISS, { status: 404, headers: { 'content-type': HTML }, body: '' });
      const prefixClaimed: ReservedRoute = { sourceRegex: '^/_upwind-local-check/(.*)$' };
      const result = await checkStack(
        stackOf([], files, { exported: true, functions: ['app'], reservedRoutes: [prefixClaimed] }),
      );

      // Asked past the claim, the miss is held to the not-found, which this answer is not.
      expect(result.failures).toStrictEqual([
        {
          path: 'app',
          reason: 'answered a miss with other than the not-found document the build wrote',
        },
      ]);
    });

    it('is asked for a miss as it is sent, where a rule claims a request without what the edge forwards', async () => {
      answers.set('/404', notFoundFile);
      answers.set(MISS, { status: 404, headers: { 'content-type': HTML }, body: '' });
      const result = await checkStack(
        stackOf([], files, {
          exported: true,
          catchAll: true,
          catchAllUnless: [{ type: 'header', key: 'x-forwarded-proto' }],
          functions: ['app'],
        }),
      );

      // The probe carries the header the rule asks for, so the rule passes it over, and the
      // Function answers with the not-found the build wrote — which an empty 404 is not.
      expect(result.failures).toStrictEqual([
        {
          path: 'app',
          reason: 'answered a miss with other than the not-found document the build wrote',
        },
      ]);
    });

    it('is asked all the same where a rule claims every pathname, and held to not failing', async () => {
      answers.set('/404', notFoundFile);
      answers.set(MISS, { headers: { 'content-type': HTML }, body: FRONT + REST });
      const claimed = { exported: true, catchAll: true, functions: ['app'] };
      const loaded = await checkStack(stackOf([], files, claimed));
      answers.set(MISS, { status: 500, headers: { 'content-type': HTML }, body: '' });
      const broken = await checkStack(stackOf([], files, claimed));

      expect(loaded).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(broken.failures).toStrictEqual([{ path: 'app', reason: 'answered 500' }]);
    });
  });

  describe('a Function, asked for a miss', () => {
    it.each(['', 'data: ready\n\n'])(
      'accepts a quiet stream with a %s prefix as soon as its headers arrive',
      async (body) => {
        const closed = Promise.withResolvers<true>();
        answers.set(MISS, {
          headers: { 'content-type': 'text/event-stream' },
          body,
          endless: true,
          opened: (response) => {
            response.once('close', () => {
              closed.resolve(true);
            });
            response.flushHeaders();
          },
        });

        const result = await checkStack(stackOf([], {}, { functions: ['app'] }));

        expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });

        await closed.promise;
      },
    );

    it('is let go of once it has sent as much as is read of it, and keeps the stream open', async () => {
      answers.set(MISS, {
        headers: { 'content-type': TEXT },
        body: 'x'.repeat(1024),
        endless: true,
      });
      const result = await checkStack(stackOf([], {}, { functions: ['app'] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("is asked as the check's own agent, and read for its start alone, however long it streams", async () => {
      answers.set(MISS, {
        headers: { 'content-type': TEXT },
        body: 'x'.repeat(4096),
        endless: true,
      });
      const result = await checkStack(stackOf([], {}, { functions: ['app'] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // As validation asks as its prover: an application that answers browsers otherwise is not.
      expect(agents.get(MISS)).toBe('upwind-local-check/1.0');
    });

    it('fails where the edge did not take it as a probe of a Function', async () => {
      answers.set(MISS, {
        status: 404,
        headers: { 'content-type': HTML, 'x-arkor-edge-validated': '0' },
        body: '',
      });
      const result = await checkStack(stackOf([], {}, { functions: ['app'] }));

      expect(result.failures).toStrictEqual([
        {
          path: 'app',
          reason: 'the edge did not take it as a probe of a Function (no x-arkor-edge-validated)',
        },
      ]);
    });

    it('fails where the edge did not hand it to an app Function', async () => {
      const composed = 'shell;strategy=edge;src=kv;m=0000;policy=default;cont=resume;route=/';
      answers.set(MISS, {
        headers: { 'content-type': HTML, 'x-arkor-edge': composed },
        body: FRONT + REST,
      });
      const result = await checkStack(stackOf([], {}, { functions: ['app'] }));

      expect(result.failures).toStrictEqual([
        {
          path: 'app',
          reason: `the edge did not hand it to an app Function (x-arkor-edge: ${composed})`,
        },
      ]);
    });

    it('fails, for a build split across Functions, where the edge asked another than the one named', async () => {
      answers.set(MISS, { status: 404, headers: { 'content-type': HTML }, body: '' });
      // A pointer that lost the second Function: the edge asks the first in its place.
      probedAs.set('app-2', 'passthrough;reason=function-probe;fn=app');
      const result = await checkStack(stackOf([], {}, { functions: ['app', 'app-2'] }));

      expect(result.failures).toStrictEqual([
        {
          path: 'app-2',
          reason:
            'the edge did not ask app-2 (x-arkor-edge: passthrough;reason=function-probe;fn=app)',
        },
      ]);
    });
  });

  describe('a page answered as another route', () => {
    /** The middleware's decision for `/about`: a rewrite onto the front page. */
    const ontoFront: OutgoingHttpHeaders = { 'x-middleware-rewrite': '/' };

    it("is skipped where the middleware rewrote it onto that route, as that route's", async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/about', ABOUT)];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      answers.set('/about', documentAnswer(FRONT, 'mw=hit;route=/'));
      decisions.set('/about', ontoFront);

      await expect(checkStack(stackOf(routes, {}))).resolves.toStrictEqual({
        checked: 1,
        failures: [],
        skipped: [
          { path: '/about', reason: "the application's middleware rewrote it to /, the route /" },
        ],
      });
    });

    it('has the parts of the route it was rewritten onto asked for at its own URL', async () => {
      const routes = [
        await routeOf('/', FRONT, {
          segments: { '/_tree': 'tree bytes', '/_index': 'index bytes' },
        }),
        await routeOf('/about', ABOUT, { segments: { '/_tree': 'about tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      answers.set('/about', documentAnswer(FRONT, 'mw=hit;route=/'));
      decisions.set('/about', ontoFront);
      // The front page's parts, which the edge answers the page's router's requests with.
      const fronts = [
        ['/_tree', 'tree bytes'],
        ['/_index', 'index bytes'],
      ] as const;
      for (const [segment, bytes] of fronts) {
        partAnswers.set(`/|${segment}`, segmentBehindMiddleware(bytes));
        partAnswers.set(`/about|${segment}`, segmentBehindMiddleware(bytes));
      }
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
      // A segment of the front page's alone, asked for as the router on the page asks for it.
      expect(partsAsked.has('/about|/_index')).toBe(true);
    });

    it("has the parts of the route a browser's own request was rewritten onto asked for as it asks", async () => {
      const routes = [
        await routeOf('/', FRONT, {
          segments: { '/_tree': 'tree bytes', '/_index': 'index bytes' },
        }),
        await routeOf('/about', ABOUT, { segments: { '/_tree': 'about tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      answers.set('/about', documentAnswer(ABOUT, 'mw=hit;route=/about'));
      // Rewritten onto the front page as Chrome asks for it, in what it accepts at once, alone.
      decidedInCoding.set(`/about|${BROWSER_CODINGS}`, ontoFront);
      answers.set(`/about|${BROWSER_CODINGS}`, documentAnswer(FRONT, 'mw=hit;route=/'));
      partAnswers.set('/|/_tree', segmentBehindMiddleware('tree bytes'));
      partAnswers.set('/|/_index', segmentBehindMiddleware('index bytes'));
      partAnswers.set('/about|/_tree', segmentBehindMiddleware('about tree'));
      // Chrome's, rewritten onto the front page's tree; the index, which the page lacks, handed on.
      partAnswers.set(`/about|/_tree|${BROWSER_CODINGS}`, segmentBehindMiddleware('tree bytes'));
      partAnswers.set(
        '/about|/_index',
        handedOnAs('passthrough;reason=segment-prefetch;mw=hit', RSC),
      );
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
      // A segment of the front page's alone, asked for as Chrome's router on the page asks for it.
      expect(partsAsked.has('/about|/_index')).toBe(true);
    });

    // `checkStack` asks for every route and part it can reach, which here can take close to the
    // default five seconds on a busy machine.
    it('has the parts asked for of a route it was rewritten onto whose name holds a semicolon', async () => {
      const routes = [
        await routeOf('/docs/a;b', FRONT, {
          segments: { '/_tree': 'tree bytes', '/_extra': 'extra bytes' },
        }),
        await routeOf('/about', ABOUT, { segments: { '/_tree': 'tree bytes' } }),
      ];
      answers.set('/docs/a;b', documentAnswer(FRONT, 'mw=hit;route=/docs/a;b'));
      answers.set('/about', documentAnswer(FRONT, 'mw=hit;route=/docs/a;b'));
      decisions.set('/about', { 'x-middleware-rewrite': '/docs/a;b' });
      for (const at of ['/docs/a;b', '/about']) {
        partAnswers.set(`${at}|/_tree`, segmentBehindMiddleware('tree bytes'));
        partAnswers.set(`${at}|/_extra`, segmentBehindMiddleware('extra bytes'));
      }
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
      expect(partsAsked.has('/about|/_extra')).toBe(true);
    }, 20_000);

    // `checkStack` asks for every route and part it can reach, which here can take close to the
    // default five seconds on a busy machine.
    it('is judged as the route a rewrite lands on, where another route is named like it served from a generation', async () => {
      const LITERAL = '<!doctype html><html><head><title>Literal</title></head><body>';
      const literal = '/target;cache=fresh;seq=1';
      const routes = [
        await routeOf('/about', ABOUT),
        await routeOf('/target', FRONT),
        await routeOf(literal, LITERAL),
      ];
      await readGenerations('/target', [1]);
      answers.set('/target', documentAnswer(FRONT, 'mw=hit;route=/target;cache=fresh;seq=1'));
      answers.set(literal, documentAnswer(LITERAL, `mw=hit;route=${literal}`));
      // Rewritten onto /target, and served from the first generation of its record.
      answers.set('/about', documentAnswer(FRONT, 'mw=hit;route=/target;cache=fresh;seq=1'));
      decisions.set('/about', { 'x-middleware-rewrite': '/target' });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
      expect(result.skipped).toStrictEqual([
        {
          path: '/about',
          reason: "the application's middleware rewrote it to /target, the route /target",
        },
      ]);
    }, 20_000);

    it('is judged as the route it lands on where that route is regenerated in the foreground', async () => {
      const routes = [
        await routeOf('/', FRONT, { complete: true }),
        await routeOf('/about', ABOUT),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      answers.set('/about', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${FRONT}${REST}`,
      });
      decisions.set('/about', ontoFront);
      regenerations.set('/about', { entry: await entryOf('/', '/'), route: '/', member: false });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.skipped).toStrictEqual([
        {
          path: '/about',
          reason: "the application's middleware rewrote it to /, the route /, regenerated",
        },
      ]);
    });

    it("fails where it is not that route's shell", async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/about', ABOUT)];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      answers.set('/about', documentAnswer(ABOUT, 'mw=hit;route=/'));
      decisions.set('/about', ontoFront);
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'rewritten to /, the route /, and does not begin with the shell the build wrote for it',
        },
      ]);
    });

    it('fails where it is served as another route than the one the rewrite lands on', async () => {
      const CONTACT = '<!doctype html><html><head><title>Contact</title></head><body>';
      const routes = [
        await routeOf('/', FRONT),
        await routeOf('/about', ABOUT),
        await routeOf('/contact', CONTACT),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      answers.set('/contact', documentAnswer(CONTACT, 'mw=hit;route=/contact'));
      answers.set('/about', documentAnswer(CONTACT, 'mw=hit;route=/contact'));
      decisions.set('/about', ontoFront);
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason: 'rewritten to /, which is the route /, and served as the route /contact',
        },
      ]);
    });

    it('fails where the rewrite lands on a route a rule claims, which the Function answers', async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/about', ABOUT)];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      answers.set('/about', documentAnswer(FRONT, 'mw=hit;route=/'));
      // Rewritten onto `/`, with a request header the middleware set, which a rule claims `/` by.
      decisions.set('/about', {
        ...ontoFront,
        'x-middleware-override-headers': 'x-proxied',
        'x-middleware-request-x-proxied': '1',
      });
      const claimsFront: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'x-proxied' }],
      };
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [claimsFront] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason: 'rewritten to /, which is no route of the build, and served as the route /',
        },
      ]);
    });

    it('is skipped where the headers the middleware changed route it to that route, as the edge routes it', async () => {
      const VARIANT = '<!doctype html><html><head><title>Variant</title></head><body>';
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const routes = [await routeOf('/items/[id]', VARIANT), await routeOf('/items/[slug]', ITEM)];
      // Two classes of one pattern, the first for a request with a header the second's lack.
      const dynamicRoutes: DynamicRoute[] = [
        {
          sourceRegex: '^/items/([^/]+?)(?:/)?$',
          has: [{ type: 'header', key: 'x-variant' }],
          route: '/items/[id]',
        },
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[slug]' },
      ];
      // The member the check asks the second class through, as validation asks it.
      const member = validationPathnameFor('/items/[slug]') ?? '';
      answers.set(member, documentAnswer(VARIANT, 'mw=hit;route=/items/[id]'));
      decisions.set(member, {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'x-variant',
        'x-middleware-request-x-variant': '1',
      });
      const result = await checkStack(stackOf(routes, {}, { dynamicRoutes }));

      expect(result.skipped).toContainEqual({
        path: member,
        reason:
          "the application's middleware changed the headers it is routed by, onto the route /items/[id]",
      });
    });

    it('fails where it is served as the route asked for, though the headers the middleware changed route it to another', async () => {
      const VARIANT = '<!doctype html><html><head><title>Variant</title></head><body>';
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const routes = [await routeOf('/items/[id]', VARIANT), await routeOf('/items/[slug]', ITEM)];
      const dynamicRoutes: DynamicRoute[] = [
        {
          sourceRegex: '^/items/([^/]+?)(?:/)?$',
          has: [{ type: 'header', key: 'x-variant' }],
          route: '/items/[id]',
        },
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[slug]' },
      ];
      const member = validationPathnameFor('/items/[slug]') ?? '';
      // The class asked for, composed as though the middleware had changed nothing.
      answers.set(member, documentAnswer(ITEM, 'mw=hit;route=/items/[slug]'));
      decisions.set(member, {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'x-variant',
        'x-middleware-request-x-variant': '1',
      });
      const result = await checkStack(stackOf(routes, {}, { dynamicRoutes }));

      expect(result.failures).toContainEqual({
        path: member,
        reason:
          "served as the route asked for, though routed by the headers the application's middleware changed onto the route /items/[id]",
      });
    });

    it('is skipped where the route the middleware moved it onto is one Next.js renders for it itself', async () => {
      const preview = { type: 'header' as const, key: 'x-preview' };
      const routes = [
        { ...(await routeOf('/', FRONT)), bypassFor: [preview] },
        await routeOf('/about', ABOUT),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      // Handed on once the middleware ran, as the edge judges a bypass.
      const handedOn: Answer = {
        headers: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=bypass-for;mw=hit' },
        body: `${FRONT}${REST}`,
      };
      answers.set('/about', handedOn);
      // Rewritten onto `/`, with the header its bypass holds for.
      decisions.set('/about', {
        ...ontoFront,
        'x-middleware-override-headers': 'x-preview',
        'x-middleware-request-x-preview': '1',
      });
      const moved = await checkStack(stackOf(routes, {}));
      // Left as it came, the page asked for is no bypass's.
      decisions.delete('/about');
      const unmoved = await checkStack(stackOf(routes, {}));

      expect(moved.skipped).toStrictEqual([
        {
          path: '/about',
          reason:
            "the application's middleware left it for Next.js to render as the route / itself (bypassFor)",
        },
      ]);
      expect(unmoved.failures.map((failure) => failure.path)).toStrictEqual(['/about']);
      expect(unmoved.failures[0]?.reason).toMatch(/^not answered by the edge from its shell/u);
    });

    it('fails where the middleware ran but rewrote nothing, which leaves the swap to the edge', async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/about', ABOUT)];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      answers.set('/about', documentAnswer(FRONT, 'mw=hit;route=/'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures.map((failure) => failure.path)).toStrictEqual(['/about']);
      expect(result.failures[0]?.reason).toMatch(
        /^served from another route, where the application's middleware rewrote nothing \(x-arkor-edge: /u,
      );
    });

    it('fails where the middleware did not run', async () => {
      const routes = [await routeOf('/', FRONT), await routeOf('/about', ABOUT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/about', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures.map((failure) => failure.path)).toStrictEqual(['/about']);
      expect(result.failures[0]?.reason).toMatch(/^served from another route \(x-arkor-edge: /u);
    });

    it('fails where the edge says the middleware did not run, and the stack kept what it decided', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      keptUnsaid.add('/');
      decisions.set('/', { 'x-middleware-next': '1', 'set-cookie': 'seen=1; Path=/' });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "the stack kept what the application's middleware decided for it, and the edge says it did not run",
        },
      ]);
    });
  });

  describe('the manifest, held to the build', () => {
    const files = { '/a.txt': fileOf('kept bytes', TEXT) };
    const asText = { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE };

    it("fails where it holds the headers next.config sets otherwise than the build's rules", async () => {
      const named: HeaderRule = {
        sourceRegex: String.raw`^/a\.txt$`,
        headers: { 'x-named': 'yes' },
      };
      answers.set('/a.txt', { headers: { ...asText, 'x-named': 'yes' }, body: 'kept bytes' });
      const held = await checkStack(stackOf([], files, { headerRules: [named] }));
      // The edge, serving by a manifest without the rule, answers without what it sets — which a
      // check that read the rules off that manifest would expect it to.
      answers.set('/a.txt', { headers: asText, body: 'kept bytes' });
      const dropped = await checkStack(
        stackOf([], files, { headerRules: [named], held: { headerRules: undefined } }),
      );
      const rules = JSON.stringify([
        { headers: { 'x-named': 'yes' }, sourceRegex: named.sourceRegex },
      ]);

      expect(held).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(dropped).toStrictEqual({
        checked: 2,
        failures: [
          {
            path: 'headerRules',
            reason: `held by the manifest the edge serves by with headerRules null, not the ${rules} a deploy derives from the build`,
          },
        ],
        skipped: [],
      });
    });

    it('fails where it holds the rules the edge leaves to the Function otherwise than the build', async () => {
      const previewed: ReservedRoute = {
        sourceRegex: String.raw`^/a\.txt$`,
        beforeFiles: true,
        has: [{ type: 'header', key: 'x-preview' }],
      };
      answers.set('/a.txt', { headers: asText, body: 'kept bytes' });
      const held = await checkStack(stackOf([], files, { reservedRoutes: [previewed] }));
      const dropped = await checkStack(
        stackOf([], files, { reservedRoutes: [previewed], held: { reservedRoutes: [] } }),
      );
      const invented = await checkStack(
        stackOf([], files, { held: { reservedRoutes: [previewed] } }),
      );
      const rule = JSON.stringify({
        beforeFiles: true,
        has: [{ key: 'x-preview', type: 'header' }],
        sourceRegex: previewed.sourceRegex,
      });

      expect(held).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(dropped.failures).toStrictEqual([
        {
          path: 'reservedRoutes',
          reason: `held by the manifest the edge serves by without the reservedRoutes entry ${rule} the build has`,
        },
      ]);
      expect(invented.failures).toStrictEqual([
        {
          path: 'reservedRoutes',
          reason: `held by the manifest the edge serves by with the reservedRoutes entry ${rule}, which the build has none of`,
        },
      ]);
    });

    it('is asked for behind each default locale an application with i18n finds it behind', async () => {
      const i18n = { defaultLocale: 'en', locales: ['en', 'fr'] };
      answers.set('/a.txt', { headers: asText, body: 'kept bytes' });
      answers.set('/en/a.txt', { headers: asText, body: 'kept bytes' });
      const found = await checkStack(stackOf([], files, { i18n }));
      // Not found there: handed on, as a Function answers what it finds no file for.
      answers.set('/en/a.txt', {
        status: 404,
        headers: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=miss;m=0000' },
        body: NOT_FOUND,
      });
      const unfound = await checkStack(stackOf([], files, { i18n }));
      const unheld = await checkStack(
        stackOf([], files, { i18n, held: { staticFileLocales: undefined } }),
      );

      expect(found).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(unfound.failures.map((failure) => failure.path)).toStrictEqual(['/en/a.txt']);
      expect(unheld.failures[0]).toStrictEqual({
        path: 'staticFileLocales',
        reason:
          'held by the manifest the edge serves by with staticFileLocales null, not the {"basePath":"","locales":["en"]} a deploy derives from the build',
      });
    });

    /** What the router reads of a path as written is held to the build as well. */
    it('fails where the manifest holds what the router reads as written otherwise than the build', async () => {
      const i18n = { defaultLocale: 'en', locales: ['en', 'fr'] };
      const unheld = await checkStack(
        stackOf([], files, { i18n, held: { spelledPrefix: undefined } }),
      );

      expect(unheld.failures[0]).toStrictEqual({
        path: 'spelledPrefix',
        reason:
          'held by the manifest the edge serves by with spelledPrefix null, not the {"basePath":"","locales":["en","fr"]} a deploy derives from the build',
      });
    });

    it('fails where a route is held under another entry than the cache was seeded with, or another scope', async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const route = await routeOf('/', finished, { complete: true });
      answers.set('/', {
        headers: {
          ...documentAnswer(finished, 'mw=miss;route=/').headers,
          'x-arkor-edge':
            'shell;strategy=edge;src=kv;m=0000;policy=default;cont=none;mw=miss;route=/',
        },
        body: finished,
      });
      const seeded = await entryOf('/', '/');
      const elsewhere = await entryOf('/about', '/about');
      const held = await checkStack(stackOf([route], {}));
      const misfiled = await checkStack(
        stackOf(
          [route],
          {},
          {
            held: {
              routes: {
                '/': {
                  ...route,
                  cache: { entryId: elsewhere, kind: 'app-page', delivery: 'complete' },
                },
              },
            },
          },
        ),
      );
      const mistyped = await checkStack(
        stackOf(
          [route],
          {},
          {
            held: {
              routes: {
                '/': { ...route, cache: { entryId: seeded, kind: 'pages', delivery: 'complete' } },
              },
            },
          },
        ),
      );
      const rescoped = await checkStack(
        stackOf(
          [route],
          {},
          {
            held: { cache: { keySchemaVersion: KEY_SCHEMA_VERSION, scopeId: 'dpl_other' } },
          },
        ),
      );

      expect(held).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(misfiled.failures).toContainEqual({
        path: '/',
        reason: `held by the manifest the edge serves by under the app-page entry ${elsewhere}, not the app-page entry ${seeded} the cache was seeded with`,
      });
      expect(mistyped.failures).toContainEqual({
        path: '/',
        reason: `held by the manifest the edge serves by under the pages entry ${seeded}, not the app-page entry ${seeded} the cache was seeded with`,
      });
      expect(rescoped.failures).toContainEqual({
        path: 'cache',
        reason: `held by the manifest the edge serves by with cache {"keySchemaVersion":${String(KEY_SCHEMA_VERSION)},"scopeId":"dpl_other"}, not the {"keySchemaVersion":${String(KEY_SCHEMA_VERSION)},"scopeId":"dpl_site"} a deploy derives from the build`,
      });
    });

    it('fails where it names no cache scope, or holds the agents served no shell otherwise', async () => {
      answers.set('/a.txt', { headers: asText, body: 'kept bytes' });
      const result = await checkStack(
        stackOf([], files, {
          htmlLimitedBots: 'Chrome',
          held: { cache: undefined, htmlLimitedBots: undefined, crawlersStreamed: true },
        }),
      );

      expect(result.failures.map((failure) => failure.path)).toStrictEqual([
        'htmlLimitedBots',
        'crawlersStreamed',
        'cache',
      ]);
      expect(result.failures[2]?.reason).toBe(
        `held by the manifest the edge serves by with cache null, not the {"keySchemaVersion":${String(KEY_SCHEMA_VERSION)},"scopeId":"dpl_site"} a deploy derives from the build`,
      );
    });

    it("fails where it holds a dynamic route's classes, or the middleware's matchers, otherwise than the build", async () => {
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const routes = [await routeOf('/items/[id]', ITEM)];
      const dynamicRoutes: DynamicRoute[] = [
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[id]' },
      ];
      const member = validationPathnameFor('/items/[id]') ?? '';
      answers.set(member, documentAnswer(ITEM, 'mw=miss;route=/items/[id]'));
      const unclassed = await checkStack(
        stackOf(routes, {}, { dynamicRoutes, held: { dynamicRoutes: [] } }),
      );
      const stack = stackOf(routes, {}, { dynamicRoutes });
      const unmatched = await checkStack({
        ...withMiddleware(stack, [{ sourceRegex: '^/items/(.*)$' }]),
        manifest: { ...withMiddleware(stack, []).manifest, middleware: { matchers: [] } },
      });

      expect(unclassed.failures).toContainEqual({
        path: 'dynamicRoutes',
        reason: `held by the manifest the edge serves by with dynamicRoutes [], not the [{"route":"/items/[id]","sourceRegex":"^/items/([^/]+?)(?:/)?$"}] a deploy derives from the build`,
      });
      expect(unmatched.failures[0]).toStrictEqual({
        path: 'middleware',
        reason:
          'held by the manifest the edge serves by with middleware {"matchers":[]}, not the {"matchers":[{"sourceRegex":"^/items/(.*)$"}]} a deploy derives from the build',
      });
    });

    it("fails where a route is held as another page, or with other hints than the build's shell names", async () => {
      const preloading =
        '<!doctype html><html><head><link rel="preload" href="/a.css" as="style"><title>Front</title></head><body>';
      const route = await routeOf('/', preloading);
      answers.set('/', documentAnswer(preloading, 'mw=miss;route=/'));
      const hints = scanPreloadLinks(Buffer.from(preloading));
      const hinted = await checkStack(
        stackOf([route], {}, { held: { routes: { '/': { ...route, preloads: hints } } } }),
      );
      const unhinted = await checkStack(stackOf([route], {}));
      const elsewhere = await checkStack(
        stackOf(
          [route],
          {},
          {
            held: {
              routes: { '/': { ...route, preloads: hints, prerenderId: 'prerender/other' } },
            },
          },
        ),
      );

      expect(hints.length).toBeGreaterThan(0);
      expect(hinted).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unhinted.failures).toContainEqual({
        path: '/',
        reason: `held by the manifest the edge serves by with the hints [], not the ${JSON.stringify(hints)} a deploy names from the build's shell`,
      });
      expect(elsewhere.failures).toContainEqual({
        path: '/',
        reason:
          'held by the manifest the edge serves by as the page prerender/other, which a resume asks for the state of, not the prerender/ the build prerendered',
      });
    });

    it('fails where it names the Functions of another deployment than the stack runs', async () => {
      answers.set('/a.txt', { headers: asText, body: 'kept bytes' });
      const stack = stackOf([], files);
      const result = await checkStack({
        ...stack,
        app: { ...stack.app, deploymentId: 'dpl_other' },
      });

      expect(result.failures).toContainEqual({
        path: 'app',
        reason:
          'named by the manifest the edge serves by as the Functions of dpl_site, not of the dpl_other the stack runs',
      });
    });

    it('asks the middleware on its own about a request its matchers cover, and fails where it fails', async () => {
      answers.set('/a.txt', {
        // Behind the middleware, which makes it one visitor's.
        headers: { ...asText, 'cache-control': GATED, 'x-arkor-edge': `${FILE_EDGE};mw=hit` },
        body: 'kept bytes',
      });
      const covering = withMiddleware(stackOf([], files), [{ sourceRegex: String.raw`^/a\.txt$` }]);
      const covered = await checkStack(covering);
      const coveredAsked = state.middlewareAsked;
      answers.set('/a.txt', { headers: asText, body: 'kept bytes' });
      // Covering nothing the check asks for, and written as a pattern alone: asked about nothing,
      // as whatever it made of a request it does not cover, it could make of no visitor's.
      const apiOnly = withMiddleware(stackOf([], files), [{ sourceRegex: '^/api/(.*)$' }]);
      state.middlewareAsked = undefined;
      state.middlewareProbe = { kind: 'failed', reason: 'Error: no route under /api' };
      const unmatched = await checkStack(apiOnly);
      const unmatchedAsked = state.middlewareAsked;
      // As the application wrote it: asked about what that spells, which its matchers cover.
      const spelling = withMiddleware(stackOf([], files), [
        { source: '/api/:path*', sourceRegex: '^/api(?:/(.*))?$' },
      ]);
      state.middlewareProbe = undefined;
      const spelled = await checkStack(spelling);
      const spelledAsked = state.middlewareAsked;
      state.middlewareProbe = { kind: 'failed', reason: 'Error: no module named "./chunk.js"' };
      const threw = await checkStack(spelling);
      state.middlewareProbe = { kind: 'responded', status: 500 };
      const erred = await checkStack(spelling);

      expect(covered).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(coveredAsked).toBe('/a.txt');
      expect(unmatched).toStrictEqual({
        checked: 1,
        failures: [],
        skipped: [
          {
            path: 'middleware',
            reason:
              'not asked: its matchers cover none of the pages and files the check asks for, nor a pathname they spell',
          },
        ],
      });
      expect(unmatchedAsked).toBeUndefined();
      expect(spelled).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(spelledAsked).toBe('/api');
      expect(threw.failures).toStrictEqual([
        {
          path: 'middleware',
          reason:
            'asked about /api as the edge asks it, failed: Error: no module named "./chunk.js"',
        },
      ]);
      expect(erred.failures).toStrictEqual([
        { path: 'middleware', reason: 'asked about /api as the edge asks it, answered 500' },
      ]);
    });

    it.each([
      {
        source: '/api/:id.json',
        sourceRegex: String.raw`^/api/[^/]+\.json$`,
        path: '/api/upwind-check.json',
      },
      {
        source: String.raw`/api/:id(\d+).json`,
        sourceRegex: String.raw`^/api/\d+\.json$`,
        path: '/api/1.json',
      },
    ])('probes a parameterized middleware source with its suffix: $source', async (matcher) => {
      const stack = withMiddleware(stackOf([], {}), [matcher]);
      state.middlewareProbe = { kind: 'responded', status: 500 };
      const result = await checkStack(stack);

      expect(state.middlewareAsked).toBe(matcher.path);
      expect(result.failures).toContainEqual({
        path: 'middleware',
        reason: `asked about ${matcher.path} as the edge asks it, answered 500`,
      });
      expect(result.skipped).toStrictEqual([]);
    });

    it.each([
      {
        source: String.raw`/api/:id(\d+)/:slug([a-z]+).json`,
        sourceRegex: String.raw`^/api/\d+/[a-z]+\.json$`,
        compiled: /^\/api\/\d+\/[a-z]+\.json$/u,
      },
      {
        source: String.raw`/api/:slug([a-z]+)/:id(\d+).json`,
        sourceRegex: String.raw`^/api/[a-z]+/\d+\.json$`,
        compiled: /^\/api\/[a-z]+\/\d+\.json$/u,
      },
      {
        source: String.raw`/api/:kind(foo|bar)/:id(\d+).json`,
        sourceRegex: String.raw`^/api/(?:foo|bar)/\d+\.json$`,
        compiled: /^\/api\/(?:foo|bar)\/\d+\.json$/u,
      },
      {
        source: String.raw`/api/:id(\d+)/:kind(foo|bar).json`,
        sourceRegex: String.raw`^/api/\d+/(?:foo|bar)\.json$`,
        compiled: /^\/api\/\d+\/(?:foo|bar)\.json$/u,
      },
    ])('probes distinct witnesses for mixed matcher parameters: $source', async (matcher) => {
      const stack = withMiddleware(stackOf([], {}), [
        { source: matcher.source, sourceRegex: matcher.sourceRegex },
      ]);
      state.middlewareProbe = { kind: 'responded', status: 500 };
      const result = await checkStack(stack);

      expect(state.middlewareAsked).toMatch(matcher.compiled);
      expect(result.failures).toContainEqual({
        path: 'middleware',
        reason: `asked about ${String(state.middlewareAsked)} as the edge asks it, answered 500`,
      });
      expect(result.skipped).toStrictEqual([]);
    });

    it('accepts a healthy suffix-bearing middleware probe', async () => {
      const stack = withMiddleware(stackOf([], {}), [
        { source: '/api/:id.json', sourceRegex: String.raw`^/api/[^/]+\.json$` },
      ]);
      state.middlewareProbe = { kind: 'continue', status: 200 };
      const result = await checkStack(stack);

      expect(state.middlewareAsked).toBe('/api/upwind-check.json');
      expect(result.failures).toStrictEqual([]);
      expect(result.skipped).toStrictEqual([]);
    });

    it('does not send a synthesized middleware probe outside the compiled matcher', async () => {
      const stack = withMiddleware(stackOf([], {}), [
        { source: '/api/:id.json', sourceRegex: String.raw`^/unrelated/[^/]+\.json$` },
      ]);
      state.middlewareProbe = { kind: 'responded', status: 500 };
      const result = await checkStack(stack);

      expect(state.middlewareAsked).toBeUndefined();
      expect(result.failures).toStrictEqual([]);
      expect(result.skipped).toContainEqual({
        path: 'middleware',
        reason:
          'not asked: its matchers cover none of the pages and files the check asks for, nor a pathname they spell',
      });
    });

    it("fails where a route's policy is held without the recovery script a deploy permits on it", async () => {
      const policy = "script-src 'self'";
      const route = await routeOf('/', FRONT, { headers: { 'content-security-policy': policy } });
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'content-security-policy': permitted(policy) },
      });
      const held = await checkStack(stackOf([route], {}));
      // The route as the test wrote it: its policy as the build's shell is answered with, alone.
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'content-security-policy': policy },
      });
      const unpermitted = await checkStack(
        stackOf([route], {}, { held: { routes: { '/': route } } }),
      );

      expect(held).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unpermitted.failures).toStrictEqual([
        {
          path: '/',
          reason: `held by the manifest the edge serves by with content-security-policy ${policy}, not the ${permitted(policy)} the build's shell is answered with`,
        },
      ]);
    });
  });

  describe('a page, asked for in each coding a browser accepts', () => {
    it('is answered in each as the edge composes it, its shell once undone', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // In what a browser accepts at once as the page was asked, and as each browser a page is
      // asked as asks — from each place a visitor's navigation comes from (`EACH_BROWSER_CODINGS`).
      expect(codingsAsked.get('/')).toStrictEqual([
        'identity',
        'br',
        'gzip',
        BROWSER_CODINGS,
        ...EACH_BROWSER_CODINGS,
      ]);
    });

    it('is asked for in each coding, and for its parts, where the application took it as it is', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // The middleware answering it as it is alone: in a coding, and as the router asks, the edge's.
      answers.set('/|identity', {
        headers: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      partAnswers.set('/|/_tree', segmentAnswer('other tree bytes'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered 16 bytes other than the 10 the build wrote',
        },
      ]);
      // In what a browser accepts at once as the page was asked, and as each browser a page is
      // asked as asks — from each place a visitor's navigation comes from (`EACH_BROWSER_CODINGS`).
      expect(codingsAsked.get('/')).toStrictEqual([
        'identity',
        'br',
        'gzip',
        BROWSER_CODINGS,
        ...EACH_BROWSER_CODINGS,
      ]);
    });

    it('is asked for as a visitor navigates to it from another page of its own origin, in what each browser accepts at once', async () => {
      const routes = [await routeOf('/about', FRONT), await routeOf('/shop', FRONT)];
      answers.set('/shop', documentAnswer(FRONT, 'mw=miss;route=/shop'));
      // Composed under another type for a navigation from the shop, which says so (`Referer`).
      answers.set('/about', {
        ...documentAnswer(FRONT, 'mw=miss;route=/about'),
        when: {
          test: (headers) => {
            const site = headers['sec-fetch-site'];
            return site === 'same-origin' && String(headers.referer).endsWith('/shop');
          },
          headers: { 'content-type': 'text/plain' },
        },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br, zstd\) by Chrome, from \/shop, .*text\/plain/u,
      );
    });

    it("is asked for as a page's script navigates to it, in what each browser accepts at once", async () => {
      const routes = [await routeOf('/', FRONT)];
      // Composed under another type for Chrome's navigation a script of the site's own page made.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        when: {
          test: (headers) => {
            return (
              headers['sec-fetch-site'] === 'same-origin' &&
              headers['sec-fetch-user'] === undefined &&
              String(headers['user-agent']).includes('Chrome/') &&
              !String(headers['user-agent']).includes('Android')
            );
          },
          headers: { 'content-type': 'text/plain' },
        },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br, zstd\) by Chrome, from a page of its own origin, by its script, .*text\/plain/u,
      );
    });

    it('is asked for as each browser navigates from each place, in what it accepts at once', async () => {
      const routes = [await routeOf('/', FRONT)];
      // A rule for a navigation from another site's page.
      const elsewhere: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'sec-fetch-site', value: 'cross-site' }],
        headers: { 'x-robots-tag': 'noindex' },
      };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}, { headerRules: [elsewhere] }));

      expect(result.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br, zstd\) by Chrome, from another site's page, .*x-robots-tag/u,
      );
    });

    it('is asked for as each browser a page is asked as, Firefox among them', async () => {
      const routes = [await routeOf('/', FRONT)];
      // A rule for Firefox's own request: one that lays a header the edge replays with a shell.
      const firefox: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'user-agent', value: '.*Firefox.*' }],
        headers: { 'x-robots-tag': 'noindex' },
      };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}, { headerRules: [firefox] }));

      expect(result.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br, zstd\) by Firefox, .*x-robots-tag/u,
      );
    });

    it('is asked for in what a browser accepts at once, held to the rules as the front line hands it on', async () => {
      const routes = [await routeOf('/', FRONT)];
      // A rule for a request that accepts zstd — which no request reaches the edge accepting, as
      // Cloudflare's front line hands each on accepting what it sets in the visitor's place.
      const combined: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'accept-encoding', value: '.*zstd.*' }],
        headers: { 'x-robots-tag': 'noindex' },
      };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}, { headerRules: [combined] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // Asked in each all the same, as the edge answers each in a coding of its own.
      expect(codingsAsked.get('/')?.slice(0, 4)).toStrictEqual([
        'identity',
        'br',
        'gzip',
        BROWSER_CODINGS,
      ]);
    });

    it('is held, regenerated by the Function, to any coding of those a browser accepts', async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      unkept.add('/');
      const regenerated: Answer = {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${FRONT}${REST}`,
      };
      answers.set('/', regenerated);
      // The Function's render in zstd, which the edge hands on as it came.
      answers.set(`/|${BROWSER_CODINGS}`, {
        ...regenerated,
        headers: { ...regenerated.headers, 'content-encoding': 'zstd', vary: 'accept-encoding' },
        compressed: 'zstd',
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is held, regenerated by the Function, to a coding by any name it goes by', async () => {
      const routes = [await routeOf('/', FRONT, { complete: true })];
      regenerations.set('/', { entry: await entryOf('/', '/'), route: '/', member: false });
      unkept.add('/');
      const regenerated: Answer = {
        headers: {
          'content-type': HTML,
          'cache-control': 'private, no-cache',
          'x-arkor-edge': 'passthrough;reason=regenerate;m=0000;policy=default;scope=dpl_site',
        },
        body: `${FRONT}${REST}`,
      };
      answers.set('/', regenerated);
      // In gzip by its other name; and said to be in no coding at all.
      answers.set('/|gzip', {
        ...regenerated,
        headers: { ...regenerated.headers, 'content-encoding': 'x-gzip', vary: 'accept-encoding' },
        compressed: true,
      });
      answers.set('/|br', {
        ...regenerated,
        headers: { ...regenerated.headers, 'content-encoding': 'identity' },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("is the application's where its middleware answers what a browser accepts in zstd", async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set(`/|${BROWSER_CODINGS}`, {
        headers: {
          'content-type': HTML,
          'content-encoding': 'zstd',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: `${FRONT}${REST}`,
        compressed: 'zstd',
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is left to Next.js where its bypassFor holds for what the front line hands every request, unless the middleware leaves it otherwise', async () => {
      const bypassed = {
        ...(await routeOf('/', FRONT)),
        bypassFor: [{ type: 'header' as const, key: 'accept-encoding', value: 'br' }],
      };
      // Handed to the Function in every coding, as the edge hands on a request its bypass holds for:
      // Cloudflare's front line hands every request on accepting brotli.
      const handedOn: Answer = {
        headers: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=bypass-for' },
        body: 'rendered',
      };
      answers.set('/', handedOn);
      const left = await checkStack(stackOf([bypassed], {}));
      // Composed from its shell all the same.
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const served = await checkStack(stackOf([bypassed], {}));
      // The middleware asking for nothing coded of the request it leaves the edge, which leaves the
      // edge the shell to serve — judged so.
      decisions.set('/', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'accept-encoding',
        'x-middleware-request-accept-encoding': 'identity',
      });
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=hit;route=/'),
        codedBody: `${ABOUT}${REST}`,
      });
      const unbypassed = await checkStack(stackOf([bypassed], {}));

      expect(left).toStrictEqual({
        checked: 0,
        failures: [],
        skipped: [
          {
            path: '/',
            reason:
              "its route's bypassFor holds for every request the check could make, which Next.js renders itself",
          },
        ],
      });
      expect(served.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "asked for in br, answered from its shell, though its route's bypassFor holds for the request, which Next.js renders itself",
        },
      ]);
      expect(unbypassed.failures).toStrictEqual([
        {
          path: '/',
          reason: 'asked for in br, does not begin with the shell the build wrote for it',
        },
      ]);
    });

    it("fails where it is handed on for its route's bypassFor, though the middleware covering it ran not", async () => {
      const bypassed = {
        ...(await routeOf('/', FRONT)),
        bypassFor: [{ type: 'header' as const, key: 'accept-encoding', value: 'br' }],
      };
      const stack = withMiddleware(stackOf([bypassed], {}), [{ sourceRegex: '^/$' }]);
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      // Handed on once the middleware ran, as the edge judges a bypass — but in brotli alone, with
      // none run.
      answers.set(`/|${BROWSER_CODINGS}`, handedOnAs('passthrough;reason=bypass-for;mw=hit'));
      answers.set(`/|${SAFARI_CODINGS}`, handedOnAs('passthrough;reason=bypass-for;mw=hit'));
      answers.set('/|br', handedOnAs('passthrough;reason=bypass-for'));
      const result = await checkStack(stack);

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "asked for in br, the application's middleware covers it, and the edge handed it on for Next.js to render without running the middleware",
        },
      ]);
    });

    it('fails where it is handed on for want of a route, though the middleware covering it ran not', async () => {
      const routes = [await routeOf('/', FRONT)];
      const claimsBrotli: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'accept-encoding', value: 'br' }],
      };
      const stack = withMiddleware(stackOf(routes, {}, { reservedRoutes: [claimsBrotli] }), [
        { sourceRegex: '^/$' },
      ]);
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      // Handed on with the middleware run, as the edge runs it ahead of a claim — but in brotli
      // alone, with none run.
      answers.set(`/|${BROWSER_CODINGS}`, {
        headers: {
          'content-type': HTML,
          'x-arkor-edge': 'passthrough;reason=route-not-proved;mw=hit',
        },
        body: 'rendered',
      });
      answers.set('/|br', {
        headers: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=route-not-proved' },
        body: 'rendered',
      });
      const result = await checkStack(stack);

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "asked for in br, the application's middleware covers it, and the edge handed it on without running the middleware",
        },
      ]);
    });

    it('is judged as the middleware leaves a request a rule claims for what the front line hands every one', async () => {
      const routes = [await routeOf('/', FRONT)];
      const claimsBrotli: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'accept-encoding', value: 'br' }],
      };
      const stack = stackOf(routes, {}, { reservedRoutes: [claimsBrotli] });
      // Handed on for want of a route in every coding, as the edge hands on a request a rule claims:
      // Cloudflare's front line hands every request on accepting brotli.
      const unproved: Answer = {
        headers: { 'content-type': HTML, 'x-arkor-edge': 'passthrough;reason=route-not-proved' },
        body: 'rendered',
      };
      answers.set('/', unproved);
      const handedOn = await checkStack(stack);
      // Composed from its shell all the same.
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const served = await checkStack(stack);
      // The middleware asking for nothing coded of the request it leaves the edge, which the rule
      // then claims not — judged so.
      decisions.set('/', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'accept-encoding',
        'x-middleware-request-accept-encoding': 'identity',
      });
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=hit;route=/'),
        codedBody: `${ABOUT}${REST}`,
      });
      const unclaimed = await checkStack(stack);

      expect(handedOn).toStrictEqual({
        checked: 0,
        failures: [],
        skipped: [{ path: '/', reason: 'claimed by a redirect or rewrite of next.config' }],
      });
      expect(served.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'asked for in br, answered from its shell, though a rule of next.config claims the request',
        },
      ]);
      expect(unclaimed.failures).toStrictEqual([
        {
          path: '/',
          reason: 'asked for in br, does not begin with the shell the build wrote for it',
        },
      ]);
    });

    it('fails where it comes back in none to a request that accepts one alone', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', { ...documentAnswer(FRONT, 'mw=miss;route=/'), uncoded: true });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'asked for in br, answered with Content-Encoding none to a request that accepts br alone',
        },
      ]);
    });

    it('fails where it is not its shell once undone, or says it sent another rendering', async () => {
      const routes = [await routeOf('/', FRONT)];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', { ...composed, codedBody: `${ABOUT}${REST}` });
      const other = await checkStack(stackOf(routes, {}));
      answers.set('/', { ...composed, rendering: 'gzip-live' });
      const misstated = await checkStack(stackOf(routes, {}));

      expect(other.failures).toStrictEqual([
        {
          path: '/',
          reason: 'asked for in br, does not begin with the shell the build wrote for it',
        },
      ]);
      expect(misstated.failures[0]?.reason).toMatch(
        /^asked for in br, answered in br, though the edge says it sent gzip-live \(x-arkor-edge: /u,
      );
    });
  });

  describe('a page, as the edge says it coded it', () => {
    it('fails where its account names other layers than it came in', async () => {
      const routes = [await routeOf('/', FRONT, { brShell: true })];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      // Two layers, said to be one, and with nothing to tell another agent's answer from it.
      answers.set('/', {
        ...composed,
        layered: true,
        unvariedByAgent: true,
        layeredRendering: 'br',
      });
      const unsaid = await checkStack(stackOf(routes, {}));
      // One layer, said to be two.
      answers.set('/', { ...composed, rendering: 'br-br' });
      const overstated = await checkStack(stackOf(routes, {}));

      expect(unsaid.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br, zstd\) by Chrome, which the edge layers brotli for, answered in 2 layers of br, though the edge says it sent br \(x-arkor-edge: /u,
      );
      expect(overstated.failures[0]?.reason).toMatch(
        /^asked for in br, answered in br, though the edge says it sent br-br \(x-arkor-edge: /u,
      );
    });

    it('is asked in what the browser it was asked as accepts at once, Safari its own', async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const routes = [await routeOf('/', finished, { complete: true })];
      // The check's own agent and Chrome's navigations claimed, which leaves Safari's.
      const rules: ReservedRoute[] = [
        frontRule({ has: [{ type: 'header', key: 'user-agent', value: 'upwind-local-check.*' }] }),
        frontRule({
          has: [
            { type: 'header', key: 'sec-ch-ua' },
            { type: 'header', key: 'sec-fetch-dest', value: 'document' },
          ],
        }),
      ];
      answers.set('/', {
        ...finishedAnswer(finished, '/'),
        withHeader: {
          name: 'sec-ch-ua',
          headers: { 'x-arkor-edge': 'passthrough;reason=route-not-proved' },
        },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: rules }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // As the page was asked — as Safari — in each coding alone, and in what Safari accepts at once.
      expect(codingsAsked.get('/')?.slice(0, 4)).toStrictEqual([
        'identity',
        'br',
        'gzip',
        SAFARI_CODINGS,
      ]);
    });

    it('is composed in brotli for a request that accepts it among others, as the edge prefers it', async () => {
      const routes = [await routeOf('/', FRONT)];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', composed);
      // In gzip to what a browser accepts at once, which names brotli as well.
      const account = String(composed.headers['x-arkor-edge']).replace(
        ';cont=',
        ';enc=gzip-live;cont=',
      );
      answers.set(`/|${BROWSER_CODINGS}`, {
        ...composed,
        compressed: 'gzip',
        headers: {
          ...composed.headers,
          'content-encoding': 'gzip',
          vary: 'accept-encoding',
          'x-arkor-edge': account,
        },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: `asked for in what a browser accepts (${BROWSER_CODINGS}), answered with Content-Encoding gzip, not the br the edge composes a document in for a request that accepts ${BROWSER_CODINGS}`,
        },
      ]);
    });

    it('is asked as Safari as well, which a rule written for Chrome passes over', async () => {
      const routes = [await routeOf('/', FRONT)];
      // The check's own agent claimed, and every request of Chrome's — which leaves the page to be
      // asked as Safari, and Chrome's own requests to the Function.
      const rules: ReservedRoute[] = [
        frontRule({ has: [{ type: 'header', key: 'user-agent', value: 'upwind-local-check.*' }] }),
        frontRule({ has: [{ type: 'header', key: 'user-agent', value: '.*Chrome.*' }] }),
      ];
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        claimedWhen: (headers) => String(headers['user-agent']).includes('Chrome'),
      });
      // Safari's, in what it accepts at once, served another page's shell.
      answers.set(`/|${SAFARI_CODINGS}`, documentAnswer(ABOUT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: rules }));

      expect(agentsAsked.get('/')?.[0]).toContain('iPhone');
      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: `asked for in what a browser accepts (${SAFARI_CODINGS}), does not begin with the shell the build wrote for it`,
        },
      ]);
    });

    it('is asked as Chrome asks, in what it accepts at once, whatever agent the page was asked as', async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const routes = [await routeOf('/', finished, { complete: true })];
      // A rule for Chrome's own request, by its hints, alone.
      const chrome: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'sec-ch-ua' }],
        headers: { 'x-robots-tag': 'noindex' },
      };
      answers.set('/', finishedAnswer(finished, '/'));
      const result = await checkStack(stackOf(routes, {}, { headerRules: [chrome] }));

      expect(result.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br, zstd\) by Chrome, .*x-robots-tag/u,
      );
    });

    it('fails where a page the build finished comes in two layers, which only a continued one may', async () => {
      const finished = `${FRONT}<main>finished</main></body></html>`;
      const routes = [await routeOf('/', finished, { complete: true, brShell: true })];
      // The check's own agent claimed, which leaves the page to be asked for as Chrome — which
      // undoes two layers, and is sent them only under a document the edge continues.
      const unproved: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'user-agent', value: 'upwind-local-check.*' }],
      };
      answers.set('/', { ...finishedAnswer(finished, '/'), layered: true });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [unproved] }));

      expect(result.failures[0]?.reason).toBe(
        'asked for in br, answered in two layers of br, which the edge sends of brotli alone, under a document it continues',
      );
    });

    it('fails where it comes in two layers to an agent the edge sends one', async () => {
      const routes = [await routeOf('/', FRONT, { brShell: true })];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      // Layered for every agent, said so and varied by the agent all the same.
      answers.set('/', { ...composed, layered: true, layeredForAll: true });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures[0]?.reason).toMatch(
        /^asked for in br, answered in two layers of br to .+, which the edge sends one$/u,
      );
    });
  });

  describe('a page whose shell the deployment holds in brotli, asked for by Chrome', () => {
    it('is asked as Chrome asks, whole, and held to the rules that select that request', async () => {
      const routes = [await routeOf('/', FRONT, { brShell: true })];
      // A rule for Chrome's own request, by its hints, alone.
      const chrome: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'sec-ch-ua' }],
        headers: { 'x-robots-tag': 'noindex' },
      };
      answers.set('/', { ...documentAnswer(FRONT, 'mw=miss;route=/'), layered: true });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [chrome] }));

      expect(result.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br, zstd\) by Chrome, which the edge layers brotli for, .*x-robots-tag/u,
      );
    });
  });

  describe('a page whose shell the deployment holds in brotli, asked for by Safari', () => {
    it('fails where it comes in two layers to Safari, though the page is asked for as Chrome', async () => {
      const routes = [await routeOf('/', FRONT, { brShell: true })];
      // A rule that claims the check's own agent, which leaves the page to be asked for as Chrome.
      const unproved: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'user-agent', value: 'upwind-local-check.*' }],
      };
      // Layered for every agent: Chrome undoes two, Safari does not.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        layered: true,
        layeredForAll: true,
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [unproved] }));

      expect(result.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br\) by Safari, which the edge sends one layer of brotli, answered in two layers of br to Mozilla\/5\.0 \(iPhone;/u,
      );
    });

    it("is asked as Safari asks, none of Chrome's client hints carried over", async () => {
      const routes = [await routeOf('/', FRONT, { brShell: true })];
      // The check's own agent claimed, which leaves the page to be asked for as Chrome, hints and all.
      const unproved: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'user-agent', value: 'upwind-local-check.*' }],
      };
      answers.set('/', { ...documentAnswer(FRONT, 'mw=miss;route=/'), layered: true });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [unproved] }));
      // Safari's own request, of the page's.
      const safari = askedHeadersEach
        .get('/')
        ?.find((headers) => String(headers['user-agent']).includes('iPhone'));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(safari?.['user-agent']).toMatch(/iPhone/u);
      expect(Object.keys(safari ?? {}).filter((name) => name.startsWith('sec-ch-'))).toStrictEqual(
        [],
      );
    });
  });

  describe('a page whose shell the deployment holds in brotli', () => {
    it('is asked for as a browser the edge sends two layers of brotli to, and varied by it', async () => {
      const routes = [await routeOf('/', FRONT, { brShell: true })];
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', { ...composed, layered: true });
      const varied = await checkStack(stackOf(routes, {}));
      answers.set('/', { ...composed, layered: true, unvariedByAgent: true });
      const unvaried = await checkStack(stackOf(routes, {}));

      expect(varied).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unvaried.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'asked for in what a browser accepts (gzip, deflate, br, zstd) by Chrome, which the edge layers brotli for, answered in two layers of br under no Vary naming User-Agent',
        },
      ]);
    });
  });

  describe("a page's parts, asked as the client router asks", () => {
    const finished = `${FRONT}<main>finished</main></body></html>`;

    it('is answered with each prefetch segment the build wrote, asked at the page as the router asks', async () => {
      const segments = { '/_tree': 'tree bytes', '/_full': 'full bytes' };
      const routes = [await routeOf('/', FRONT, { segments })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      partAnswers.set('/|/_full', segmentAnswer('full bytes'));
      const result = await checkStack(stackOf(routes, {}));
      const asked = partsAsked.get('/|/_tree');
      const [chrome, unreferred, safari] = partsAskedEach.get('/|/_tree') ?? [];

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // From the page the router is on, the front page — and from one that sends no referrer — as
      // a browser, Chrome, and Safari, which no Chromium is, naming the deployment it runs.
      expect(chrome?.referer).toBe(new URL('/', `https://${String(chrome?.host)}`).href);
      expect(unreferred?.referer).toBeUndefined();
      expect(chrome?.['user-agent']).toContain('Chrome/');
      expect(safari?.['user-agent']).toContain('iPhone');
      expect(chrome).toMatchObject({
        'sec-ch-ua-mobile': '?0',
        'next-router-prefetch': '1',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'accept-encoding': 'identity',
        'x-deployment-id': 'dpl_site',
        'next-url': '/',
      });
      // Named as the router names it, which tells it apart from the page by its URL as well.
      expect(asked?.search).toMatch(/^\?_rsc=[\w-]+$/u);
      expect(partsAsked.get('/|/_full')?.search).not.toBe(asked?.search);
    });

    it('fails where a segment is answered with other bytes, as the page, or as no part of it', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', segmentAnswer('other tree bytes'));
      const other = await checkStack(stackOf(routes, {}));
      partAnswers.delete('/|/_tree');
      const asPage = await checkStack(stackOf(routes, {}));
      partAnswers.set('/|/_tree', partAnswer('segment', 'tree bytes'));
      const unmarked = await checkStack(stackOf(routes, {}));
      partAnswers.set('/|/_tree', {
        ...segmentAnswer('tree bytes'),
        headers: { ...segmentAnswer('tree bytes').headers, vary: 'rsc, accept-encoding' },
      });
      const unvaried = await checkStack(stackOf(routes, {}));

      expect(other.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered 16 bytes other than the 10 the build wrote',
        },
      ]);
      expect(asPage.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, not answered by the edge as the part it is \(x-arkor-edge: shell;/u,
      );
      expect(unmarked.failures).toStrictEqual([
        {
          path: '/',
          reason: 'its prefetch segment /_tree, answered with x-nextjs-postponed none, not 2',
        },
      ]);
      expect(unvaried.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered under no Vary naming next-router-state-tree',
        },
      ]);
    });

    it("is the application's where the edge hands a part on to the Function", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', {
        headers: {
          'content-type': RSC,
          'x-arkor-edge': 'passthrough;reason=segment-prefetch;m=0000;policy=default',
        },
        body: 'rendered tree',
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is answered with the whole payload of a page the build finished', async () => {
      const routes = [await routeOf('/', finished, { complete: true, payload: 'payload bytes' })];
      answers.set('/', finishedAnswer(finished, '/'));
      partAnswers.set('/|rsc', partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT' }));
      const whole = await checkStack(stackOf(routes, {}));
      partAnswers.set('/|rsc', partAnswer('payload', 'payload bytes'));
      const unmarked = await checkStack(stackOf(routes, {}));

      expect(whole).toStrictEqual({ checked: 1, failures: [], skipped: [] });

      // As a navigation asks for it: from the router state of the page it leaves, named by it.
      const navigated = partsAsked.get('/|rsc');

      expect(navigated?.headers['next-router-prefetch']).toBeUndefined();
      expect(navigated?.headers['next-router-state-tree']).toBe(
        encodeURIComponent('["",{"children":["__PAGE__",{}]}]'),
      );
      expect(navigated?.headers['next-url']).toBe('/');
      expect(navigated?.search).toMatch(/^\?_rsc=[\w-]+$/u);
      expect(unmarked.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, answered with x-nextjs-cache none, not HIT',
        },
      ]);
    });

    it('fails where the payload the build wrote is marked postponed by other than the application', async () => {
      const routes = [await routeOf('/', finished, { complete: true, payload: 'payload bytes' })];
      answers.set('/', finishedAnswer(finished, '/'));
      const postponed = { 'x-nextjs-cache': 'HIT', 'x-nextjs-postponed': '1' };
      partAnswers.set('/|rsc', partAnswer('payload', 'payload bytes', postponed));
      const marked = await checkStack(stackOf(routes, {}));
      // A rule of `next.config` for the router's requests that marks it so itself, which the edge
      // keeps — and which makes it one visitor's.
      const rule: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'rsc', value: '1' }],
        headers: { 'x-nextjs-postponed': '1' },
      };
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { ...postponed, 'cache-control': GATED }),
      );
      const ruled = await checkStack(stackOf(routes, {}, { headerRules: [rule] }));

      expect(marked.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, answered with x-nextjs-postponed 1, which nothing the application set marks the payload the build wrote with',
        },
      ]);
      expect(ruled).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is asked for its whole payload as a refresh of the page asks, naming no page it is on', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, payload: 'payload bytes' }),
      ];
      // A rule ahead of the filesystem that claims every request that names the page it is on.
      const named: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'next-url' }],
      };
      answers.set('/about', finishedAnswer(finished, '/about'));
      // Claimed where it names one, and handed on so; else answered from storage with other bytes.
      partAnswers.set('/about|rsc', {
        ...partAnswer('payload', 'other bytes', { 'x-nextjs-cache': 'HIT' }),
        claimedWhen: (headers) => headers['next-url'] !== undefined,
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [named] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its whole React Server Components payload, as a refresh asks for it (no next-url), from the page itself, answered 11 bytes other than the 13 the build wrote',
        },
      ]);
    });

    it("is asked for a page's props again for their headers alone, as the Pages Router signals a revalidation", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      answers.set('/about', finishedAnswer(about, '/about'));
      const account =
        'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000';
      // The props, answered from storage — and so, asked for their headers alone, which the edge
      // hands the Function.
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'x-arkor-edge': account,
        },
        body: props,
        onHead: { 'content-type': JSON_TYPE, 'x-arkor-edge': account },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason: `its page's props (/_next/data/test/about.json), asked again for its headers alone as the Pages Router signals a revalidation, answered by the edge itself (x-arkor-edge: ${account}), though it hands the Function a request for a page's props' headers alone`,
        },
      ]);
    });

    it("is asked for a page's props for their headers alone with the cookies their answer set", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // A rule that sets a cookie on the props.
      const seen: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        headers: { 'set-cookie': 'seen=1; Path=/' },
      };
      answers.set('/about', finishedAnswer(about, '/about'));
      const account =
        'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000';
      // Asked for their headers alone with the cookie, answered from storage, not handed on.
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'set-cookie': 'seen=1; Path=/',
          'x-arkor-edge': account,
        },
        body: props,
        when: {
          test: (headers, method) => method === 'HEAD' && carryingEach('seen')(headers),
          onHead: { 'content-type': JSON_TYPE, 'x-arkor-edge': account },
        },
      });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [seen] }));

      // Asked as the first flow asks it, once the request for the props set the cookie.
      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason: `its page's props (/_next/data/test/about.json), asked again for its headers alone as the Pages Router signals a revalidation, answered by the edge itself (x-arkor-edge: ${account}), though it hands the Function a request for a page's props' headers alone`,
        },
      ]);
    });

    it("follows where a redirect leads a page's props asked for their headers alone", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
        await routeOf('/other', about, { complete: true, pages: true, pagesData: props }),
      ];
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set('/other', finishedAnswer(about, '/other'));
      const account =
        'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000';
      const answered = {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'x-arkor-edge': account,
        },
        body: props,
      };
      // The about page's props, which the middleware redirects to the other's asked for their
      // headers alone — which the edge answers from storage there.
      answers.set('/_next/data/test/about.json', {
        ...answered,
        when: {
          test: (_headers, method) => method === 'HEAD',
          status: 307,
          onHead: {
            location: '/_next/data/test/other.json',
            'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
          },
        },
      });
      answers.set('/_next/data/test/other.json', {
        ...answered,
        onHead: { 'content-type': JSON_TYPE, 'x-arkor-edge': account },
      });
      const result = await checkStack(stackOf(routes, {}));
      const headAlone = `answered by the edge itself (x-arkor-edge: ${account}), though it hands the Function a request for a page's props' headers alone`;

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason: `its page's props (/_next/data/test/about.json), asked again for its headers alone as the Pages Router signals a revalidation, redirected to /_next/data/test/other.json, ${headAlone}`,
        },
        {
          path: '/other',
          reason: `its page's props (/_next/data/test/other.json), asked again for its headers alone as the Pages Router signals a revalidation, ${headAlone}`,
        },
      ]);
    });

    it("is answered with a Pages Router page's props at their own URL", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
      });
      const answered = await checkStack(stackOf(routes, {}));
      answers.set('/_next/data/test/about.json', {
        headers: { 'content-type': JSON_TYPE, 'x-arkor-edge': 'static;src=bucket;policy=default' },
        body: props,
      });
      const misanswered = await checkStack(stackOf(routes, {}));

      expect(answered).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // As the Pages Router asks: naming its deployment, and marked as a request for props.
      expect(askedHeaders.get('/_next/data/test/about.json')?.['x-deployment-id']).toBe('dpl_site');
      expect(askedHeaders.get('/_next/data/test/about.json')?.['x-nextjs-data']).toBe('1');
      expect(misanswered.failures[0]?.reason).toMatch(
        /^its page's props \(\/_next\/data\/test\/about\.json\), not answered by the edge as the part it is /u,
      );
    });

    it.each([
      { type: 'application/json; charset=utf-8', runtime: true, configured: false, accepted: true },
      {
        type: 'Application/JSON; Charset="UTF-8"',
        runtime: true,
        configured: false,
        accepted: true,
      },
      { type: 'text/plain; charset=utf-8', runtime: true, configured: false, accepted: false },
      { type: 'application/json; charset=utf-8', runtime: true, configured: true, accepted: false },
      {
        type: 'application/json; charset=utf-8',
        runtime: false,
        configured: false,
        accepted: false,
      },
    ])(
      'judges Pages props type $type with runtime=$runtime, configured=$configured',
      async (example) => {
        const about = `${ABOUT}<main>finished</main></body></html>`;
        const props = '{"pageProps":{}}';
        const routes = [
          await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
        ];
        const data = '/_next/data/test/about.json';
        answers.set('/about', finishedAnswer(about, '/about'));
        answers.set(data, {
          headers: {
            'content-type': example.type,
            vary: 'accept-encoding',
            'x-nextjs-cache': example.runtime ? 'STALE' : 'HIT',
            ...(example.runtime && { 'cache-control': 'no-store' }),
            'x-arkor-edge':
              'data;src=r2;enc=identity;strategy=r2;project=site;policy=default;m=0000',
          },
          body: example.runtime ? '{"pageProps":{"since":true}}' : props,
        });
        const rules: HeaderRule[] = example.configured
          ? [
              {
                sourceRegex: '^/_next/data/test/about[.]json$',
                headers: { 'content-type': JSON_TYPE },
              },
            ]
          : [];

        const result = await checkStack(stackOf(routes, {}, { headerRules: rules }));

        const failures = example.accepted
          ? []
          : [
              {
                path: '/about',
                reason: `its page's props (${data}), answered as ${example.type}, not ${JSON_TYPE}`,
              },
            ];

        expect(result).toStrictEqual({ checked: 1, failures, skipped: [] });
      },
    );

    it("is held to the build's props though marked as a runtime generation's segment or payload is", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      answers.set('/about', finishedAnswer(about, '/about'));
      // Marked with what the edge marks no page's props with, and other bytes than the build's.
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'x-nextjs-prerender': '1',
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: '{"pageProps":{"other":1}}',
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures[0]?.reason).toMatch(
        /^its page's props \(\/_next\/data\/test\/about\.json\), answered \d+ bytes other than the \d+ the build wrote$/u,
      );
    });

    it("is asked for a page's props as a link prefetches them, and held to the rules that select it", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // A rule for a prefetch of the props alone, which says it is one.
      const prefetched: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        has: [{ type: 'header', key: 'purpose', value: 'prefetch' }],
        headers: { 'x-prefetched': 'yes' },
      };
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
      });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [prefetched] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), prefetched, answered with x-prefetched none, not the yes the application set",
        },
      ]);
    });

    it("tells the middleware of a prefetch of a page's props only where the router takes it to run for the page", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // A rule for a prefetch of the props that tells the middleware so, and one for any other.
      const data = String.raw`^/_next/data/test/about\.json$`;
      const told: HeaderRule = {
        sourceRegex: data,
        has: [{ type: 'header', key: 'x-middleware-prefetch', value: '1' }],
        headers: { 'x-told': 'yes' },
      };
      const untold: HeaderRule = {
        sourceRegex: data,
        has: [{ type: 'header', key: 'purpose', value: 'prefetch' }],
        missing: [{ type: 'header', key: 'x-middleware-prefetch' }],
        headers: { 'x-untold': 'yes' },
      };
      const rules = { headerRules: [told, untold] };
      const propsAnswer = (headers: OutgoingHttpHeaders): Answer => {
        return {
          headers: {
            'content-type': JSON_TYPE,
            vary: 'accept-encoding',
            'x-nextjs-cache': 'HIT',
            'cache-control': GATED,
            'x-arkor-edge':
              'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
            ...headers,
          },
          body: props,
        };
      };
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set('/_next/data/test/about.json', propsAnswer({ 'x-untold': 'yes' }));
      // A middleware the router takes to run for nothing but what is under `/api`.
      const elsewhere = await checkStack(
        withMiddleware(stackOf(routes, {}, rules), [{ sourceRegex: '^/api(?:/(.*))?$' }]),
      );
      // One whose matcher covers the page's pathname, which the router tests alone — though the
      // header it asks of a request keeps the edge from running it.
      const page = {
        sourceRegex: String.raw`^(?:\/(_next\/data\/[^/]{1,}))?\/about(\.json)?[\/#\?]?$`,
        has: [{ type: 'header', key: 'x-never-sent' }],
      } as const;
      const covering = withMiddleware(stackOf(routes, {}, rules), [page]);
      const covered = await checkStack(covering);
      // Asked as a hover asks again past the client's cache, too: without telling it.
      answers.set('/_next/data/test/about.json', propsAnswer({ 'x-told': 'yes' }));
      const hovered = await checkStack(covering);

      expect(elsewhere.failures).toStrictEqual([]);
      expect(covered.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), prefetched with the middleware told, answered with x-told none, not the yes the application set",
        },
      ]);
      expect(hovered.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), prefetched, answered with x-untold none, not the yes the application set",
        },
      ]);
    });

    it("is asked for a page's props without the cookies its navigation carried, as kept to the page's path", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'session' }],
      };
      // A rule for its props asked with no session.
      const anonymous: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        missing: [{ type: 'cookie', key: 'session' }],
        headers: { 'x-anonymous': 'yes' },
      };
      answers.set('/about', claimedWithout(finishedAnswer(about, '/about'), 'session'));
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
      });
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [signedOut], headerRules: [anonymous] }),
      );

      expect(askedHeadersEach.get('/about')?.[0]?.cookie).toBe('session=1');
      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), its navigation's cookies kept to its page's path, answered with x-anonymous none, not the yes the application set",
        },
      ]);
    });

    it("is asked for a page's props without the cookies its document's answer cleared", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'session' }],
      };
      // A rule for its props asked from the page itself with no session.
      const anonymous: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        has: [{ type: 'header', key: 'referer', value: '.*/about$' }],
        missing: [{ type: 'cookie', key: 'session' }],
        headers: { 'x-anonymous': 'yes' },
      };
      // Its document answered clearing the site's cookies, the session among them.
      const document = finishedAnswer(about, '/about');
      answers.set(
        '/about',
        claimedWithout(
          {
            ...document,
            headers: { ...document.headers, 'clear-site-data': '"cache", "cookies"' },
          },
          'session',
        ),
      );
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
      });
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [signedOut], headerRules: [anonymous] }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), from the page itself, answered with x-anonymous none, not the yes the application set",
        },
      ]);
    });

    it("is asked for a page's props as a browser asks that holds a cookie a rule claims them without", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // The props claimed for a visitor with no session — one a browser may keep for the props
      // alone (`Path=/_next/data`), which the page's navigation never sends.
      const signedOut: ReservedRoute = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'sid' }],
      };
      answers.set('/about', finishedAnswer(about, '/about'));
      // Handed on where claimed; with a session, answered from storage under another type.
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': 'text/plain',
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
        claimedWhen: (headers) => !String(headers.cookie).includes('sid='),
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [signedOut] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason: `its page's props (/_next/data/test/about.json), carrying the cookie sid=1, answered as text/plain, not ${JSON_TYPE}`,
        },
      ]);
    });

    it("checks an escaped Pages Router flow's background HEAD with the GET's cookies", async () => {
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', finished, { complete: true, pages: true, pagesData: props }),
      ];
      const data = String.raw`^/_next/data/test/about\.json$`;
      const signedOut: ReservedRoute = {
        sourceRegex: data,
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'sid' }],
      };
      const seen: HeaderRule = {
        sourceRegex: data,
        has: [{ type: 'cookie', key: 'sid' }],
        headers: { 'set-cookie': 'seen=1; Path=/' },
      };
      answers.set('/about', finishedAnswer(finished, '/about'));
      const account =
        'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000';
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'x-arkor-edge': account,
        },
        body: props,
        claimedWhen: (headers) => !String(headers.cookie).includes('sid='),
        withCookie: { name: 'sid', headers: { 'set-cookie': 'seen=1; Path=/' } },
        when: {
          test: (headers, method) => method === 'HEAD' && carryingEach('sid', 'seen')(headers),
          onHead: { 'content-type': JSON_TYPE, 'x-arkor-edge': account },
        },
      });
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [signedOut], headerRules: [seen] }),
      );

      expect(result.failures).toHaveLength(1);
      expect(
        includesInLineOrder(
          result.failures[0]?.reason,
          'carrying the cookie sid=1, asked again for its headers alone ',
          'answered by the edge itself',
        ),
      ).toBe(true);
    });

    it('follows cookies set by an escaped Pages Router background HEAD', async () => {
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', finished, { complete: true, pages: true, pagesData: props }),
      ];
      const signedOut: ReservedRoute = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        beforeFiles: true,
        // Only navigation has the background HEAD whose cookies this case follows.
        missing: [
          { type: 'cookie', key: 'sid' },
          { type: 'header', key: 'purpose' },
        ],
      };
      answers.set('/about', finishedAnswer(finished, '/about'));
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
        claimedWhen: (headers) => !carryingEach('sid')(headers) && headers['purpose'] === undefined,
        when: {
          test: (headers, method) =>
            carryingEach('sid')(headers) && (method === 'HEAD' || carryingEach('headed')(headers)),
          headers: { 'content-type': TEXT },
          onHead: {
            'content-type': JSON_TYPE,
            'x-arkor-edge': 'passthrough;reason=pages-data',
            'set-cookie': 'headed=1; Path=/',
          },
        },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [signedOut] }));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain(`answered as ${TEXT}, not ${JSON_TYPE}`);
      expect(result.failures[0]?.reason).toContain('with the cookies set by');
    });

    it("proves none of a page's props a rule claims without a value the check finds none of", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // The props claimed for a visitor without a session of four digits.
      const signedOut: ReservedRoute = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'sid', value: '[0-9]{4}' }],
      };
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set('/_next/data/test/about.json', {
        ...handedOnAs('passthrough;reason=route-not-proved', JSON_TYPE),
        body: props,
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [signedOut] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), a rule of next.config claims every request the check makes for what it lacks, and only a value its pattern names, of which the check finds none it matches, would pass it over: no request proves it",
        },
      ]);
    });

    it("follows what a page's props answer a browser that holds a cookie a rule claims them without", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      const data = String.raw`^/_next/data/test/about\.json$`;
      // The props claimed for a visitor with no session; with one, a rule sets another cookie.
      const signedOut: ReservedRoute = {
        sourceRegex: data,
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'sid' }],
      };
      const seen: HeaderRule = {
        sourceRegex: data,
        has: [{ type: 'cookie', key: 'sid' }],
        headers: { 'set-cookie': 'x=1; Path=/' },
      };
      answers.set('/about', finishedAnswer(about, '/about'));
      // Answered from storage under another type to a visitor holding both.
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
        claimedWhen: (headers) => !String(headers.cookie).includes('sid='),
        withCookie: { name: 'sid', headers: { 'set-cookie': 'x=1; Path=/' } },
        when: { test: carryingEach('sid', 'x'), headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [signedOut], headerRules: [seen] }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason: `its page's props (/_next/data/test/about.json), with the cookies set by its page's props (/_next/data/test/about.json), carrying the cookie sid=1, answered as text/plain, not ${JSON_TYPE}`,
        },
      ]);
    });

    it("is asked for a page's props with each of its navigation's cookies kept apart, too", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // The page claimed for a visitor without either cookie, which the check asks past with both.
      // A rule for its props asked with the one cookie and not the other.
      const alone: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        has: [{ type: 'cookie', key: 'a' }],
        missing: [{ type: 'cookie', key: 'b' }],
        headers: { 'x-alone': 'yes' },
      };
      answers.set('/about', claimedWithout(finishedAnswer(about, '/about'), 'a', 'b'));
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
      });
      const result = await checkStack(
        stackOf(
          routes,
          {},
          {
            reservedRoutes: [aboutWithout('a'), aboutWithout('b')],
            headerRules: [alone],
          },
        ),
      );

      expect(askedHeadersEach.get('/about')?.[0]?.cookie).toBe('a=1; b=1');
      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), its navigation's cookie b kept to its page's path, answered with x-alone none, not the yes the application set",
        },
      ]);
    });

    it("is asked for a page's props with neither the cookies its navigation carried nor a referrer, too", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'session' }],
      };
      // A rule for its props asked with no session and from no page.
      const bare: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        missing: [
          { type: 'cookie', key: 'session' },
          { type: 'header', key: 'referer' },
        ],
        headers: { 'x-bare': 'yes' },
      };
      answers.set('/about', claimedWithout(finishedAnswer(about, '/about'), 'session'));
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': GATED,
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
      });
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [signedOut], headerRules: [bare] }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), its navigation's cookies kept to its page's path, with no referrer, answered with x-bare none, not the yes the application set",
        },
      ]);
    });

    it("is held to its type, and to a runtime generation's props where one answered it", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      const data = '/_next/data/test/about.json';
      const dataAnswer = (body: string, headers: OutgoingHttpHeaders): Answer => {
        return {
          headers: {
            'content-type': JSON_TYPE,
            vary: 'accept-encoding',
            'x-nextjs-cache': 'HIT',
            'x-arkor-edge':
              'data;src=r2;enc=identity;strategy=r2;project=site;policy=default;m=0000',
            ...headers,
          },
          body,
        };
      };
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set(data, dataAnswer(props, { 'content-type': TEXT }));
      const retyped = await checkStack(stackOf(routes, {}));
      // A rule of `next.config` that types it, which the edge keeps.
      const typed: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        headers: { 'content-type': TEXT },
      };
      const ruled = await checkStack(stackOf(routes, {}, { headerRules: [typed] }));
      // A generation the runtime rendered since, stale and kept from every cache.
      const since = '{"pageProps":{"since":true}}';
      answers.set(
        data,
        dataAnswer(since, { 'x-nextjs-cache': 'STALE', 'cache-control': 'no-store' }),
      );
      const stale = await checkStack(stackOf(routes, {}));
      answers.set(data, dataAnswer(since, {}));
      const unmarked = await checkStack(stackOf(routes, {}));

      expect(retyped.failures).toStrictEqual([
        {
          path: '/about',
          reason: `its page's props (${data}), answered as ${TEXT}, not ${JSON_TYPE}`,
        },
      ]);
      expect(ruled).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(stale).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unmarked.failures).toStrictEqual([
        {
          path: '/about',
          reason: `its page's props (${data}), answered ${String(Buffer.byteLength(since))} bytes other than the ${String(Buffer.byteLength(props))} the build wrote`,
        },
      ]);
    });

    it("is kept from shared caches where it is one visitor's, and marked as from the cache as Next.js marks it", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const shared = { 'cache-control': 'public, max-age=60' };
      // With a cookie nothing of the application's set, which a browser would keep all the same.
      partAnswers.set('/|/_tree', {
        ...segmentAnswer('tree bytes'),
        headers: { ...segmentAnswer('tree bytes').headers, ...shared, 'set-cookie': 'seen=1' },
      });
      const cookied = await checkStack(stackOf(routes, {}));
      partAnswers.set('/|/_tree', {
        ...segmentAnswer('rendered since'),
        headers: {
          ...segmentAnswer('rendered since').headers,
          ...shared,
          'x-nextjs-prerender': '1',
        },
      });
      const rendered = await checkStack(stackOf(routes, {}));
      const whole = [await routeOf('/', finished, { complete: true, payload: 'payload bytes' })];
      answers.set('/', finishedAnswer(finished, '/'));
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'MISSPELLED' }),
      );
      const misspelled = await checkStack(stackOf(whole, {}));
      const reason = "answered for shared caches to keep, though the answer is one visitor's";

      expect(cookied.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with the cookie seen=1, which the application did not set',
        },
      ]);
      expect(rendered.failures).toStrictEqual([
        { path: '/', reason: `its prefetch segment /_tree, ${reason}` },
      ]);
      expect(misspelled.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, answered with x-nextjs-cache MISSPELLED, not HIT',
        },
      ]);
    });

    it("is asked with the page's query, as a client asks for a page's props", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // A rule that claims the page asked for without a query, which the check asks past with one.
      const unqueried: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [{ type: 'query', key: 'v' }],
      };
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set('/_next/data/test/about.json', {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'x-arkor-edge':
            'data;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000',
        },
        body: props,
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [unqueried] }));

      expect(result.checked).toBe(1);
      expect(queries.get('/about')).toMatch(/^\?v=/u);
      expect(queries.get('/_next/data/test/about.json')).toBe(queries.get('/about'));
    });

    it('fails where it is handed on past the middleware covering it, which ran not — but its props', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      const covered = withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]);
      // Handed on for want of the part, as the edge hands one on once the middleware ran — with
      // none run, and then with it run.
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=segment-prefetch', RSC));
      const unrun = await checkStack(covered);
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=segment-prefetch;mw=hit', RSC));
      const ran = await checkStack(covered);
      // A page's props, which the edge hands on before the middleware, which the Function runs.
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const pages = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: '{}' }),
      ];
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set('/_next/data/test/about.json', {
        headers: { 'content-type': JSON_TYPE, 'x-arkor-edge': 'passthrough;reason=pages-data' },
        body: '{}',
      });
      unkept.add('/_next/data/test/about.json');
      const props = await checkStack(
        withMiddleware(stackOf(pages, {}), [
          { sourceRegex: String.raw`^(?:\/(_next\/data\/[^/]{1,}))?\/about(\.json)?[\/#\?]?$` },
        ]),
      );

      expect(unrun.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its prefetch segment /_tree, the application's middleware covers it, and the edge handed it on without running the middleware",
        },
      ]);
      expect(ran.failures).toStrictEqual([]);
      expect(props.failures).toStrictEqual([]);
    });

    it('is asked as each browser a page is asked as, whatever browser the page was asked as', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      // A host whose validation proves as Firefox.
      const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
      const result = await checkStack(stackOf(routes, {}), { proverAgent: firefox });
      const asking = (partsAskedEach.get('/|/_tree') ?? []).map((asked) => asked['user-agent']);

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // As the prover, and as each of the five browsers, each with a referrer and with none.
      expect(asking).toHaveLength(12);
      expect(asking[0]).toContain('Firefox/');
      expect(asking).toStrictEqual(
        expect.arrayContaining([
          expect.stringContaining('Chrome/141.0.0.0 Safari'),
          expect.stringContaining('iPhone'),
          expect.stringContaining('Macintosh'),
          expect.stringContaining('Android'),
        ]),
      );
    });

    it('is held to the bytes the build wrote where the edge may answer no runtime generation', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // Other bytes, marked as a runtime generation's — by a policy that serves from no record.
      const since = segmentAnswer('rendered since');
      partAnswers.set('/|/_tree', {
        ...since,
        headers: {
          ...since.headers,
          'x-nextjs-prerender': '1',
          'cache-control': 'private, no-store',
        },
      });
      const served = await checkStack(stackOf(routes, {}));
      const offPolicy = {
        ...DEFAULT_DELIVERY_POLICY,
        id: 'default',
        runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'off' as const },
      };
      const unserved = await checkStack({ ...stackOf(routes, {}), policy: offPolicy });

      expect(served.failures).toStrictEqual([]);
      expect(unserved.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered 14 bytes other than the 10 the build wrote',
        },
      ]);
    });

    it('carries what the runtime generation that answered it was recorded with, of those the edge read', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // Two generations of the page's record the edge read, each recorded with a header of its own.
      const entry = await entryOf('/', '/');
      generationHeaders.set(`dpl_site|${entry}|1`, { 'content-type': HTML, 'x-generation': '1' });
      generationHeaders.set(`dpl_site|${entry}|2`, { 'content-type': HTML, 'x-generation': '2' });
      const since = segmentAnswer('rendered since');
      const runtime = {
        ...since.headers,
        'x-nextjs-prerender': '1',
        'cache-control': 'private, no-store',
      };
      partAnswers.set('/|/_tree', { ...since, headers: { ...runtime, 'x-generation': '2' } });
      const second = await checkStack(stackOf(routes, {}));
      partAnswers.set('/|/_tree', { ...since, headers: { ...runtime, 'x-generation': '1' } });
      const first = await checkStack(stackOf(routes, {}));
      partAnswers.set('/|/_tree', { ...since, headers: { ...runtime, 'x-generation': '3' } });
      const neither = await checkStack(stackOf(routes, {}));

      expect(second.failures).toStrictEqual([]);
      expect(first.failures).toStrictEqual([]);
      expect(neither.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with x-generation 3, not the 2 the application set',
        },
      ]);
    });

    it('is answered in the coding the edge holds it in that the request takes best', async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' }, codedParts: true }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // As it is to every request, and said so, though the deployment holds it in brotli and gzip.
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, asked for in br, answered with Content-Encoding none, not the br the edge holds the part in for the request',
        },
      ]);
    });

    it('is asked from a page that sends no referrer, too', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A rule for the router's requests that name no page they come from.
      const unreferred: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'rsc', value: '1' }],
        missing: [{ type: 'header', key: 'referer' }],
        headers: { 'x-unreferred': 'yes' },
      };
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED },
      });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [unreferred] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, with no referrer, answered with x-unreferred none, not the yes the application set',
        },
      ]);
    });

    it('is marked postponed as the runtime generation that answered it is partial', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A generation of the page's record the edge read, which a resume would finish.
      const at = `dpl_site|${await entryOf('/', '/')}|2`;
      generationHeaders.set(at, { 'content-type': HTML });
      generationOutputs.set(at, [outputOf('rsc', 'rsc', 'partial since')]);
      partialGenerations.add(at);
      const marks = {
        'x-nextjs-cache': 'HIT',
        'x-nextjs-prerender': '1',
        'cache-control': 'private, no-store',
      };
      // Prefetched down to the loading boundary, as the edge answers that from it: unmarked, then
      // marked postponed.
      partAnswers.set('/|rsc-prefetch', partAnswer('payload', 'partial since', marks));
      const unmarked = await checkStack(stackOf(routes, {}));
      partAnswers.set(
        '/|rsc-prefetch',
        partAnswer('payload', 'partial since', { ...marks, 'x-nextjs-postponed': '1' }),
      );
      const marked = await checkStack(stackOf(routes, {}));

      expect(unmarked.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, prefetched (next-router-prefetch: 1), answered with x-nextjs-postponed none from a generation a resume would finish, not 1',
        },
      ]);
      expect(marked.failures).toStrictEqual([]);
    });

    it("is marked stale as its runtime generation's validity was, as the edge read it", async () => {
      const routes = [await routeOf('/', finished, { complete: true, payload: 'payload bytes' })];
      answers.set('/', finishedAnswer(finished, '/'));
      // A generation of the page's record the edge read, rendered a minute ago to stay fresh for a
      // second: stale since.
      const at = `dpl_site|${await entryOf('/', '/')}|2`;
      generationHeaders.set(at, { 'content-type': HTML });
      generationOutputs.set(at, [outputOf('rsc', 'rsc', 'payload since')]);
      const unbounded = { kind: 'unbounded' };
      generationFreshness.set(at, {
        policy: {
          revalidateAfter: { kind: 'finite', seconds: 1 },
          expireAfter: unbounded,
          clientStale: unbounded,
          source: 'runtime-output',
        },
        cacheTimestamp: Date.now() - 60_000,
      });
      const marks = { 'x-nextjs-prerender': '1', 'cache-control': 'private, no-store' };
      const markedAs = (cacheState: string): Answer =>
        partAnswer('payload', 'payload since', { ...marks, 'x-nextjs-cache': cacheState });
      partAnswers.set('/|rsc', markedAs('HIT'));
      const hit = await checkStack(stackOf(routes, {}));
      partAnswers.set('/|rsc', markedAs('STALE'));
      const stale = await checkStack(stackOf(routes, {}));

      expect(hit.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its whole React Server Components payload, answered with x-nextjs-cache HIT, though its generation's validity marks it STALE",
        },
      ]);
      expect(stale.failures).toStrictEqual([]);
    });

    it("fails where a runtime generation's part is no output of a generation the edge read", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A generation of the page's record the edge read, which holds its segment as rendered since.
      const at = `dpl_site|${await entryOf('/', '/')}|2`;
      generationHeaders.set(at, { 'content-type': HTML });
      generationOutputs.set(at, [outputOf('segment', 'segment:/_tree', 'tree since')]);
      const marks = { 'x-nextjs-prerender': '1', 'cache-control': 'private, no-store' };
      const since = segmentAnswer('tree since');
      partAnswers.set('/|/_tree', { ...since, headers: { ...since.headers, ...marks } });
      const held = await checkStack(stackOf(routes, {}));
      const other = segmentAnswer('other since');
      partAnswers.set('/|/_tree', { ...other, headers: { ...other.headers, ...marks } });
      const unheld = await checkStack(stackOf(routes, {}));

      expect(held.failures).toStrictEqual([]);
      expect(unheld.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its prefetch segment /_tree, answered 11 bytes no generation of its route's record the stack's edge read holds for it",
        },
      ]);
    });

    it("fails where it is handed on for its route's bypassFor, which holds not for it", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=bypass-for', RSC));
      const unheld = await checkStack(stackOf(routes, {}));
      // A route Next.js renders itself for the router's requests.
      const bypassed = {
        ...(await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })),
        bypassFor: [{ type: 'header' as const, key: 'rsc', value: '1' }],
      };
      const held = await checkStack(stackOf([bypassed], {}));

      expect(unheld.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its prefetch segment /_tree, handed on, for its route's bypassFor, which holds not for the request, nor does a draft mode's cookie stand (x-arkor-edge: passthrough;reason=bypass-for)",
        },
      ]);
      expect(held.failures).toStrictEqual([]);
    });

    it("is a runtime generation's where it is marked as the application marks it too, though its bytes are the build's", async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' }, codedParts: true }),
      ];
      // A rule that marks the page's parts as Next.js marks a render since the build's.
      const marking: HeaderRule = { sourceRegex: '^/$', headers: { 'x-nextjs-prerender': '1' } };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'x-nextjs-prerender': '1' },
      });
      // As it is in every coding, as the edge sends a runtime generation's — whose bytes the build's
      // happen to be — though it holds the build's in brotli and gzip.
      const tree = segmentAnswer('tree bytes');
      const rendered = { ...tree.headers, 'x-nextjs-prerender': '1', 'cache-control': GATED };
      partAnswers.set('/|/_tree', { ...tree, headers: rendered });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [marking] }));

      expect(result.failures).toStrictEqual([]);
    });

    it('is asked with the cookies the parts asked for before it set, as a browser that fetched them asks', async () => {
      const routes = [
        await routeOf('/', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      // A rule that sets a cookie on a segment prefetch alone, and one for a payload asked with it.
      const setting: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'header', key: 'next-router-segment-prefetch' },
        ],
        headers: { 'set-cookie': 'seen=1; Path=/' },
      };
      const seen: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'seen' },
        ],
        missing: [{ type: 'header', key: 'next-router-segment-prefetch' }],
        headers: { 'x-seen': 'yes' },
      };
      answers.set('/', finishedAnswer(finished, '/'));
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED, 'set-cookie': 'seen=1; Path=/' },
      });
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT', 'cache-control': GATED }),
      );
      const result = await checkStack(stackOf(routes, {}, { headerRules: [setting, seen] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, with the cookies set by its prefetch segment /_tree, answered with x-seen none, not the yes the application set',
        },
      ]);
    });

    it("keeps the cookies a part's answer sets in what the browser accepts at once", async () => {
      const routes = [
        await routeOf('/', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      // A rule that sets a cookie on a segment prefetch asked as Chrome asks, by its hints, and one
      // for a payload asked with it.
      const setting: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'header', key: 'next-router-segment-prefetch' },
          { type: 'header', key: 'sec-ch-ua' },
        ],
        headers: { 'set-cookie': 'seen=1; Path=/' },
      };
      const seen: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'seen' },
        ],
        missing: [{ type: 'header', key: 'next-router-segment-prefetch' }],
        headers: { 'x-seen': 'yes' },
      };
      answers.set('/', finishedAnswer(finished, '/'));
      const tree = segmentAnswer('tree bytes');
      const gated = { ...tree.headers, 'cache-control': GATED };
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: gated,
        withHeader: { name: 'sec-ch-ua', headers: { 'set-cookie': 'seen=1; Path=/' } },
      });
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT', 'cache-control': GATED }),
      );
      const result = await checkStack(stackOf(routes, {}, { headerRules: [setting, seen] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, with the cookies set by its prefetch segment /_tree, answered with x-seen none, not the yes the application set',
        },
      ]);
    });

    it('is asked with each jar the browser holds on the way, as it is asked after some of the parts before it', async () => {
      const routes = [
        await routeOf('/', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes', '/_index': 'index bytes' },
        }),
      ];
      // Rules that set a cookie on each segment prefetch, the later over the earlier, and one for a
      // payload asked with the earlier's alone.
      const first: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'sid', value: 'one' },
        ],
        missing: [{ type: 'header', key: 'next-router-segment-prefetch' }],
        headers: { 'x-first': 'yes' },
      };
      const rules = [
        segmentCookieRule('/_tree', 'sid=one; Path=/'),
        segmentCookieRule('/_index', 'sid=two; Path=/'),
      ];
      answers.set('/', finishedAnswer(finished, '/'));
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED, 'set-cookie': 'sid=one; Path=/' },
      });
      const index = segmentAnswer('index bytes');
      partAnswers.set('/|/_index', {
        ...index,
        headers: { ...index.headers, 'cache-control': GATED, 'set-cookie': 'sid=two; Path=/' },
      });
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT', 'cache-control': GATED }),
      );
      const result = await checkStack(stackOf(routes, {}, { headerRules: [...rules, first] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, with the cookies set by its prefetch segment /_tree, answered with x-first none, not the yes the application set',
        },
      ]);
    });

    it("keeps its navigation's cookies kept to its page's path beside one a part sets under the root path", async () => {
      const routes = [
        await routeOf('/about', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'session' }],
      };
      // A rule that sets a session under the root path on a segment prefetch, and one for a payload
      // asked with both sessions: the navigation's, kept to the page's path, and the segment's.
      const setting: HeaderRule = {
        sourceRegex: '^/about$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'header', key: 'next-router-segment-prefetch' },
        ],
        headers: { 'set-cookie': 'session=2; Path=/' },
      };
      const both: HeaderRule = {
        sourceRegex: '^/about$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'header', key: 'cookie', value: 'session=1; session=2' },
        ],
        missing: [{ type: 'header', key: 'next-router-segment-prefetch' }],
        headers: { 'x-both': 'yes' },
      };
      answers.set('/about', claimedWithout(finishedAnswer(finished, '/about'), 'session'));
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/about|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED, 'set-cookie': 'session=2; Path=/' },
      });
      partAnswers.set(
        '/about|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT', 'cache-control': GATED }),
      );
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [signedOut], headerRules: [setting, both] }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its whole React Server Components payload, its navigation's cookies kept to its page's path, with the cookies set by its prefetch segment /_tree, answered with x-both none, not the yes the application set",
        },
      ]);
    });

    it("keeps its navigation's cookies kept partitioned beside one of the same name and path a part sets", async () => {
      const routes = [
        await routeOf('/', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      // The front page claimed for a visitor with no session, which the check asks past with one.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'session' }],
      };
      // A rule that sets a session under the root path on a segment prefetch — the navigation's own
      // path, which replaces its session unless one of them is partitioned — and one for a payload
      // asked with both sessions.
      const setting: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'header', key: 'next-router-segment-prefetch' },
        ],
        headers: { 'set-cookie': 'session=2; Path=/' },
      };
      const both: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'header', key: 'cookie', value: 'session=1; session=2' },
        ],
        missing: [{ type: 'header', key: 'next-router-segment-prefetch' }],
        headers: { 'x-both': 'yes' },
      };
      answers.set('/', claimedWithout(finishedAnswer(finished, '/'), 'session'));
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED, 'set-cookie': 'session=2; Path=/' },
      });
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT', 'cache-control': GATED }),
      );
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [signedOut], headerRules: [setting, both] }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its whole React Server Components payload, its navigation's cookies kept partitioned, with the cookies set by its prefetch segment /_tree, answered with x-both none, not the yes the application set",
        },
      ]);
    });

    it("proves nothing past a part's answer that leaves a browser holding more cookies than one need keep", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The middleware sets more cookies on the tree than a browser need keep of a domain, any of
      // which it may drop.
      const tree = segmentBehindMiddleware('tree bytes');
      const many = Array.from({ length: 51 }, (_, at) => `c${String(at)}=1; Path=/`);
      decidedForSegment.set('/about|/_tree', { 'x-middleware-next': '1', 'set-cookie': many });
      partAnswers.set('/about|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'set-cookie': many },
      });
      const result = await checkStack(
        withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/about$' }]),
      );

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, .*a browser holds 51 cookies of the site's, more than one need keep of a domain \(50\), any of which it may have dropped: no request proves which it sends$/u,
      );
    });

    it("proves nothing past a part's cookie whose Expires browsers read apart, by its answer's Date or their own clock", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The tree is dated an hour behind, and its cookie ends half an hour after that: kept for half
      // an hour yet by Chrome and Firefox, which read it against that Date; ended by the clock.
      const tree = segmentBehindMiddleware('tree bytes');
      const now = Date.now();
      const mark = `mark=1; Path=/; Expires=${new Date(now - 1_800_000).toUTCString()}`;
      decidedForSegment.set('/about|/_tree', { 'x-middleware-next': '1', 'set-cookie': mark });
      partAnswers.set('/about|/_tree', {
        ...tree,
        headers: {
          ...tree.headers,
          date: new Date(now - 3_600_000).toUTCString(),
          'set-cookie': mark,
        },
      });
      const result = await checkStack(
        withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/about$' }]),
      );

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, .*cookie mark has ended as one browser reads its Expires and not as another does/u,
      );
    });

    it('says the page a redirected visit landed on as a browser says a referrer: without its fragment', async () => {
      const routes = [
        await routeOf('/about', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // The middleware redirects the page to a part of the login, saying where the visitor came from.
      answers.set('/about', {
        status: 307,
        headers: {
          location: '/login#form',
          'set-cookie': 'from=about; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      answers.set('/login', finishedAnswer(finished, '/login'));
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/login|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED },
      });
      // A rule that marks the login's segment for a visitor who came by the redirect, asked from the
      // login as a browser says it — a pattern Next.js also finds within a value, so none past it.
      const redirected: HeaderRule = {
        sourceRegex: '^/login$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'from' },
          { type: 'header', key: 'referer', value: '.*/login' },
        ],
        missing: [{ type: 'header', key: 'referer', value: '#' }],
        headers: { 'x-from': 'yes' },
      };
      const result = await checkStack(stackOf(routes, {}, { headerRules: [redirected] }));

      expect(result.failures).toContainEqual({
        path: '/login',
        reason:
          'its prefetch segment /_tree, from /about, landing on /login, answered with x-from none, not the yes the application set',
      });
    });

    it('proves no payload where a rule of next.config asks of the router state it is asked from', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, payload: 'payload bytes' }),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      partAnswers.set(
        '/about|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT' }),
      );
      // A rule that tells payloads apart by the router state they are asked from, which a browser
      // sends as its router has cached the pages it holds.
      const byState: HeaderRule = {
        sourceRegex: '^/about$',
        has: [{ type: 'header', key: 'next-router-state-tree', value: '.*about.*' }],
        headers: { 'x-state': 'about' },
      };
      const result = await checkStack(stackOf(routes, {}, { headerRules: [byState] }));

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its whole React Server Components payload, .*a rule of next\.config asks of the router state it is asked from, which a browser sends as its router has cached the pages it holds, and the check builds from the path of the page it is on alone: no request proves it$/u,
      );
    });

    it('proves no payload where the middleware sees the router state it is asked from', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, payload: 'payload bytes' }),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      partAnswers.set(
        '/about|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT' }),
      );
      // A build that keeps the router's headers on the request its middleware runs on.
      const stack = withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/about$' }]);
      const config = { ...stack.bundle.config, skipProxyUrlNormalize: true };
      const result = await checkStack({ ...stack, bundle: { ...stack.bundle, config } });

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its whole React Server Components payload, .*the application's middleware sees the router state it is asked from \(skipProxyUrlNormalize\)/u,
      );
    });

    it("fails where a runtime generation's part is the output of a generation the build wrote alone", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A generation of the page's record a build wrote, whose parts the edge serves as the build's.
      const at = `dpl_site|${await entryOf('/', '/')}|1`;
      generationHeaders.set(at, { 'content-type': HTML });
      generationOutputs.set(at, [outputOf('segment', 'segment:/_tree', 'tree since')]);
      builtGenerations.add(at);
      const since = segmentAnswer('tree since');
      const marks = { 'x-nextjs-prerender': '1', 'cache-control': 'private, no-store' };
      partAnswers.set('/|/_tree', { ...since, headers: { ...since.headers, ...marks } });
      const built = await checkStack(stackOf(routes, {}));
      builtGenerations.delete(at);
      const rendered = await checkStack(stackOf(routes, {}));

      expect(built.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its prefetch segment /_tree, answered 10 bytes no generation of its route's record the stack's edge read holds for it",
        },
      ]);
      expect(rendered.failures).toStrictEqual([]);
    });

    it('fails where a payload or props the route holds are taken for no part, but where a rule claims them', async () => {
      const whole = [await routeOf('/', finished, { complete: true, payload: 'payload bytes' })];
      answers.set('/', finishedAnswer(finished, '/'));
      partAnswers.set('/|rsc', handedOnAs('passthrough;reason=rsc', RSC));
      const payload = await checkStack(stackOf(whole, {}));
      // A rule ahead of the filesystem that claims the router's requests.
      const routers = frontRule({ has: [{ type: 'header', key: 'rsc', value: '1' }] });
      const claimed = await checkStack(stackOf(whole, {}, { reservedRoutes: [routers] }));
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const pages = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set(
        '/_next/data/test/about.json',
        handedOnAs('passthrough;reason=next-internal', JSON_TYPE),
      );
      const data = await checkStack(stackOf(pages, {}));

      expect(payload.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, handed on, taken for no part of a page, though its route holds its whole payload, nothing turns the request away, and no rule claims it (x-arkor-edge: passthrough;reason=rsc)',
        },
      ]);
      expect(claimed.failures).toStrictEqual([]);
      expect(data.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its page's props (/_next/data/test/about.json), handed on, taken for no page's props, though its route holds them, nothing turns the request away, and no rule claims it (x-arkor-edge: passthrough;reason=next-internal)",
        },
      ]);
    });

    it("is the application's where a draft mode's cookie the document was answered with turns it away", async () => {
      const routes = [
        await routeOf('/', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      // The middleware answers the page's document with a draft mode's cookie.
      const drafted = '__prerender_bypass=1; Path=/';
      decisions.set('/', { 'x-middleware-next': '1', 'set-cookie': drafted });
      const document = finishedAnswer(finished, '/');
      answers.set('/', { ...document, headers: { ...document.headers, 'set-cookie': [drafted] } });
      // A segment turned away for the cookie, and the payload taken for no part, as the edge takes
      // a router's request it turns away.
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=bypass-cookie', RSC));
      partAnswers.set('/|rsc', handedOnAs('passthrough;reason=rsc', RSC));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
    });

    it('fails where a segment is turned away for what its request does not carry', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=bypass-query', RSC));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, handed on, turned away for a query key that asks for another answer, though the request carries nothing the edge turns one away for (x-arkor-edge: passthrough;reason=bypass-query)',
        },
      ]);
    });

    it('fails where a part the build wrote is handed on for want of it, of a route the edge answers from the build alone', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=segment-prefetch', RSC));
      const served = await checkStack(stackOf(routes, {}));
      // A policy that serves from no record: the edge answers the route's parts from the build.
      const offPolicy = {
        ...DEFAULT_DELIVERY_POLICY,
        id: 'default',
        runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'off' as const },
      };
      const built = await checkStack({ ...stackOf(routes, {}), policy: offPolicy });

      expect(served.failures).toStrictEqual([]);
      expect(built.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, handed on, for want of the part, though the build wrote it for the route the request is on, which the edge answers from what the build wrote alone (x-arkor-edge: passthrough;reason=segment-prefetch)',
        },
      ]);
    });

    it('fails where it is handed on as the middleware failed, which covers it not, or answered', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const threw = handedOnAs('passthrough;reason=middleware-failed;cause=threw', RSC);
      partAnswers.set('/|/_tree', threw);
      const uncovered = await checkStack(stackOf(routes, {}));
      // A middleware that covers the page, and answers: what the stack keeps of it.
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      decisions.set('/', { 'x-middleware-next': '1' });
      const covered = withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]);
      const answered = await checkStack(covered);
      // Outrun, which may answer after the edge stopped waiting.
      partAnswers.set(
        '/|/_tree',
        handedOnAs('passthrough;reason=middleware-failed;cause=timeout', RSC),
      );
      const outrun = await checkStack(covered);

      expect(uncovered.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, handed on, as the middleware failed, though no matcher of the build covers the request (x-arkor-edge: passthrough;reason=middleware-failed;cause=threw)',
        },
      ]);
      expect(answered.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, handed on, as the middleware failed, though the stack kept what it answered (x-arkor-edge: passthrough;reason=middleware-failed;cause=threw)',
        },
      ]);
      expect(outrun.failures).toStrictEqual([]);
    });

    it('fails where it is handed on as its route is off the edge, as no document of the stack is', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const offOf = async (reason: string) => {
        partAnswers.set('/|/_tree', handedOnAs(`passthrough;reason=${reason}`, RSC));
        const { failures } = await checkStack(stackOf(routes, {}));
        return failures.map((failure) => failure.reason);
      };

      await expect(offOf('demoted')).resolves.toStrictEqual([
        "its prefetch segment /_tree, handed on, as its route is demoted, though the stack's pointer demotes none (x-arkor-edge: passthrough;reason=demoted)",
      ]);
      await expect(offOf('suspect')).resolves.toStrictEqual([
        'its prefetch segment /_tree, handed on, as its route is condemned in the isolate, for a mismatch the edge met in a document of it (x-arkor-edge: passthrough;reason=suspect)',
      ]);
      await expect(offOf('pattern-budget')).resolves.toStrictEqual([
        "its prefetch segment /_tree, handed on, for a pattern of the application's too costly to run against the request, as a document so handed on fails (x-arkor-edge: passthrough;reason=pattern-budget)",
      ]);
    });

    it('is asked from the page itself too, as a rule may claim it from the front page alone', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // A rule ahead of the filesystem that claims the router's requests from the front page.
      const fromFront: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'next-url', value: '^/$' }],
      };
      answers.set('/about', finishedAnswer(finished, '/about'));
      // Claimed from the front page, and handed on so; from the page itself, answered from storage.
      partAnswers.set(
        '/about|/_tree|from=/',
        handedOnAs('passthrough;reason=segment-prefetch', RSC),
      );
      partAnswers.set('/about|/_tree', segmentAnswer('other bytes'));
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [fromFront] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its prefetch segment /_tree, from the page itself, answered 11 bytes other than the 10 the build wrote',
        },
      ]);
    });

    it('is asked with its origin alone as the referrer too, as a page under such a policy asks', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      partAnswers.set('/about|/_tree', segmentAnswer('tree bytes'));
      const result = await checkStack(stackOf(routes, {}));
      // What the router on the page itself said of it, of each segment request it made.
      const each = partsAskedEach.get('/about|/_tree') ?? [];
      const fromPage = each.filter((headers) => headers['next-url'] === '/about');

      expect(result.failures).toStrictEqual([]);
      expect(fromPage.map((headers) => headers.referer)).toContainEqual(
        expect.stringMatching(/^https:\/\/[^/]+\/$/u),
      );
    });

    it("is the application's where its middleware asks for another part of the page", async () => {
      const routes = [
        await routeOf('/', FRONT, {
          segments: { '/_tree': 'tree bytes', '/_index': 'index bytes' },
        }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      // A middleware that sees the router's headers, and asks for the page's index in the place of
      // its tree — which the edge then answers with.
      decidedForSegment.set('/|/_tree', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'rsc,next-router-prefetch,next-router-segment-prefetch',
        'x-middleware-request-rsc': '1',
        'x-middleware-request-next-router-prefetch': '1',
        'x-middleware-request-next-router-segment-prefetch': '/_index',
      });
      partAnswers.set('/|/_tree', segmentBehindMiddleware('index bytes'));
      partAnswers.set('/|/_index', segmentBehindMiddleware('index bytes'));
      const result = await checkStack(
        withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]),
      );

      expect(result.failures).toStrictEqual([]);
    });

    it("is the application's where its middleware asks for a segment the build did not write, which the edge hands on", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      // A middleware that sees the router's headers, and asks for a segment of its own in the
      // place of the tree — which the edge hands on for want of it.
      decidedForSegment.set('/|/_tree', {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'rsc,next-router-prefetch,next-router-segment-prefetch',
        'x-middleware-request-rsc': '1',
        'x-middleware-request-next-router-prefetch': '1',
        'x-middleware-request-next-router-segment-prefetch': '/_other',
      });
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=segment-prefetch;mw=hit', RSC));
      // A policy that serves from no record: the edge answers the route's parts from the build.
      const offPolicy = {
        ...DEFAULT_DELIVERY_POLICY,
        id: 'default',
        runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'off' as const },
      };
      const stack = withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]);
      const result = await checkStack({ ...stack, policy: offPolicy });

      expect(result.failures).toStrictEqual([]);
    });

    it('fails where a segment is marked from the cache, which none but the application marks one', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'x-nextjs-cache': 'HIT' },
      });
      const invented = await checkStack(stackOf(routes, {}));
      // A rule that marks the page so, which the edge keeps on its segments too.
      const marking: HeaderRule = { sourceRegex: '^/$', headers: { 'x-nextjs-cache': 'HIT' } };
      const marked = await checkStack(stackOf(routes, {}, { headerRules: [marking] }));

      expect(invented.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with x-nextjs-cache HIT, which marks no segment',
        },
      ]);
      expect(marked.failures).toStrictEqual([]);
    });

    it("is asked with its navigation's cookies kept to each path above its page's, too", async () => {
      const routes = [
        await routeOf('/account/page', finished, {
          complete: true,
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/account/page$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'session' }],
      };
      // The middleware sets another session under the path above the page's.
      const renewed = 'session=new; Path=/account';
      decisions.set('/account/page', { 'x-middleware-next': '1', 'set-cookie': renewed });
      const document = finishedAnswer(finished, '/account/page');
      answers.set(
        '/account/page',
        claimedWithout(
          { ...document, headers: { ...document.headers, 'set-cookie': [renewed] } },
          'session',
        ),
      );
      const tree = segmentBehindMiddleware('tree bytes');
      partAnswers.set('/account/page|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'set-cookie': [renewed] },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [signedOut] }));
      const sent = (partsAskedEach.get('/account/page|/_tree') ?? []).map(
        (headers) => headers.cookie,
      );

      expect(result.failures).toStrictEqual([]);
      // As a browser that kept the session under /account sends it: the new one in its place.
      expect(sent).toContain('session=new');
    });

    it('is asked for though every navigation of its page is claimed, as a rule may claim documents alone', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // A rule that claims the page's documents, and none of its router's requests.
      const documents: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [{ type: 'header', key: 'rsc' }],
      };
      // Its documents handed on as claimed, in every coding; its segment answered from storage.
      answers.set('/about', handedOnAs('passthrough;reason=route-not-proved'));
      partAnswers.set('/about|/_tree', segmentAnswer('other bytes'));
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [documents] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its prefetch segment /_tree, answered 11 bytes other than the 10 the build wrote',
        },
      ]);
    });

    it('is asked from the front page without the cookies its own document sets', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // The middleware sets a cookie on the page's document, and on its every part.
      const seen = 'seen=1; Path=/';
      decisions.set('/about', { 'x-middleware-next': '1', 'set-cookie': seen });
      const document = finishedAnswer(finished, '/about');
      answers.set('/about', {
        ...document,
        headers: { ...document.headers, 'set-cookie': [seen] },
      });
      const tree = segmentBehindMiddleware('tree bytes');
      partAnswers.set('/about|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'set-cookie': [seen] },
      });
      const result = await checkStack(stackOf(routes, {}));
      const each = partsAskedEach.get('/about|/_tree') ?? [];
      const fromFront = each.filter((headers) => headers['next-url'] === '/');

      expect(result.failures).toStrictEqual([]);
      // A client-side navigation from the front page, which fetched none of the page's document.
      expect(fromFront.map((headers) => headers.cookie)).toContain(undefined);
    });

    it("is held to its middleware's cookie as the edge scopes it to the site's hostname, and to none of the edge's own headers", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The middleware sets a cookie on the tree alone, for every host of a domain the stack's own
      // hostname is not in, which the edge takes off.
      const set = 'seen=1; Domain=example.com; Path=/';
      decidedForSegment.set('/about|/_tree', { 'x-middleware-next': '1', 'set-cookie': set });
      const tree = segmentBehindMiddleware('tree bytes');
      partAnswers.set('/about|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'set-cookie': ['seen=1; Path=/'] },
      });
      const scoped = await checkStack(stackOf(routes, {}));
      partAnswers.set('/about|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'set-cookie': [set] },
      });
      const unscoped = await checkStack(stackOf(routes, {}));
      // Under a hostname of that domain, which keeps it.
      const named = await checkStack(stackOf(routes, {}), { hostname: 'www.example.com' });
      // A header of the edge's own, which it sends none of a middleware's.
      decidedForSegment.set('/about|/_tree', { 'x-middleware-next': '1', 'x-arkor-note': 'set' });
      partAnswers.set('/about|/_tree', tree);
      const unmarked = await checkStack(stackOf(routes, {}));

      expect(scoped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unscoped.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its prefetch segment /_tree, answered without the cookie seen=1; Path=/ the application set',
        },
      ]);
      expect(named).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unmarked).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("is held to a rule's cookie as the edge scopes it to the site's hostname", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A rule that sets a cookie on a segment prefetch, for every host of a domain the stack's own
      // hostname is not in, which the edge takes off.
      const set = 'ruled=1; Domain=example.com; Path=/';
      const setting: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'header', key: 'next-router-segment-prefetch' },
        ],
        headers: { 'set-cookie': set },
      };
      const tree = segmentAnswer('tree bytes');
      const gated = { ...tree.headers, 'cache-control': GATED };
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...gated, 'set-cookie': 'ruled=1; Path=/' },
      });
      const scoped = await checkStack(stackOf(routes, {}, { headerRules: [setting] }));
      partAnswers.set('/|/_tree', { ...tree, headers: { ...gated, 'set-cookie': set } });
      const unscoped = await checkStack(stackOf(routes, {}, { headerRules: [setting] }));

      expect(scoped).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unscoped.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered without the cookie ruled=1; Path=/ the application set',
        },
      ]);
    });

    it('is asked with each jar the parts leave the browser in, whatever order it asks them in', async () => {
      const routes = [
        await routeOf('/', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes', '/_index': 'index bytes' },
        }),
      ];
      // Each segment sets a cookie of its own, and a rule marks a payload asked with the later's
      // alone — which a browser that asks for the later segment first holds.
      const later: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'b' },
        ],
        missing: [
          { type: 'header', key: 'next-router-segment-prefetch' },
          { type: 'cookie', key: 'a' },
        ],
        headers: { 'x-later': 'yes' },
      };
      const rules = [
        segmentCookieRule('/_tree', 'a=1; Path=/'),
        segmentCookieRule('/_index', 'b=1; Path=/'),
      ];
      answers.set('/', finishedAnswer(finished, '/'));
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED, 'set-cookie': 'a=1; Path=/' },
      });
      const index = segmentAnswer('index bytes');
      partAnswers.set('/|/_index', {
        ...index,
        headers: { ...index.headers, 'cache-control': GATED, 'set-cookie': 'b=1; Path=/' },
      });
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT', 'cache-control': GATED }),
      );
      const result = await checkStack(stackOf(routes, {}, { headerRules: [...rules, later] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, with the cookies set by its prefetch segment /_index, answered with x-later none, not the yes the application set',
        },
      ]);
    });

    it('keeps the cookies of the redirects a part is answered with, as a browser follows them', async () => {
      const routes = [
        await routeOf('/', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      // The middleware redirects the segment to a page that sets a session, and a rule marks a
      // payload asked with one.
      const signedIn: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'sid' },
        ],
        missing: [{ type: 'header', key: 'next-router-segment-prefetch' }],
        headers: { 'x-signed-in': 'yes' },
      };
      answers.set('/', finishedAnswer(finished, '/'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/login', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      answers.set('/login', { headers: { 'set-cookie': 'sid=1; Path=/' }, body: '' });
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT', 'cache-control': GATED }),
      );
      const result = await checkStack(stackOf(routes, {}, { headerRules: [signedIn] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, with the cookies set by its prefetch segment /_tree, answered with x-signed-in none, not the yes the application set',
        },
      ]);
    });

    it('is composed in every coding where its bypassFor asks for one the front line sets none of', async () => {
      const route = await routeOf('/', FRONT);
      // A route Next.js renders itself for a request that accepts nothing coded — which none
      // reaches the edge as, Cloudflare's front line handing each on accepting what it sets.
      const identityOnly = { type: 'header' as const, key: 'accept-encoding', value: 'identity' };
      const routes = [{ ...route, bypassFor: [identityOnly] }];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // In brotli, answered from a shell other than the route's.
      answers.set('/|br', documentAnswer(ABOUT, 'mw=miss;route=/'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures[0]?.reason).toMatch(/^asked for in br, /u);
    });

    it("fails where its parts' answers leave a browser in more jars than the check follows", async () => {
      const paths = ['/_a', '/_b', '/_c', '/_d', '/_e', '/_f'];
      const segments = Object.fromEntries(paths.map((at) => [at, `${at} bytes`]));
      const routes = [await routeOf('/', FRONT, { segments })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // Each segment sets a cookie of its own: as many jars as there are sets of them, 64.
      const rules = paths.map((at) => segmentCookieRule(at, `c${at.slice(2)}=1; Path=/`));
      for (const at of paths) {
        const answer = segmentAnswer(`${at} bytes`);
        partAnswers.set(`/|${at}`, {
          ...answer,
          headers: {
            ...answer.headers,
            'cache-control': GATED,
            'set-cookie': `c${at.slice(2)}=1; Path=/`,
          },
        });
      }
      const result = await checkStack(stackOf(routes, {}, { headerRules: rules }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its parts' answers leave a browser holding more than 32 sets of cookies, more than the check follows: no request proves the others",
        },
      ]);
    });

    it('follows a redirect again from each jar, as the cookies sent to where it leads may differ', async () => {
      const routes = [
        await routeOf('/', finished, {
          complete: true,
          payload: 'payload bytes',
          segments: { '/_tree': 'tree bytes', '/_index': 'index bytes' },
        }),
      ];
      // The tree redirected to a page that sets a session only for a visitor with a cookie kept
      // under its own path, which the index sets — and a rule that marks a payload asked with one.
      const signedIn: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'sid' },
        ],
        missing: [{ type: 'header', key: 'next-router-segment-prefetch' }],
        headers: { 'x-signed-in': 'yes' },
      };
      const loginOnly = 'seen=1; Path=/login';
      answers.set('/', finishedAnswer(finished, '/'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/login', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      const index = segmentAnswer('index bytes');
      partAnswers.set('/|/_index', {
        ...index,
        headers: { ...index.headers, 'cache-control': GATED, 'set-cookie': loginOnly },
      });
      answers.set('/login', {
        headers: {},
        body: '',
        withCookie: { name: 'seen', headers: { 'set-cookie': 'sid=1; Path=/' } },
      });
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT', 'cache-control': GATED }),
      );
      const rules = [segmentCookieRule('/_index', loginOnly), signedIn];
      const result = await checkStack(stackOf(routes, {}, { headerRules: rules }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, with the cookies set by its prefetch segment /_index, then its prefetch segment /_tree, answered with x-signed-in none, not the yes the application set',
        },
      ]);
    });

    it('is asked from another page of the build, as a rule may claim it from the front page and the page itself', async () => {
      const routes = [
        await routeOf('/', FRONT),
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      // A rule ahead of the filesystem that claims the router's requests from those two alone.
      const fromKnown: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'next-url', value: '^/(about)?$' }],
      };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/shop', documentAnswer(FRONT, 'mw=miss;route=/shop'));
      answers.set('/about', finishedAnswer(finished, '/about'));
      // Claimed from those two, and handed on so; from the shop, answered from storage.
      const handedOn = handedOnAs('passthrough;reason=segment-prefetch', RSC);
      partAnswers.set('/about|/_tree|from=/', handedOn);
      partAnswers.set('/about|/_tree|from=/about', handedOn);
      partAnswers.set('/about|/_tree', segmentAnswer('other bytes'));
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [fromKnown] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its prefetch segment /_tree, from /shop, answered 11 bytes other than the 10 the build wrote',
        },
      ]);
    });

    it('checks a router failure specific to the second other page', async () => {
      const routes = [
        await routeOf('/', FRONT),
        await routeOf('/a', FRONT),
        await routeOf('/b', FRONT),
        await routeOf('/target', finished, {
          complete: true,
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      for (const pathname of ['/', '/a', '/b']) {
        answers.set(pathname, documentAnswer(FRONT, `mw=miss;route=${pathname}`));
      }
      answers.set('/target', finishedAnswer(finished, '/target'));
      partAnswers.set('/target|/_tree', segmentAnswer('tree bytes'));
      partAnswers.set('/target|/_tree|from=/b', segmentAnswer('other bytes'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/target',
          reason:
            'its prefetch segment /_tree, from /b, answered 11 bytes other than the 10 the build wrote',
        },
      ]);
      expect(partsAskedEach.get('/target|/_tree')).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ 'next-url': '/a' }),
          expect.objectContaining({ 'next-url': '/b' }),
        ]),
      );
    });

    it("has the parts of the page a browser's navigation redirected to asked with the cookies on the way", async () => {
      const routes = [
        await routeOf('/about', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // The middleware redirects the page to a login, saying where the visitor came from.
      answers.set('/about', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'from=about; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      answers.set('/login', finishedAnswer(finished, '/login'));
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/login|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED },
      });
      // A rule that marks the login's segment for a visitor who came by the redirect.
      const redirected: HeaderRule = {
        sourceRegex: '^/login$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'from' },
        ],
        headers: { 'x-from': 'yes' },
      };
      const result = await checkStack(stackOf(routes, {}, { headerRules: [redirected] }));

      // And the login's own, asked from the page a visit to which redirected there.
      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'redirected to /login, its prefetch segment /_tree, from the page itself, answered with x-from none, not the yes the application set',
        },
        {
          path: '/login',
          reason:
            'its prefetch segment /_tree, from /about, landing on /login, answered with x-from none, not the yes the application set',
        },
      ]);
    });

    it("has the document of the page a browser's navigation redirected to judged as the browser asked it", async () => {
      const routes = [
        await routeOf('/about', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true }),
      ];
      // The middleware redirects the page to a login, saying where the visitor came from.
      answers.set('/about', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'from=about; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      // The login, composed under another type for a visitor who came by the redirect.
      answers.set('/login', {
        ...finishedAnswer(finished, '/login'),
        withCookie: { name: 'from', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(/^redirected to \/login, .*text\/plain/u);
    });

    it('judges the first redirected document even when a later request would succeed', async () => {
      const routes = [
        await routeOf('/about', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true }),
      ];
      answers.set('/about', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'from=about; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      const seen = { redirected: 0 };
      answers.set('/login', {
        ...finishedAnswer(finished, '/login'),
        when: {
          test: (headers, method) => {
            const cookie = headers.cookie;
            if (method !== 'GET' || typeof cookie !== 'string' || !cookie.includes('from=about')) {
              return false;
            }
            seen.redirected += 1;
            return seen.redirected === 1;
          },
          status: 500,
        },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(/^redirected.* to \/login, answered 500$/u);
    });

    it.each([200, 500])(
      'retains the original document verdict after its trace is released: %s',
      async (status) => {
        const routes = [await routeOf('/login', finished, { complete: true })];
        const stack = { ...stackOf(routes, {}), site: new URL('https://site.example') };
        answers.set('/login', { ...finishedAnswer(finished, '/login'), status });
        const answer = requiredCapturedDocument(
          await documentAnswerAt(
            stack,
            Buffer.byteLength(finished),
            {
              url: new URL('/login', stack.site),
              headers: { 'accept-encoding': BROWSER_CODINGS },
            },
            BROWSER_CODINGS,
          ),
        );
        // A later GET would answer the opposite; the deferred verdict must use neither that GET nor
        // a trace already disposed of by capturedDocument.
        answers.set('/login', {
          ...finishedAnswer(finished, '/login'),
          status: status === 200 ? 500 : 200,
        });

        expect(traceIds.letGo.size).toBe(1);
        await expect(answer.documentFailure?.()).resolves.toBe(
          status === 200 ? undefined : 'answered 500',
        );
        expect(askedHeadersEach.get('/login')).toHaveLength(1);
        expect(traceIds.read.size).toBe(1);
      },
    );

    it("has the document a browser's navigation redirected to judged where the edge's account of it says no route", async () => {
      const routes = [
        await routeOf('/about', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true }),
      ];
      // The middleware redirects the page to a login, saying where the visitor came from.
      answers.set('/about', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'from=about; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      // The login, answered to a visitor who came so under an account that names no route.
      answers.set('/login', {
        ...finishedAnswer(finished, '/login'),
        withCookie: { name: 'from', headers: { 'x-arkor-edge': 'shell;strategy=edge' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'redirected to /login, not answered under the delivery policy default (x-arkor-edge: shell;strategy=edge)',
        },
      ]);
    });

    it('takes a page a navigation redirected to by a name its URL escapes as the route it is', async () => {
      const routes = [
        await routeOf('/about', ABOUT, { complete: true }),
        await routeOf('/a b', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // A rule behind the filesystem, which claims a request for no route of the build's own.
      const behind: ReservedRoute = { sourceRegex: '^/(?:.+)$' };
      // The page as its URL names it, its space escaped.
      const spaced = '/a%20b';
      answers.set('/about', {
        status: 307,
        headers: { location: spaced, 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      answers.set(spaced, finishedAnswer(finished, '/a b'));
      partAnswers.set(`${spaced}|/_tree`, segmentAnswer('other bytes'));
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [behind] }));

      // Its parts the edge answers from storage, which the rule claims none of: wherever the
      // navigation came from.
      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason: `redirected to ${spaced}, its prefetch segment /_tree, answered 11 bytes other than the 10 the build wrote`,
        },
        {
          path: '/a b',
          reason:
            'its prefetch segment /_tree, answered 11 bytes other than the 10 the build wrote',
        },
      ]);
    });

    it('keeps the cookies a navigation was sent with for the page it asked for, past a redirect to another', async () => {
      const routes = [
        await routeOf('/account', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one — a
      // session a browser may keep for the page alone.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/account$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'sid' }],
      };
      // The middleware redirects the page to a login, saying where the visitor came from.
      answers.set('/account', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'from=account; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      answers.set('/login', finishedAnswer(finished, '/login'));
      // The login's tree, answered from storage under another type to a visitor who came so and
      // sends it no session.
      partAnswers.set('/login|/_tree', {
        ...segmentAnswer('tree bytes'),
        when: {
          test: (headers) => carryingEach('from')(headers) && !carryingEach('sid')(headers),
          headers: { 'content-type': 'text/plain' },
        },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [signedOut] }));

      // And the login's own, asked from the page a visit to which redirected there.
      expect(result.failures).toStrictEqual([
        {
          path: '/account',
          reason:
            "redirected to /login, its prefetch segment /_tree, from the page itself, its navigation's cookies kept to its page's path, answered as text/plain, not text/x-component",
        },
        {
          path: '/login',
          reason:
            'its prefetch segment /_tree, from /account, landing on /login, answered as text/plain, not text/x-component',
        },
      ]);
    });

    it('is asked from the page itself only after the navigations of it that stayed on it', async () => {
      const routes = [
        await routeOf('/account', finished, {
          complete: true,
          segments: { '/_tree': 'tree bytes' },
        }),
      ];
      // A navigation from a page of the site's own origin, which the middleware redirects to a login,
      // starting a flow.
      answers.set('/account', {
        ...finishedAnswer(finished, '/account'),
        when: {
          test: navigatedFromOwnOrigin,
          status: 307,
          headers: {
            location: '/login',
            'set-cookie': 'flow=1; Path=/',
            'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
          },
        },
      });
      // The page's tree, answered from storage under another type to a visitor in the flow — which no
      // browser on the page is.
      partAnswers.set('/account|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'flow', headers: { 'content-type': 'text/plain' } },
      });

      await expect(checkStack(stackOf(routes, {}))).resolves.toStrictEqual({
        checked: 1,
        failures: [],
        skipped: [],
      });
    });

    it("follows a navigation's redirects from each way a browser may keep the cookies it was sent with", async () => {
      const routes = [
        await routeOf('/account', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true }),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/account$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'sid' }],
      };
      // The middleware redirects the page to a login, starting a flow kept for the login alone.
      answers.set('/account', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'flow=1; Path=/login',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      // The login, composed under another type for a visitor in the flow who sends it no session.
      answers.set('/login', {
        ...finishedAnswer(finished, '/login'),
        when: {
          test: (headers) => carryingEach('flow')(headers) && !carryingEach('sid')(headers),
          headers: { 'content-type': 'text/plain' },
        },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [signedOut] }));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.path).toBe('/account');
      expect(result.failures[0]?.reason).toMatch(
        /^redirected to \/login, its navigation's cookies kept to its page's path, .*text\/plain/u,
      );
    });

    it('is asked from another page with the cookies a visit to that page sets', async () => {
      const routes = [
        await routeOf('/', FRONT),
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      // The middleware sets a cookie on the shop's document.
      const source = 'source=1; Path=/';
      decisions.set('/shop', { 'x-middleware-next': '1', 'set-cookie': source });
      const shop = documentAnswer(FRONT, 'mw=hit;route=/shop');
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/shop', { ...shop, headers: { ...shop.headers, 'set-cookie': [source] } });
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The about page's tree, answered from storage under another type to a visitor who came by
      // the shop.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'source', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its prefetch segment /_tree, from /shop, answered as text/plain, not text/x-component',
        },
      ]);
    });

    it('is asked from the page a visit to another redirected to, with the cookies on the way', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The middleware redirects the shop to the about page, saying the visitor came by the shop.
      answers.set('/shop', {
        status: 307,
        headers: {
          location: '/about',
          'set-cookie': 'source=shop; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      // The about page's tree, answered from storage under another type to a visitor who came so.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'source', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      // Asked from the page a visit to the shop left the browser on — and as the shop's own
      // navigation lands there.
      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its prefetch segment /_tree, from /shop, landing on /about, answered as text/plain, not text/x-component',
        },
        {
          path: '/shop',
          reason:
            'redirected to /about, its prefetch segment /_tree, from the page itself, answered as text/plain, not text/x-component',
        },
      ]);
    });

    it('is not asked from another page whose every visit leaves for no page of the build', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The shop always redirects to a page the build holds none of.
      answers.set('/shop', {
        status: 307,
        headers: { location: '/gone', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      // The about page's tree, answered as no part from the shop — a page no browser is on.
      partAnswers.set('/about|/_tree', segmentAnswer('tree bytes'));
      partAnswers.set('/about|/_tree|from=/shop', segmentAnswer('other bytes'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
    });

    it('is not asked from another page the application answers with no page a router runs on', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The middleware answers the shop with JSON, which no router runs on.
      answers.set('/shop', {
        headers: {
          'content-type': JSON_TYPE,
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '{}',
      });
      // The about page's tree, answered as no part from the shop — a page no browser's router is on.
      partAnswers.set('/about|/_tree', segmentAnswer('tree bytes'));
      partAnswers.set('/about|/_tree|from=/shop', segmentAnswer('other bytes'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
    });

    it('is not asked from another page the application answers with a not-found of no page', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The middleware answers the shop with JSON, saying it found nothing, which no router runs on.
      answers.set('/shop', {
        status: 404,
        headers: {
          'content-type': JSON_TYPE,
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '{}',
      });
      // The about page's tree, answered as no part from the shop — a page no browser's router is on.
      partAnswers.set('/about|/_tree', segmentAnswer('tree bytes'));
      partAnswers.set('/about|/_tree|from=/shop', segmentAnswer('other bytes'));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
    });

    it('is not asked from a page a navigation landed on that no router runs on', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      // The middleware redirects the shop to the about page, saying so, and answers the about page
      // with JSON to a visitor who came so — which no router runs on.
      answers.set('/shop', {
        status: 307,
        headers: {
          location: '/about',
          'set-cookie': 'via=shop; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      answers.set('/about', {
        ...finishedAnswer(finished, '/about'),
        withCookie: {
          name: 'via',
          headers: {
            'content-type': JSON_TYPE,
            'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
          },
        },
      });
      // The about page's tree, answered as no part to a visitor who came so, whom no router asks for it.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'via', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
    });

    it('is not asked after a navigation of the page the application answered with no page a router runs on', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // The middleware answers Chrome's typed navigation with JSON, and a cookie of its own.
      answers.set('/about', {
        ...finishedAnswer(finished, '/about'),
        when: {
          test: typedByChrome,
          headers: {
            'content-type': JSON_TYPE,
            'set-cookie': 'api=1; Path=/',
            'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
          },
        },
      });
      // The tree, answered as no part to a visitor holding that cookie — whom no router asks for it.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'api', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
    });

    it("is asked from another page as another site's navigation reaches it, without cookies kept from those", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one.
      const signedOut: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'sid' }],
      };
      answers.set('/about', claimedWithout(finishedAnswer(finished, '/about'), 'sid'));
      // The shop marks a visitor who sends it no session.
      const anonymous = 'anon=1; Path=/';
      decisions.set('/shop', { 'x-middleware-next': '1', 'set-cookie': anonymous });
      answers.set('/shop', {
        ...documentAnswer(FRONT, 'mw=hit;route=/shop'),
        when: {
          test: (headers) => !carryingEach('sid')(headers),
          headers: { 'set-cookie': [anonymous] },
        },
      });
      // The about page's tree, answered as no part to a visitor so marked.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'anon', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [signedOut] }));

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, from \/shop, having navigated to it from another site's page, its cookie sid kept from other sites' navigations, .*text\/plain/u,
      );
    });

    it("is asked from another page as another site's navigation reaches it, without each set of its cookies kept from those", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      answers.set('/about', claimedWithout(finishedAnswer(finished, '/about'), 'a', 'b'));
      // The shop marks a visitor who sends it the second cookie without the first.
      const marked = 'mark=1; Path=/';
      decisions.set('/shop', { 'x-middleware-next': '1', 'set-cookie': marked });
      answers.set('/shop', {
        ...documentAnswer(FRONT, 'mw=hit;route=/shop'),
        when: {
          test: (headers) => carryingEach('b')(headers) && !carryingEach('a')(headers),
          headers: { 'set-cookie': [marked] },
        },
      });
      // The about page's tree, answered as no part to a visitor so marked.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'mark', headers: { 'content-type': 'text/plain' } },
      });
      // The page claimed for a visitor without either cookie, which the check asks past with both.
      const rules = [aboutWithout('a'), aboutWithout('b')];
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: rules }));

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, from \/shop, having navigated to it from another site's page, its cookie a kept from other sites' navigations, .*text\/plain/u,
      );
    });

    it("is asked from another page as a browser visits it, asking for an upgrade as every browser's navigation does", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The shop marks a visitor whose browser asks for pages over HTTPS, as each browser's
      // navigation does (`Upgrade-Insecure-Requests`).
      const marked = 'mark=1; Path=/';
      decisions.set('/shop', { 'x-middleware-next': '1', 'set-cookie': marked });
      answers.set('/shop', {
        ...documentAnswer(FRONT, 'mw=hit;route=/shop'),
        when: {
          test: (headers) => headers['upgrade-insecure-requests'] === '1',
          headers: { 'set-cookie': [marked] },
        },
      });
      // The about page's tree, answered as no part to a visitor so marked.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'mark', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, from \/shop, .*text\/plain/u,
      );
    });

    it('is asked from another page as a browser visits it, carrying nothing the check carried to the page itself', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      // The page's documents claimed for a visitor without a header no browser sends, which the
      // check asks past with it — and none of its parts.
      const passless: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        missing: [
          { type: 'header', key: 'x-pass' },
          { type: 'header', key: 'rsc' },
        ],
      };
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The shop marks a visitor who sends it no such header.
      const marked = 'mark=1; Path=/';
      decisions.set('/shop', { 'x-middleware-next': '1', 'set-cookie': marked });
      answers.set('/shop', {
        ...documentAnswer(FRONT, 'mw=hit;route=/shop'),
        when: {
          test: (headers) => headers['x-pass'] === undefined,
          headers: { 'set-cookie': [marked] },
        },
      });
      // The about page's tree, answered as no part to a visitor so marked.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'mark', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [passless] }));

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, from \/shop, .*text\/plain/u,
      );
    });

    it.each([200, 404])(
      'does not invent router requests for middleware-owned HTML with status %s',
      async (status) => {
        const front = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
        const account = 'passthrough;reason=middleware;mw=hit';
        answers.set('/', {
          status,
          headers: { 'content-type': HTML, 'x-arkor-edge': account },
          body: '<!doctype html><html><body>application-owned page</body></html>',
        });
        partAnswers.set('/|/_tree', {
          status: 500,
          headers: { 'content-type': TEXT, 'x-arkor-edge': 'segment;mw=miss' },
          body: 'this HTML has no client router',
        });
        const result = await checkStack(stackOf([front], {}));

        expect(result.failures).toStrictEqual([]);
        expect(result.skipped).toStrictEqual([
          { path: '/', reason: `answered by the application's middleware (${account})` },
        ]);
        expect(partsAsked.size).toBe(0);
      },
    );

    it.each([200, 404])(
      'does not use middleware-owned HTML status %s as a router origin for another page',
      async (status) => {
        const routes = [
          await routeOf('/about', finished, {
            complete: true,
            segments: { '/_tree': 'tree bytes' },
          }),
          await routeOf('/shop', FRONT),
        ];
        answers.set('/about', finishedAnswer(finished, '/about'));
        answers.set('/shop', {
          status,
          headers: {
            'content-type': HTML,
            'set-cookie': 'mark=1; Path=/',
            'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
          },
          body: '<!doctype html><html><body>application-owned page</body></html>',
        });
        partAnswers.set('/about|/_tree', {
          ...segmentAnswer('tree bytes'),
          withCookie: { name: 'mark', headers: { 'content-type': TEXT } },
        });
        const result = await checkStack(stackOf(routes, {}));
        const requests = partsAskedEach.get('/about|/_tree');

        expect(result.failures).toStrictEqual([]);
        expect(requests).toBeDefined();
        expect(requests?.some((headers) => headers.cookie?.includes('mark=1') === true)).toBe(
          false,
        );
      },
    );

    it('is asked from no page whose answer is of a type that only begins as HTML does', async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/shop', FRONT),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The shop answered by its middleware as `text/htmlx`, a type of its own, which no router runs
      // on — marking the visitor all the same.
      const marked = 'mark=1; Path=/';
      decisions.set('/shop', { 'x-middleware-next': '1', 'set-cookie': marked });
      const shop = documentAnswer(FRONT, 'mw=hit;route=/shop');
      answers.set('/shop', {
        ...shop,
        headers: { ...shop.headers, 'content-type': 'text/htmlx', 'set-cookie': [marked] },
      });
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'mark', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures.filter((failure) => failure.path === '/about')).toStrictEqual([]);
    });

    it("is asked carrying Priority where a rule claims a part without it, as a browser's HTTP/2 fetch sends one", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      answers.set('/about', finishedAnswer(finished, '/about'));
      // The router's requests claimed where they carry no Priority, which no request of the stack's
      // own does — and the tree as the edge serves it otherwise, under another type.
      const priorityless: ReservedRoute = {
        sourceRegex: '^/about$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'rsc', value: '1' }],
        missing: [{ type: 'header', key: 'priority' }],
      };
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        claimedWhen: (headers) => headers['priority'] === undefined,
        withHeader: { name: 'priority', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [priorityless] }));

      // Asked past the rule as a browser's HTTP/2 or HTTP/3 fetch is, which carries one.
      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its prefetch segment /_tree, carrying priority: 1, answered as text/plain, not text/x-component',
        },
      ]);
    });

    it("is asked after another site's navigation of the page itself, without each of its cookies kept from it", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // The page claimed for a visitor with no session, which the check asks past with one — and
      // which the Function, handed one another site sent there without it (`SameSite=Strict`),
      // answers marking the visitor.
      const marked = 'mark=1; Path=/';
      answers.set('/about', {
        ...claimedWithout(finishedAnswer(finished, '/about'), 'session'),
        when: {
          test: (headers) =>
            headers['sec-fetch-site'] === 'cross-site' && !carryingEach('session')(headers),
          headers: { 'set-cookie': [marked] },
        },
      });
      // The tree, answered as no part to a visitor so marked.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'mark', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(
        stackOf(routes, {}, { reservedRoutes: [aboutWithout('session')] }),
      );

      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, from the page itself, navigated from another site's page, its cookie session kept from other sites' navigations, .*text\/plain/u,
      );
    });

    it("is asked after each place a browser's navigation of the page comes from, with what each set", async () => {
      const routes = [
        await routeOf('/about', finished, { complete: true, segments: { '/_tree': 'tree bytes' } }),
      ];
      // The middleware sets a cookie on a navigation from a page of the site's own origin alone.
      const own = 'ctx=own; Path=/';
      decidedFromSite.set('/about|same-origin', { 'x-middleware-next': '1', 'set-cookie': own });
      answers.set('/about', {
        ...finishedAnswer(finished, '/about'),
        when: { test: navigatedFromOwnOrigin, headers: { 'set-cookie': [own] } },
      });
      // The tree, answered from storage under another type to a visitor holding that cookie.
      partAnswers.set('/about|/_tree', {
        ...segmentAnswer('tree bytes'),
        withCookie: { name: 'ctx', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            'its prefetch segment /_tree, from the page itself, navigated from a page of its own origin, answered as text/plain, not text/x-component',
        },
      ]);
    });

    it('follows a navigation through its redirects under the referrer policy each sets', async () => {
      const routes = [
        await routeOf('/about', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true }),
      ];
      // The middleware redirects the page to a login, under a policy that has the next request say
      // nowhere it came from.
      answers.set('/about', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'from=about; Path=/',
          'referrer-policy': 'no-referrer',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      // The login, composed under another type for a visitor who came so from a page of the site's
      // own origin, saying nothing of which.
      answers.set('/login', {
        ...finishedAnswer(finished, '/login'),
        when: {
          test: (headers) => {
            return (
              carryingEach('from')(headers) &&
              headers['sec-fetch-site'] === 'same-origin' &&
              headers.referer === undefined
            );
          },
          headers: { 'content-type': 'text/plain' },
        },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^redirected by Chrome, from a page of its own origin to \/login, .*text\/plain/u,
      );
    });

    it("follows another site's navigation through its redirects without the cookies kept from other sites", async () => {
      const routes = [
        await routeOf('/about', ABOUT, { complete: true }),
        await routeOf('/login', finished, { complete: true }),
      ];
      // The middleware redirects the page to a login, setting a cookie kept from other sites'
      // navigations, and one that is not.
      answers.set('/about', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': ['strict=1; Path=/; SameSite=Strict', 'lax=1; Path=/'],
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      // The login, composed under another type for a visitor who came so without the strict one.
      answers.set('/login', {
        ...finishedAnswer(finished, '/login'),
        when: {
          test: (headers) => carryingEach('lax')(headers) && !carryingEach('strict')(headers),
          headers: { 'content-type': 'text/plain' },
        },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.path).toBe('/about');
      expect(result.failures[0]?.reason).toMatch(
        /^redirected by Chrome, from another site's page to \/login, .*text\/plain/u,
      );
    });

    it("fails where a browser's navigation of the page redirects past as many as it follows", async () => {
      const routes = [await routeOf('/about', ABOUT, { complete: true })];
      // The middleware redirects the page to itself, and on.
      answers.set('/about', {
        status: 307,
        headers: { location: '/about', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/about',
          reason:
            "its navigation, redirected past the 20 redirects a browser's fetch follows, where it fails",
        },
      ]);
    });

    it('rejects a part redirect to a Location no browser can read', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: 'http://[', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });

      await expect(checkStack(stackOf(routes, {}))).resolves.toStrictEqual({
        checked: 1,
        failures: [
          {
            path: '/',
            reason: 'its prefetch segment /_tree, redirected to a Location no browser can read',
          },
        ],
        skipped: [],
      });
    });

    it('rejects a document redirect to a Location no browser can read', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', {
        status: 307,
        headers: { location: 'http://[', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason: 'its navigation, redirected to a Location no browser can read',
        },
      ]);
    });

    it.each([
      {
        label: 'an external origin',
        location: 'https://127.0.0.2/redirect-control',
        steps: 0,
        visited: false,
      },
      { label: 'the same origin', location: '/redirect-control', steps: 1, visited: true },
    ])('retains valid redirect behavior for $label', async ({ location, steps, visited }) => {
      const front = await routeOf('/', FRONT);
      const local = stackOf([front], {});
      const stack = { ...local, site: local.url };
      answers.set('/redirect-control', {
        headers: { 'content-type': TEXT, 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: 'the terminal response',
      });
      const followed = await redirectsFrom(
        stack,
        {
          answered: { changes: NO_COOKIE_CHANGES, account: '', page: false, location },
          url: new URL('/', stack.site),
          headers: {},
          jar: [],
        },
        new Map(),
      );

      expect(followed.failure).toBeUndefined();
      expect(followed.steps).toHaveLength(steps);
      expect(askedHeaders.has('/redirect-control')).toBe(visited);
    });

    it.each([
      { label: 'known part', hopPaths: ['/hop'], finalType: RSC, failures: [] },
      { label: 'fallback hop', hopPaths: [], finalType: RSC, failures: [] },
      {
        label: 'known part with invalid terminal type',
        hopPaths: ['/hop'],
        finalType: TEXT,
        failures: [
          {
            path: '/',
            reason:
              'its prefetch segment /_tree, redirected to /login, answered as text/plain; charset=utf-8, not text/x-component',
          },
        ],
      },
      {
        label: 'fallback hop with invalid terminal type',
        hopPaths: [],
        finalType: TEXT,
        failures: [
          {
            path: '/',
            reason:
              'its prefetch segment /_tree, redirected to /login, answered as text/plain; charset=utf-8, not text/x-component',
          },
        ],
      },
    ])(
      'follows and cancels a flushed open gzip redirect through a $label',
      async ({ hopPaths, finalType, failures }) => {
        const front = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
        const intermediate = await Promise.all(
          hopPaths.map((pathname) =>
            routeOf(pathname, finished, { complete: true, segments: { '/_tree': 'hop tree' } }),
          ),
        );
        const login = await routeOf('/login', finished, {
          complete: true,
          segments: { '/_tree': 'login tree' },
        });
        const routes = [front, ...intermediate, login];
        answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
        answers.set('/hop', finishedAnswer(finished, '/hop'));
        answers.set('/login', finishedAnswer(finished, '/login'));
        partAnswers.set('/|/_tree', {
          status: 307,
          headers: { location: '/hop', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
          body: '',
        });
        const open = streamingRedirect('/login');
        // Only the redirected fetch without its router hash gets the open intermediate body.
        // Direct checks of /hop's own part still receive its normal, finite bytes.
        partAnswers.set('/hop|/_tree', { ...segmentAnswer('hop tree'), unbusted: open.answer });
        partAnswers.set('/login|/_tree', {
          ...segmentAnswer('login tree'),
          withCookie: { name: 'from', headers: { 'content-type': finalType } },
        });
        try {
          const result = await checkStack(stackOf(routes, {}));

          expect(result.failures).toStrictEqual(failures);
          expect(result.checked).toBe(routes.length);
          expect(open.responses.length).toBeGreaterThan(0);

          const closed = await Promise.all(open.closed);

          expect(closed).toStrictEqual(open.closed.map(() => true));
        } finally {
          for (const response of open.responses) response.destroy();
        }
      },
    );

    it.each([
      { label: 'known part', hopPaths: ['/hop'] },
      { label: 'fallback hop', hopPaths: [] },
    ])(
      'releases an owned terminal stream through a $label and retains its cookie for replay',
      async ({ hopPaths }) => {
        const front = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
        const hops = await Promise.all(
          hopPaths.map((pathname) =>
            routeOf(pathname, finished, { complete: true, segments: { '/_tree': 'hop tree' } }),
          ),
        );
        const routes = [front, ...hops];
        answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
        answers.set('/hop', finishedAnswer(finished, '/hop'));
        partAnswers.set('/|/_tree', {
          status: 307,
          headers: { location: '/hop', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
          body: '',
        });
        const open = streamingRedirect('/hop');
        const replayedCookies: (string | undefined)[] = [];
        partAnswers.set('/hop|/_tree', {
          ...segmentAnswer('hop tree'),
          when: {
            test: (headers) => {
              replayedCookies.push(headers.cookie);
              return false;
            },
            headers: {},
          },
          // The first terminal response has no router hash; its replay is finite.
          unbusted: {
            ...open.answer,
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'content-encoding': 'gzip',
              'set-cookie': 'from=hop; Path=/',
              'x-arkor-edge': 'passthrough;reason=external-rewrite;mw=hit',
            },
          },
        });
        try {
          const result = await checkStack(stackOf(routes, {}));

          expect(result.failures).toStrictEqual([]);
          expect(result.checked).toBe(routes.length);
          expect(open.responses.length).toBeGreaterThan(0);
          expect(replayedCookies).toContain('from=hop');

          const closed = await Promise.all(open.closed);

          expect(closed).toStrictEqual(open.closed.map(() => true));
        } finally {
          for (const response of open.responses) response.destroy();
        }
      },
    );

    it('still judges the bytes of an ordinary known router landing before a later good sample', async () => {
      const front = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
      const hop = await routeOf('/hop', finished, {
        complete: true,
        segments: { '/_tree': 'hop tree' },
      });
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/hop', finishedAnswer(finished, '/hop'));
      const redirect = {
        status: 307,
        headers: { 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      };
      // Keep the existing hash so the router adopts this response without replaying it.
      partAnswers.set('/|/_tree', {
        ...redirect,
        forSearch: (search) => {
          return {
            ...redirect,
            headers: { ...redirect.headers, location: `/hop${search}` },
          };
        },
      });
      const good = segmentAnswer('hop tree');
      const seen: string[] = [];
      partAnswers.set('/hop|/_tree', {
        ...good,
        forSearch: initialPartAnswers(segmentAnswer('bad tree'), good, seen, 1),
      });
      const result = await checkStack(stackOf([front, hop], {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, redirected to /hop, answered 8 bytes other than the 8 the build wrote',
        },
      ]);
      expect(seen[0]).toBe('bad tree');
      expect(seen).toContain('hop tree');
    });

    it('keeps whole byte evidence for an ordinary fallback hop with a near-miss ownership reason', async () => {
      const front = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
      const local = stackOf([front], {});
      const stack = { ...local, site: local.url };
      const body = 'unowned terminal bytes';
      const account = 'passthrough;reason=external-rewrite-extra;mw=hit';
      partAnswers.set('/outside|/_tree', {
        headers: { 'content-type': RSC, 'x-arkor-edge': account },
        body,
      });
      const followed = await redirectsFrom(
        stack,
        {
          answered: { changes: NO_COOKIE_CHANGES, account: '', page: false, location: '/outside' },
          url: new URL('/', stack.site),
          headers: {
            rsc: '1',
            'next-router-segment-prefetch': '/_tree',
            'accept-encoding': 'identity',
          },
          jar: [],
          whole: true,
        },
        new Map(),
      );

      expect(followed.failure).toBeUndefined();
      expect(followed.steps).toHaveLength(1);
      expect(followed.last?.account).toBe(account);
      expect(followed.last?.whole).toStrictEqual({
        status: 200,
        length: Buffer.byteLength(body),
        sha256: sha256Of(body),
      });
    });

    it("is judged where a redirect leads its browser's fetch, as that page's part", async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'login tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/login', finishedAnswer(finished, '/login'));
      // The middleware redirects the front page's tree to the login's, saying where it came from.
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'from=front; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      // The login's tree, answered from storage under another type to a visitor who came so.
      partAnswers.set('/login|/_tree', {
        ...segmentAnswer('login tree'),
        withCookie: { name: 'from', headers: { 'content-type': 'text/plain' } },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, redirected to /login, answered as text/plain, not text/x-component',
        },
      ]);
    });

    it("is held where a redirect leads its browser's fetch to what the fetch was answered there", async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'login tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/login', finishedAnswer(finished, '/login'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/login', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      // Both the redirect's first fetch and its router replay fail, before a later valid sample.
      const again = segmentAnswer('login tree');
      const seen: string[] = [];
      partAnswers.set('/login|/_tree', {
        ...again,
        forSearch: initialPartAnswers({ ...again, status: 500 }, again, seen),
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures[0]?.path).toBe('/');
      expect(result.failures[0]?.reason).toBe(
        'its prefetch segment /_tree, redirected to /login, answered 500',
      );
      expect(seen.slice(0, 2)).toStrictEqual(['login tree', 'login tree']);
    });

    it('judges a redirected runtime part by its own generation while a later sample refreshes', async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'login tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/login', finishedAnswer(finished, '/login'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/login', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      const old = segmentAnswer('stale generation');
      const fresh = segmentAnswer('fresh generation');
      const runtime = { 'cache-control': GATED, 'x-nextjs-prerender': '1' };
      const before = { ...old, headers: { ...old.headers, ...runtime } };
      const after = { ...fresh, headers: { ...fresh.headers, ...runtime } };
      const record = `dpl_site|${await entryOf('/login', '/login')}`;
      generationHeaders.set(`${record}|2`, { 'content-type': HTML });
      generationHeaders.set(`${record}|3`, { 'content-type': HTML });
      generationOutputs.set(`${record}|2`, [outputOf('segment', 'segment:/_tree', before.body)]);
      generationOutputs.set(`${record}|3`, [outputOf('segment', 'segment:/_tree', after.body)]);
      const seen: string[] = [];
      partAnswers.set('/login|/_tree', {
        ...after,
        forSearch: initialPartAnswers(before, after, seen),
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
      expect(seen.slice(0, 3)).toStrictEqual([before.body, before.body, after.body]);
    });

    it('keeps a redirected part trace snapshot after DELETE and rejects its own incorrect header', async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'login tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/login', finishedAnswer(finished, '/login'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/login', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      const old = segmentAnswer('captured generation');
      const fresh = segmentAnswer('refreshed generation');
      const runtime = { 'cache-control': GATED, 'x-nextjs-prerender': '1' };
      const before = { ...old, headers: { ...old.headers, ...runtime, 'x-generation': '2' } };
      const after = { ...fresh, headers: { ...fresh.headers, ...runtime, 'x-generation': '3' } };
      const record = `dpl_site|${await entryOf('/login', '/login')}`;
      const first = `${record}|2`;
      const next = `${record}|3`;
      const refreshed = () => {
        generationHeaders.delete(first);
        generationOutputs.delete(first);
        generationHeaders.set(next, { 'content-type': HTML, 'x-generation': '3' });
        generationOutputs.set(next, [outputOf('segment', 'segment:/_tree', after.body)]);
      };
      capturedPartRecords.set('/login', record);
      generationHeaders.set(first, { 'content-type': HTML, 'x-generation': '2' });
      generationOutputs.set(first, [outputOf('segment', 'segment:/_tree', before.body)]);
      afterPartTraces.set('/login', { remaining: 2, apply: refreshed });
      const seen: string[] = [];
      partAnswers.set('/login|/_tree', {
        ...after,
        forSearch: initialPartAnswers(before, after, seen),
      });
      const valid = await checkStack(stackOf(routes, {}));

      expect(valid.failures).toStrictEqual([]);
      expect(seen.slice(0, 3)).toStrictEqual([before.body, before.body, after.body]);
      expect(generationHeaders.has(first)).toBe(false);

      // A later global snapshot cannot hide a bad header captured for the adopted response.
      generationHeaders.delete(next);
      generationOutputs.delete(next);
      generationHeaders.set(first, { 'content-type': HTML, 'x-generation': 'required' });
      generationOutputs.set(first, [outputOf('segment', 'segment:/_tree', before.body)]);
      afterPartTraces.set('/login', { remaining: 2, apply: refreshed });
      seen.length = 0;
      partAnswers.set('/login|/_tree', {
        ...after,
        forSearch: initialPartAnswers(before, after, seen),
      });
      const refused = await checkStack(stackOf(routes, {}));

      expect(refused.failures[0]?.path).toBe('/');
      expect(refused.failures[0]?.reason).toContain('x-generation');
      expect(generationHeaders.has(first)).toBe(false);
    });

    it('rejects an unrecorded original landing even when the next sample is a valid generation', async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'login tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/login', finishedAnswer(finished, '/login'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/login', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      const unknown = segmentAnswer('unknown generation');
      const valid = segmentAnswer('recorded generation');
      const runtime = { 'cache-control': GATED, 'x-nextjs-prerender': '1' };
      const before = { ...unknown, headers: { ...unknown.headers, ...runtime } };
      const after = { ...valid, headers: { ...valid.headers, ...runtime } };
      const at = `dpl_site|${await entryOf('/login', '/login')}|2`;
      generationHeaders.set(at, { 'content-type': HTML });
      generationOutputs.set(at, [outputOf('segment', 'segment:/_tree', after.body)]);
      const seen: string[] = [];
      partAnswers.set('/login|/_tree', {
        ...after,
        forSearch: initialPartAnswers(before, after, seen),
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures[0]?.path).toBe('/');
      expect(result.failures[0]?.reason).toMatch(
        /redirected to \/login, answered \d+ bytes no generation of its route's record the stack's edge read holds for it/u,
      );
      expect(seen.slice(0, 2)).toStrictEqual([before.body, before.body]);
    });

    it('does not judge a pre-replay response that the router discards as its final part', async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'login tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/login', finishedAnswer(finished, '/login'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/login', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      const after = segmentAnswer('login tree');
      const before = {
        ...after,
        headers: { ...after.headers, 'content-type': TEXT },
        body: 'discarded',
      };
      const seen: string[] = [];
      partAnswers.set('/login|/_tree', {
        ...after,
        forSearch: initialPartAnswers(before, after, seen, 1),
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([]);
      expect(seen.slice(0, 2)).toStrictEqual([before.body, after.body]);
    });

    it("is judged where the router asks a redirect's URL again with its own _rsc, as Next.js's does", async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } }),
        await routeOf('/login', finished, { complete: true, segments: { '/_tree': 'login tree' } }),
      ];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      answers.set('/login', finishedAnswer(finished, '/login'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: {
          location: '/login',
          'set-cookie': 'from=front; Path=/',
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        },
        body: '',
      });
      // As the redirect left it, the login's tree as it is; asked again with the router's `_rsc`,
      // under another type to a visitor who came so.
      partAnswers.set('/login|/_tree', {
        ...segmentAnswer('login tree'),
        withCookie: { name: 'from', headers: { 'content-type': 'text/plain' } },
        unbusted: segmentAnswer('login tree'),
      });
      const result = await checkStack(stackOf(routes, {}));

      // Only the tree asked again with the router's `_rsc` is under another type.
      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, redirected to /login, answered as text/plain, not text/x-component',
        },
      ]);
    });

    it.each(['_rsc', '%5Frsc=old'])(
      'replays the computed router hash past an earlier %s key without normalizing its query',
      async (query) => {
        const front = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
        const login = await routeOf('/login', finished, {
          complete: true,
          segments: { '/_tree': 'login tree' },
        });
        const local = stackOf([front, login], {});
        const stack = { ...local, site: local.url };
        const page = new URL(`/?${query}&name=space%20here`, stack.site);
        const parts = await partsOf(
          stack,
          {
            key: '/',
            route: front,
            requested: page.pathname + page.search,
            headers: {},
            exact: true,
          },
          { browser: {}, origin: originAt(stack, page, '') },
        );
        const tree = treePart(parts);
        const hash = appendedHash(tree);
        const seen: string[] = [];
        partAnswers.set('/|/_tree', {
          status: 307,
          headers: {
            location: '/login?name=space%20here',
            'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
          },
          body: '',
        });
        partAnswers.set('/login|/_tree', {
          ...segmentAnswer('login tree'),
          forSearch: requiringHash(seen, hash),
        });
        const failure = await flowFailure(
          stack,
          [tree],
          { jar: [], referred: 'none', as: '' },
          { judged: new Map(), followed: new Map() },
        );

        expect(tree.kind).toBe('segment');
        expect(hash).toMatch(/^[\w-]+$/u);
        expect(tree.url.search).toContain(`?${query}&name=space%20here&_rsc=`);
        expect(failure).toBeUndefined();
        expect(seen).toContain(`?name=space%20here&_rsc=${hash}`);
        expect(seen).not.toContain('?name=space%20here&_rsc');
        expect(seen).not.toContain('?name=space%20here&_rsc=old');
      },
    );

    it('stops replay after a redirected fetch keeps its first bare _rsc value', async () => {
      const front = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
      const login = await routeOf('/login', finished, {
        complete: true,
        segments: { '/_tree': 'login tree' },
      });
      const local = stackOf([front, login], {});
      const stack = { ...local, site: local.url };
      const page = new URL('/', stack.site);
      const parts = await partsOf(
        stack,
        { key: '/', route: front, requested: '/', headers: {}, exact: true },
        { browser: {}, origin: originAt(stack, page, '') },
      );
      const tree = treePart(parts);
      const seen: string[] = [];
      const location = '/login?_rsc&name=space%20here';
      const redirect = {
        status: 307,
        headers: { location, 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      };
      partAnswers.set('/|/_tree', redirect);
      partAnswers.set('/login|/_tree', {
        ...segmentAnswer('login tree'),
        forSearch: keepingBare(seen, redirect),
      });
      const followed = await redirectsFrom(
        stack,
        {
          answered: { changes: NO_COOKIE_CHANGES, account: '', page: false, location },
          url: tree.url,
          headers: tree.headers,
          jar: [],
          replay: tree.url.searchParams.get('_rsc') ?? '',
          whole: true,
        },
        new Map(),
      );

      expect(tree.kind).toBe('segment');
      expect(followed.failure).toBeUndefined();
      expect(followed.steps).toHaveLength(3);
      expect(followed.landed?.url.search).toBe('?_rsc&name=space%20here');
      expect(seen).toHaveLength(2);
      expect(seen[1]).toMatch(/^\?_rsc&name=space%20here&_rsc=[\w-]+$/u);
    });

    it("fails where a part's redirects go on past as many as a browser's fetch follows", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // The tree redirected to the front page, which a request for it redirects again, and on.
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its prefetch segment /_tree, redirected past the 20 redirects a browser's fetch follows, where it fails",
        },
      ]);
    });

    it("fails where a part's redirect leads to an answer the check cannot read", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', {
        status: 307,
        headers: { location: '/login', 'x-arkor-edge': 'passthrough;reason=middleware;mw=hit' },
        body: '',
      });
      // The login, whose connection drops before it answers.
      answers.set('/login', { headers: {}, body: '', hangsUp: true });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, redirected to \/login, not answered whole within 30 s: /u,
      );
    });

    it("is held to its class's record alone where the policy reads no member's own", async () => {
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const routes = [await routeOf('/items/[id]', ITEM, { segments: { '/_tree': 'item tree' } })];
      const dynamicRoutes: DynamicRoute[] = [
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[id]' },
      ];
      const member = validationPathnameFor('/items/[id]') ?? '';
      answers.set(member, documentAnswer(ITEM, 'mw=miss;route=/items/[id]'));
      // A generation of the class's record, and one of the member's own — which the edge reads only
      // where its policy upgrades a member (`concreteUpgrade`), as the stack's does not.
      const owned = `dpl_site|${await entryOf('/items/[id]')}|1`;
      generationHeaders.set(owned, { 'content-type': HTML });
      generationOutputs.set(owned, [outputOf('segment', 'segment:/_tree', 'item tree')]);
      const members = `dpl_site|${await entryOf(member)}|1`;
      generationHeaders.set(members, { 'content-type': HTML });
      generationOutputs.set(members, [outputOf('segment', 'segment:/_tree', 'member tree')]);
      const since = segmentAnswer('member tree');
      const rendered = { 'x-nextjs-prerender': '1', 'cache-control': 'private, no-store' };
      partAnswers.set(`${member}|/_tree`, {
        ...since,
        headers: { ...since.headers, ...rendered },
      });
      const result = await checkStack(stackOf(routes, {}, { dynamicRoutes }));

      expect(result.failures).toStrictEqual([
        {
          path: member,
          reason:
            "its prefetch segment /_tree, answered 11 bytes no generation of its route's record the stack's edge read holds for it",
        },
      ]);
    });

    // The edge answers a member's parts from its completion's record once it holds one, though the
    // route holds no record of its own (greptile).
    describe("of a partial fallback's member, whose route holds no record of its own", () => {
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const dynamicRoutes: DynamicRoute[] = [
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[id]' },
      ];
      const member = validationPathnameFor('/items/[id]') ?? '';
      const rendered = { 'x-nextjs-prerender': '1', 'cache-control': 'private, no-store' };

      /**
       * The stack of a class the build left a partial fallback, its fallback's segment written, with
       * the member's completion the edge read holding `outputs` (`partialFallbackInHand`).
       */
      async function completedAs(outputs: readonly Output[]): Promise<LocalStack> {
        const routes = [
          await routeOf('/items/[id]', ITEM, {
            segments: { '/_tree': 'item tree' },
            partialFallback: true,
          }),
        ];
        answers.set(member, documentAnswer(ITEM, 'mw=miss;route=/items/[id]'));
        const completed = `dpl_site|${await entryOf(member)}|1`;
        generationHeaders.set(completed, { 'content-type': HTML });
        generationOutputs.set(completed, [...outputs]);
        return stackOf(routes, {}, { dynamicRoutes });
      }

      it("is answered from the completion the edge holds, not the fallback's own parts", async () => {
        const stack = await completedAs([
          outputOf('segment', 'segment:/_tree', 'member tree'),
          outputOf('rsc', 'rsc', 'member payload'),
        ]);
        const since = segmentAnswer('member tree');
        partAnswers.set(`${member}|/_tree`, {
          ...since,
          headers: { ...since.headers, ...rendered },
        });
        // A whole payload, which the build wrote none of for a page a resume completes.
        partAnswers.set(
          `${member}|rsc-prefetch`,
          partAnswer('payload', 'member payload', { 'x-nextjs-cache': 'HIT', ...rendered }),
        );
        const result = await checkStack(stack);

        expect(result.failures).toStrictEqual([]);
      });

      it('is held to the completion the edge read', async () => {
        const stack = await completedAs([outputOf('segment', 'segment:/_tree', 'other tree')]);
        const since = segmentAnswer('member tree');
        partAnswers.set(`${member}|/_tree`, {
          ...since,
          headers: { ...since.headers, ...rendered },
        });
        const result = await checkStack(stack);

        expect(result.failures).toStrictEqual([
          {
            path: member,
            reason:
              "its prefetch segment /_tree, answered 11 bytes no generation of its route's record the stack's edge read holds for it",
          },
        ]);
      });

      it('is held to the bytes the build wrote where the policy holds no record it read', async () => {
        const stack = await completedAs([outputOf('segment', 'segment:/_tree', 'member tree')]);
        const since = segmentAnswer('member tree');
        partAnswers.set(`${member}|/_tree`, {
          ...since,
          headers: { ...since.headers, ...rendered },
        });
        // A completion is served only from a record an isolate holds, never waited on.
        const unheld = {
          ...stack.policy,
          runtimeCache: { ...runtimeCacheOf(stack.policy), holdMs: 0 },
        };
        const result = await checkStack({ ...stack, policy: unheld });

        expect(result.failures).toStrictEqual([
          {
            path: member,
            reason:
              'its prefetch segment /_tree, answered 11 bytes other than the 9 the build wrote',
          },
        ]);
      });

      it('is handed on where no completion the edge holds has it', async () => {
        const stack = await completedAs([]);
        partAnswers.set(
          `${member}|/_tree`,
          handedOnAs('passthrough;reason=segment-prefetch;mw=miss', RSC),
        );
        const result = await checkStack(stack);

        expect(result.failures).toStrictEqual([]);
      });
    });

    it("fails where it is handed on for a reason the edge gives no request of the router's", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=bogus', RSC));
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its prefetch segment /_tree, handed on for a reason the edge gives no request of the router's (x-arkor-edge: passthrough;reason=bogus)",
        },
      ]);
    });

    it("is a runtime generation's where it is marked as the application marks it too, and its bytes are not the build's", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      // A rule that keeps the page's props from every cache, as the edge keeps a runtime one's.
      const unstored: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        headers: { 'cache-control': 'private, no-store' },
      };
      const stack = stackOf(routes, {}, { headerRules: [unstored] });
      answers.set('/about', finishedAnswer(about, '/about'));
      const marks = {
        'content-type': JSON_TYPE,
        vary: 'accept-encoding',
        'x-nextjs-cache': 'HIT',
        'cache-control': 'private, no-store',
        'x-arkor-edge': 'data;src=r2;enc=identity;strategy=r2;project=site;policy=default;m=0000',
      };
      answers.set('/_next/data/test/about.json', {
        headers: marks,
        body: '{"pageProps":{"since":true}}',
      });
      const since = await checkStack(stack);
      answers.set('/_next/data/test/about.json', { headers: marks, body: props });
      const built = await checkStack(stack);

      expect(since.failures).toStrictEqual([]);
      expect(built.failures).toStrictEqual([]);
    });

    it('fails where it is handed on for want of a route, but where a rule claims it', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // As the edge says of a navigation alone, for a route it found none of.
      partAnswers.set('/|/_tree', handedOnAs('passthrough;reason=route-not-proved', RSC));
      const unproved = await checkStack(stackOf(routes, {}));
      // A rule ahead of the filesystem that claims the router's requests.
      const routers = frontRule({ has: [{ type: 'header', key: 'rsc', value: '1' }] });
      const claimed = await checkStack(stackOf(routes, {}, { reservedRoutes: [routers] }));

      expect(unproved.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, handed on for want of a route, though the build proves its own (x-arkor-edge: passthrough;reason=route-not-proved)',
        },
      ]);
      expect(claimed.failures).toStrictEqual([]);
    });

    it.each(['cookie', 'Cookie'])(
      'rebuilds a part request after its last %s is deleted, and keeps a retained cookie',
      async (cookieHeader) => {
        const front = await routeOf('/', FRONT, {
          segments: { '/_tree': 'tree bytes', '/leaf': 'leaf bytes' },
        });
        const local = stackOf([front], {});
        const stack = { ...local, site: local.url };
        const page = new URL('/', stack.site);
        const built = await partsOf(
          stack,
          { key: '/', route: front, requested: '/', headers: {}, exact: true },
          { browser: {}, origin: originAt(stack, page, '') },
        );
        const parts = [namedSegment(built, '/_tree'), namedSegment(built, '/leaf')].map((part) => {
          const headers = { ...part.headers, [cookieHeader]: 'seen=1' };
          return { ...part, headers };
        });
        const owned = segmentAnswer('tree bytes');
        const ownedHeaders = {
          ...owned.headers,
          'x-arkor-edge': 'passthrough;reason=middleware;mw=hit',
        };
        partAnswers.set('/|/_tree', {
          ...owned,
          headers: { ...ownedHeaders, 'set-cookie': 'seen=; Path=/; Max-Age=0' },
        });
        const answer = segmentAnswer('leaf bytes');
        partAnswers.set('/|/leaf', {
          ...answer,
          headers: { ...answer.headers, 'cache-control': GATED },
        });
        const deleted = await flowFailure(
          stack,
          parts,
          { jar: jarOf('seen=1', { document: page }), referred: 'none', as: '' },
          { judged: new Map(), followed: new Map() },
        );
        const afterDeletion = (partsAskedEach.get('/|/leaf') ?? []).map(
          (headers) => headers.cookie,
        );
        partsAskedEach.delete('/|/leaf');
        partAnswers.set('/|/_tree', { ...owned, headers: ownedHeaders });
        const retained = await flowFailure(
          stack,
          parts,
          { jar: jarOf('seen=1', { document: page }), referred: 'none', as: '' },
          { judged: new Map(), followed: new Map() },
        );
        const afterRetention = (partsAskedEach.get('/|/leaf') ?? []).map(
          (headers) => headers.cookie,
        );

        expect(deleted).toBeUndefined();
        expect(afterDeletion).toContain('seen=1');
        expect(afterDeletion).toContain(undefined);
        expect(retained).toBeUndefined();
        expect(afterRetention).not.toHaveLength(0);
        expect(afterRetention.every((cookie) => cookie === 'seen=1')).toBe(true);
        expect(traceIds.letGo).toStrictEqual(traceIds.registered);
      },
    );

    it('is asked with the cookies its document set, as a browser keeps them', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      // A rule for a part asked with the cookie the page's middleware sets on its document.
      const seen: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'seen' },
        ],
        headers: { 'x-seen': 'yes' },
      };
      // A middleware for the page's document alone, not the router's requests.
      const stack = withMiddleware(stackOf(routes, {}, { headerRules: [seen] }), [
        { sourceRegex: '^/$', missing: [{ type: 'header', key: 'rsc' }] },
      ]);
      const composed = documentAnswer(FRONT, 'mw=hit;route=/');
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED },
      });
      const setsAt = async (cookie: string): Promise<CheckResult> => {
        decisions.set('/', { 'x-middleware-next': '1', 'set-cookie': cookie });
        answers.set('/', { ...composed, headers: { ...composed.headers, 'set-cookie': [cookie] } });
        return await checkStack(stack);
      };
      const kept = await setsAt('seen=1; Path=/');
      const asked = partsAskedEach.get('/|/_tree')?.[0]?.cookie;
      // Kept for another path, which the part is not under; and set to expire at once.
      const elsewhere = await setsAt('seen=1; Path=/elsewhere');
      const expired = await setsAt('seen=1; Path=/; Max-Age=0');

      expect(kept.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with x-seen none, not the yes the application set',
        },
      ]);
      expect(asked).toBe('seen=1');
      expect(elsewhere.failures).toStrictEqual([]);
      expect(expired.failures).toStrictEqual([]);
    });

    it('is asked with the cookies a browser the application sends blocking metadata was answered with', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      // A rule for a part asked with a cookie.
      const seen: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'seen' },
        ],
        headers: { 'x-seen': 'yes' },
      };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', composed);
      // Chrome's navigation, which the application renders whole for it, handed on — and setting a
      // cookie.
      answers.set(`/|${BROWSER_CODINGS}`, {
        ...composed,
        withHeader: {
          name: 'sec-ch-ua',
          headers: {
            'x-arkor-edge': 'passthrough;reason=html-limited-bots',
            'set-cookie': 'seen=1; Path=/',
          },
        },
      });
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED },
      });
      const result = await checkStack(
        stackOf(routes, {}, { htmlLimitedBots: 'Chrome', headerRules: [seen] }),
      );

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with x-seen none, not the yes the application set',
        },
      ]);
    });

    it('fails where the navigation of a browser the application sends blocking metadata cannot be read', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      // Chrome's navigation, whose connection drops before it answers.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        when: {
          test: (headers) =>
            headers['sec-ch-ua'] !== undefined && headers['accept-encoding'] === BROWSER_CODINGS,
          hangsUp: true,
        },
      });
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const result = await checkStack(stackOf(routes, {}, { htmlLimitedBots: 'Chrome' }));

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toMatch(
        /^asked for in what a browser accepts \(gzip, deflate, br, zstd\) by Chrome, not answered whole within 30 s: /u,
      );
    });

    it("is asked with the cookies each browser's own navigation of the page was answered with", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      // A rule for a part asked with the cookie, and a middleware for the page's document alone.
      const seen: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'cookie', key: 'seen' },
        ],
        headers: { 'x-seen': 'yes' },
      };
      const stack = withMiddleware(stackOf(routes, {}, { headerRules: [seen] }), [
        { sourceRegex: '^/$', missing: [{ type: 'header', key: 'rsc' }] },
      ]);
      // Which sets the cookie on a navigation in what Chrome accepts at once alone.
      const cookie = 'seen=1; Path=/';
      decidedInCoding.set(`/|${BROWSER_CODINGS}`, {
        'x-middleware-next': '1',
        'set-cookie': cookie,
      });
      const composed = documentAnswer(FRONT, 'mw=hit;route=/');
      answers.set('/', composed);
      answers.set(`/|${BROWSER_CODINGS}`, {
        ...composed,
        headers: { ...composed.headers, 'set-cookie': [cookie] },
      });
      const tree = segmentAnswer('tree bytes');
      const gated = { ...tree.headers, 'cache-control': GATED };
      partAnswers.set('/|/_tree', { ...tree, headers: gated });
      const unseen = await checkStack(stack);
      partAnswers.set('/|/_tree', { ...tree, headers: { ...gated, 'x-seen': 'yes' } });
      partsAskedEach.delete('/|/_tree');
      const result = await checkStack(stack);
      // Each with a referrer and with none.
      const [chrome, , safari] = partsAskedEach.get('/|/_tree') ?? [];

      expect(unseen.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with x-seen none, not the yes the application set',
        },
      ]);
      expect(result.failures).toStrictEqual([]);
      // Chrome's router with the cookie its navigation got; Safari's, whose navigation got none, without.
      expect(chrome?.cookie).toBe('seen=1');
      expect(safari?.['user-agent']).toContain('iPhone');
      expect(safari?.cookie).toBeUndefined();
    });

    it('carries what the application set on it, behind the middleware where it covers the page', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      const custom: HeaderRule = { sourceRegex: '^/$', headers: { 'x-custom': 'yes' } };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', { ...composed, headers: { ...composed.headers, 'x-custom': 'yes' } });
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const dropped = await checkStack(stackOf(routes, {}, { headerRules: [custom] }));
      // Behind a middleware that covers the page, which ran for the document and not for its part.
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      const covered = withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]);
      const unrun = await checkStack(covered);
      partAnswers.set('/|/_tree', {
        ...segmentAnswer('tree bytes'),
        headers: {
          ...segmentAnswer('tree bytes').headers,
          'cache-control': GATED,
          'x-arkor-edge':
            'segment;src=bucket;enc=identity;strategy=edge;project=site;policy=default;m=0000;mw=hit',
        },
      });
      const ran = await checkStack(covered);

      expect(dropped.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with x-custom none, not the yes the application set',
        },
      ]);
      expect(unrun.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its prefetch segment /_tree, the application's middleware covers it, and the edge answered it from storage without running the middleware",
        },
      ]);
      expect(ran.failures).toStrictEqual([]);
    });

    it("is the build's where the application marks it as a render since — a runtime generation's where its bytes are not — and as each coding it is sent in says", async () => {
      const routes = [await routeOf('/', finished, { complete: true, payload: 'payload bytes' })];
      // A rule that marks the page and its payload as Next.js marks a render since the build's.
      const marking: HeaderRule = { sourceRegex: '^/$', headers: { 'x-nextjs-prerender': '1' } };
      const whole = finishedAnswer(finished, '/');
      answers.set('/', { ...whole, headers: { ...whole.headers, 'x-nextjs-prerender': '1' } });
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'payload bytes', {
          'x-nextjs-cache': 'HIT',
          'x-nextjs-prerender': '1',
        }),
      );
      const marked = await checkStack(stackOf(routes, {}, { headerRules: [marking] }));
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'other bytes', {
          'x-nextjs-cache': 'HIT',
          'x-nextjs-prerender': '1',
        }),
      );
      const other = await checkStack(stackOf(routes, {}, { headerRules: [marking] }));
      answers.set('/', whole);
      partAnswers.set('/|rsc', partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT' }));
      // In brotli, said to be in brotli though sent as it is.
      partAnswers.set('/|rsc|br', {
        ...partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT' }),
        headers: {
          ...partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT' }).headers,
          'x-arkor-edge':
            'payload;src=bucket;enc=br;strategy=edge;project=site;policy=default;m=0000',
        },
      });
      const misstated = await checkStack(stackOf(routes, {}));

      expect(marked).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      // Taken for a runtime generation's, as it is marked so and its bytes are not the build's: kept
      // from no cache, as the edge keeps every one.
      expect(other.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its whole React Server Components payload, answered for shared caches to keep, though the answer is one visitor's",
        },
      ]);
      expect(misstated.failures[0]?.reason).toMatch(
        /^its whole React Server Components payload, asked for in br, answered with Content-Encoding none, though the edge says it sent br /u,
      );
    });

    it('is held in each coding to what it is held to as it is', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      const custom: HeaderRule = { sourceRegex: '^/$', headers: { 'x-custom': 'yes' } };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', { ...composed, headers: { ...composed.headers, 'x-custom': 'yes' } });
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', { ...tree, headers: { ...tree.headers, 'x-custom': 'yes' } });
      // In brotli, without what the application set on it.
      partAnswers.set('/|/_tree|br', tree);
      const result = await checkStack(stackOf(routes, {}, { headerRules: [custom] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, asked for in br, answered with x-custom none, not the yes the application set',
        },
      ]);
    });

    it('is judged by the rules as the front line hands it on, and asked in each coding where the edge handed the part on as it is', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A rule for the router's requests that accept brotli — every one, as Cloudflare's front line
      // hands each on accepting what it sets in the visitor's place.
      const coded: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc' },
          { type: 'header', key: 'accept-encoding', value: 'br' },
        ],
        headers: { 'x-coded': 'br' },
      };
      const tree = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', tree);
      partAnswers.set('/|/_tree|br', {
        ...tree,
        headers: { ...tree.headers, 'cache-control': GATED },
      });
      const unset = await checkStack(stackOf(routes, {}, { headerRules: [coded] }));
      // Handed on as it is, and answered in brotli with other bytes.
      partAnswers.set('/|/_tree', {
        headers: {
          'content-type': RSC,
          'x-arkor-edge': 'passthrough;reason=segment-prefetch;m=0000',
        },
        body: 'rendered tree',
      });
      partAnswers.set('/|/_tree|br', segmentAnswer('other tree bytes'));
      const handedOn = await checkStack(stackOf(routes, {}));

      expect(unset.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with x-coded none, not the br the application set',
        },
      ]);
      expect(handedOn.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, asked for in br, answered 16 bytes other than the 10 the build wrote',
        },
      ]);
    });

    it("is held coded to the caching the application set, with the edge's no-transform after it", async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' }, codedParts: true }),
      ];
      const cached: HeaderRule = {
        sourceRegex: '^/$',
        headers: { 'cache-control': 'public, max-age=60' },
      };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const tree = segmentAnswer('tree bytes');
      const ruled = {
        ...tree,
        headers: { ...tree.headers, 'cache-control': 'public, max-age=60' },
      };
      const coded = (coding: string, cacheControl: string): Answer => {
        return {
          ...ruled,
          compressed: true,
          headers: {
            ...ruled.headers,
            'content-encoding': coding,
            'cache-control': cacheControl,
            'x-arkor-edge': `segment;src=bucket;enc=${coding};strategy=edge;project=site;policy=default;m=0000`,
          },
        };
      };
      partAnswers.set('/|/_tree', ruled);
      partAnswers.set('/|/_tree|br', coded('br', 'public, max-age=60, no-transform'));
      partAnswers.set('/|/_tree|gzip', coded('gzip', 'public, max-age=60, no-transform'));
      // In brotli to a browser that accepts it among others, as the edge prefers it.
      for (const browser of [BROWSER_CODINGS, SAFARI_CODINGS]) {
        partAnswers.set(`/|/_tree|${browser}`, coded('br', 'public, max-age=60, no-transform'));
      }
      const added = await checkStack(stackOf(routes, {}, { headerRules: [cached] }));
      // Coded, and sent on as it was set.
      partAnswers.set('/|/_tree|br', coded('br', 'public, max-age=60'));
      const unadded = await checkStack(stackOf(routes, {}, { headerRules: [cached] }));

      expect(added).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(unadded.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, asked for in br, answered with cache-control public, max-age=60, not the public, max-age=60 the application set, no-transform after it as the edge adds to a coded part',
        },
      ]);
    });

    it('is held coded to the build where the application keeps it from every cache itself', async () => {
      const routes = [
        await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' }, codedParts: true }),
      ];
      const uncached: HeaderRule = {
        sourceRegex: '^/$',
        headers: { 'cache-control': 'private, no-store' },
      };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const tree = segmentAnswer('tree bytes');
      const ruled = { ...tree, headers: { ...tree.headers, 'cache-control': 'private, no-store' } };
      partAnswers.set('/|/_tree', ruled);
      // In brotli, other bytes under what the edge sends a coded part of the build with: told from a
      // runtime generation's, which it sends as it is, by the no-transform after it.
      partAnswers.set('/|/_tree|br', {
        ...ruled,
        body: 'other tree bytes',
        compressed: true,
        headers: {
          ...ruled.headers,
          'content-encoding': 'br',
          'cache-control': 'private, no-store, no-transform',
          'x-arkor-edge':
            'segment;src=bucket;enc=br;strategy=edge;project=site;policy=default;m=0000',
        },
      });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [uncached] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, asked for in br, answered 16 bytes other than the 10 the build wrote',
        },
      ]);
    });

    it('is asked for in what a browser accepts at once, held to the rules as the front line hands it on', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      // A rule for the router's requests that accept zstd — which none reaches the edge accepting,
      // as Cloudflare's front line hands each on accepting what it sets in the visitor's place.
      const combined: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc' },
          { type: 'header', key: 'accept-encoding', value: '.*zstd.*' },
        ],
        headers: { 'x-combined': 'yes' },
      };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const result = await checkStack(stackOf(routes, {}, { headerRules: [combined] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it('is asked for its whole payload as a prefetch too, which a runtime generation may answer postponed', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set(
        '/|rsc-prefetch',
        partAnswer('payload', 'partial since', {
          'x-nextjs-cache': 'HIT',
          'cache-control': 'private, no-store',
          'x-nextjs-prerender': '1',
          'x-nextjs-postponed': '1',
        }),
      );
      const postponed = await checkStack(stackOf(routes, {}));
      const asked = partsAsked.get('/|rsc-prefetch');
      // Marked as a segment is, which the router would read as one.
      partAnswers.set(
        '/|rsc-prefetch',
        partAnswer('payload', 'partial since', {
          'x-nextjs-cache': 'HIT',
          'cache-control': 'private, no-store',
          'x-nextjs-prerender': '1',
          'x-nextjs-postponed': '2',
        }),
      );
      const misread = await checkStack(stackOf(routes, {}));
      // Postponed as the edge marks one, but with no word of where it came from.
      partAnswers.set(
        '/|rsc-prefetch',
        partAnswer('payload', 'partial since', {
          'cache-control': 'private, no-store',
          'x-nextjs-prerender': '1',
          'x-nextjs-postponed': '1',
        }),
      );
      const unmarked = await checkStack(stackOf(routes, {}));
      // A page the build finished, its payload prefetched as other bytes than it wrote.
      const whole = [await routeOf('/', finished, { complete: true, payload: 'payload bytes' })];
      answers.set('/', finishedAnswer(finished, '/'));
      partAnswers.set('/|rsc', partAnswer('payload', 'payload bytes', { 'x-nextjs-cache': 'HIT' }));
      partAnswers.set(
        '/|rsc-prefetch',
        partAnswer('payload', 'other bytes', { 'x-nextjs-cache': 'HIT' }),
      );
      const other = await checkStack(stackOf(whole, {}));

      expect(postponed).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(misread.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, prefetched (next-router-prefetch: 1), answered with x-nextjs-postponed 2, not 1 or none',
        },
      ]);
      expect(unmarked.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, prefetched (next-router-prefetch: 1), answered with x-nextjs-cache none, not HIT or STALE',
        },
      ]);
      expect(asked?.headers['next-router-prefetch']).toBe('1');
      expect(asked?.headers['next-router-state-tree']).toBeDefined();
      expect(asked?.headers['next-router-segment-prefetch']).toBeUndefined();
      expect(other.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, prefetched (next-router-prefetch: 1), answered 11 bytes other than the 13 the build wrote',
        },
      ]);
    });

    it("fails where a part is answered from storage, though its route's bypassFor holds for the router's request", async () => {
      const route = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
      // Held for what a browser's script says of itself, which the check's own navigation does not.
      const hinted = { ...route, bypassFor: [{ type: 'header' as const, key: 'sec-ch-ua' }] };
      // Chrome's own navigation, which the bypass holds for, handed on as the edge hands it on.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        withHeader: {
          name: 'sec-ch-ua',
          headers: { 'x-arkor-edge': 'passthrough;reason=bypass-for' },
        },
      });
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const result = await checkStack(stackOf([hinted], {}));

      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, answered from storage, though its route's bypassFor holds for the request, which Next\.js renders itself \(x-arkor-edge: segment;/u,
      );
    });

    it('is asked for its whole payload as each prefetch, the runtime ones never answered postponed', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const handedOn = await checkStack(stackOf(routes, {}));
      const asked = ['rsc-prefetch', 'rsc-prefetch-2', 'rsc-prefetch-3'].map(
        (key) => partsAsked.get(`/|${key}`)?.headers['next-router-prefetch'],
      );
      // Postponed to a prefetch with its runtime parts, which the edge leaves the Function.
      partAnswers.set(
        '/|rsc-prefetch-2',
        partAnswer('payload', 'partial since', {
          'x-nextjs-cache': 'HIT',
          'cache-control': 'private, no-store',
          'x-nextjs-prerender': '1',
          'x-nextjs-postponed': '1',
        }),
      );
      const runtime = await checkStack(stackOf(routes, {}));

      expect(handedOn).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(asked).toStrictEqual(['1', '2', '3']);
      expect(runtime.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, prefetched (next-router-prefetch: 2), answered with x-nextjs-postponed 1, a postponed payload, to a request that asks for a whole one',
        },
      ]);
    });

    it('is asked as the browser the page was asked as, where rules claim the others', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      // The check's own agent and every request Chrome sends claimed, which leaves Safari.
      const rules: ReservedRoute[] = [
        frontRule({ has: [{ type: 'header', key: 'user-agent', value: 'upwind-local-check.*' }] }),
        frontRule({ has: [{ type: 'header', key: 'sec-ch-ua' }] }),
      ];
      // Chrome's own navigation, which a rule claims, handed on as the edge hands it on.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        withHeader: {
          name: 'sec-ch-ua',
          headers: { 'x-arkor-edge': 'passthrough;reason=route-not-proved' },
        },
      });
      // And Chrome's router requests, which the rule claims as well, handed on likewise.
      partAnswers.set('/|/_tree', {
        ...segmentAnswer('tree bytes'),
        withHeader: {
          name: 'sec-ch-ua',
          headers: { 'x-arkor-edge': 'passthrough;reason=route-not-proved' },
        },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: rules }));
      // The first the router asks: as the browser the page was asked as.
      const asked = partsAskedEach.get('/|/_tree')?.[0];

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(asked?.['user-agent']).toMatch(/iPhone/u);
      expect(asked?.['sec-ch-ua']).toBeUndefined();
    });

    it('is skipped where the middleware rewrote a part onto a file of the build', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      const files = { '/a.txt': fileOf('kept bytes', TEXT) };
      // The page as it is, which a router runs on; its tree rewritten onto a file.
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      decidedForSegment.set('/|/_tree', {
        'x-middleware-next': '1',
        'x-middleware-rewrite': '/a.txt',
      });
      const onto: Answer = {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          vary: RSC_VARY,
          'x-arkor-edge': `static;src=bucket;project=site;policy=default;m=0000;mw=hit`,
        },
        body: 'kept bytes',
      };
      partAnswers.set('/|/_tree', onto);
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf(routes, files));

      expect(result.failures).toStrictEqual([]);
      expect(partsAsked.has('/|/_tree')).toBe(true);
    });

    it.each([
      { name: 'all required names', vary: `Origin, ${RSC_VARY}`, valid: true },
      { name: 'missing application name', vary: RSC_VARY, valid: false },
      {
        name: 'missing segment protocol name',
        vary: 'Origin, rsc, next-router-state-tree, next-router-prefetch',
        valid: false,
      },
    ])('judges a file rewrite Vary with $name', async ({ vary, valid }) => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      const files = { '/a.txt': fileOf('kept bytes', TEXT) };
      answers.set('/', documentAnswer(FRONT, 'mw=hit;route=/'));
      decidedForSegment.set('/|/_tree', {
        'x-middleware-next': '1',
        'x-middleware-rewrite': '/a.txt',
        vary: 'Origin',
      });
      partAnswers.set('/|/_tree', {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          vary,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      });
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf(routes, files));
      const failures = valid
        ? []
        : [
            {
              path: '/',
              reason: `its prefetch segment /_tree, rewritten onto /a.txt, and answered with vary ${vary}, not the Origin, ${RSC_VARY} the application set`,
            },
          ];

      expect(result.failures).toStrictEqual(failures);
      expect(partsAsked.has('/|/_tree')).toBe(true);
    });

    it('judges the file Vary after middleware removes RSC, independently of part renaming', async () => {
      const file = fileOf('kept bytes', TEXT);
      const stack = {
        ...stackOf([], { '/a.txt': file }),
        site: new URL('https://site.example'),
      };
      const url = new URL('/a.txt', stack.site);
      answers.set('/a.txt', {
        headers: {
          'content-type': TEXT,
          'cache-control': REVALIDATE,
          vary: 'Origin',
          'x-arkor-edge': FILE_EDGE,
        },
        body: 'kept bytes',
      });
      const answer = await read(new URL('/a.txt', stack.url), {
        headers: {},
        deadlineMs: 1000,
      });
      const asked = { rsc: '1' };
      const decidedFor = (rsc: string): ReturnType<typeof readMiddlewareResponse> => {
        const response = new Response(null, {
          headers: {
            'x-middleware-next': '1',
            'x-middleware-override-headers': 'rsc',
            'x-middleware-request-rsc': rsc,
            'cache-control': REVALIDATE,
            vary: 'Origin',
          },
        });
        return readMiddlewareResponse(response, url, new Headers(asked));
      };
      const withoutRsc = expectationOf(stack, url, file, {
        headers: asked,
        answer,
        middleware: decidedFor('0'),
      });
      const withRsc = expectationOf(stack, url, file, {
        headers: asked,
        answer,
        middleware: decidedFor('1'),
      });

      expect(answer.headers.vary).toBe('Origin');
      expect(fileFailure(file, answer, withoutRsc)).toBeUndefined();
      expect(fileFailure(file, answer, withRsc)).toBe(
        `answered with vary Origin, not the Origin, ${RSC_VARY} the application set`,
      );
    });

    it('keeps an ordinary file rewrite Vary without adding router fields', async () => {
      const routes = [await routeOf('/', FRONT)];
      const files = { '/a.txt': fileOf('kept bytes', TEXT) };
      decisions.set('/', { 'x-middleware-rewrite': '/a.txt', vary: 'Origin' });
      answers.set('/', {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          vary: 'Origin',
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      });
      answers.set('/a.txt', {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(
        withMiddleware(stackOf(routes, files), [{ sourceRegex: '^/$' }]),
      );

      expect(result.failures).toStrictEqual([]);
      expect(result.skipped).toContainEqual({
        path: '/',
        reason: "the application's middleware rewrote it onto /a.txt",
      });
    });

    it('judges a part rewritten onto a file before its own dynamic class', async () => {
      const route = '/items/[id]';
      const member = requiredMember(route);
      const target = '/items/report.txt';
      const routes = [await routeOf(route, FRONT, { segments: { '/_tree': 'tree bytes' } })];
      const files = { [target]: fileOf('kept bytes', TEXT) };
      const dynamicRoutes: DynamicRoute[] = [{ sourceRegex: '^/items/([^/]+?)(?:/)?$', route }];
      answers.set(member, documentAnswer(FRONT, `mw=hit;route=${route}`));
      decidedForSegment.set(`${member}|/_tree`, {
        'x-middleware-next': '1',
        'x-middleware-rewrite': target,
      });
      partAnswers.set(`${member}|/_tree`, {
        headers: {
          'content-type': TEXT,
          'cache-control': GATED,
          vary: RSC_VARY,
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
        body: 'kept bytes',
      });
      answers.set(target, {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf(routes, files, { dynamicRoutes }));

      expect(result.failures).toStrictEqual([]);
      expect(partsAsked.has(`${member}|/_tree`)).toBe(true);
    });

    it('judges a HEAD-only file rewrite before its GET document class', async () => {
      const route = '/items/[id]';
      const member = requiredMember(route);
      const target = '/items/report.txt';
      const routes = [await routeOf(route, FRONT)];
      const files = { [target]: fileOf('kept bytes', TEXT) };
      const dynamicRoutes: DynamicRoute[] = [{ sourceRegex: '^/items/([^/]+?)(?:/)?$', route }];
      answers.set(member, {
        ...documentAnswer(FRONT, `mw=hit;route=${route}`),
        onHead: {
          'content-type': TEXT,
          'cache-control': GATED,
          'content-length': String(Buffer.byteLength('kept bytes')),
          etag: `"${sha256Of('kept bytes')}"`,
          'accept-ranges': 'bytes',
          'x-arkor-edge': `${FILE_EDGE};mw=hit`,
        },
      });
      decidedOnHead.set(member, { 'x-middleware-rewrite': target });
      answers.set(target, {
        headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'kept bytes',
      });
      const result = await checkStack(stackOf(routes, files, { dynamicRoutes }));

      expect(result.failures).toStrictEqual([]);
      expect([...headTraces].some((trace) => traces.get(trace) === member)).toBe(true);
    });

    it('is asked as Chrome as well, where the page was asked as another browser', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      // The check's own agent claimed, and Chrome's navigations, which leaves Safari's.
      const rules: ReservedRoute[] = [
        frontRule({ has: [{ type: 'header', key: 'user-agent', value: 'upwind-local-check.*' }] }),
        frontRule({
          has: [
            { type: 'header', key: 'sec-ch-ua' },
            { type: 'header', key: 'sec-fetch-dest', value: 'document' },
          ],
        }),
      ];
      // Chrome's own navigation, which a rule claims, handed on as the edge hands it on.
      answers.set('/', {
        ...documentAnswer(FRONT, 'mw=miss;route=/'),
        withHeader: {
          name: 'sec-ch-ua',
          headers: { 'x-arkor-edge': 'passthrough;reason=route-not-proved' },
        },
      });
      // Chrome's router requests, which no rule claims, answered unmarked as the segment they are.
      partAnswers.set('/|/_tree', {
        ...segmentAnswer('tree bytes'),
        withHeader: { name: 'sec-ch-ua', headers: { 'x-nextjs-postponed': '1' } },
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: rules }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree by Chrome, answered with x-nextjs-postponed 1, not 2',
        },
      ]);
    });

    it("is held to a segment's cache mark the application set, which the edge leaves it", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      const marked: HeaderRule = { sourceRegex: '^/$', headers: { 'x-nextjs-cache': 'MISS' } };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const result = await checkStack(stackOf(routes, {}, { headerRules: [marked] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with x-nextjs-cache none, not the MISS the application set',
        },
      ]);
    });

    it("fails where a runtime generation's segment is not marked as rendered since", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // Kept from every cache as a runtime generation's part is, but not marked as one.
      const since = segmentAnswer('rendered since');
      partAnswers.set('/|/_tree', {
        ...since,
        headers: { ...since.headers, 'cache-control': 'private, no-store' },
      });
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its prefetch segment /_tree, answered with x-nextjs-prerender none, not the 1 the edge marks a runtime generation's part with",
        },
      ]);
    });

    it("is held to the build's bytes where the application marks a segment stale itself", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      const stale: HeaderRule = { sourceRegex: '^/$', headers: { 'x-nextjs-cache': 'STALE' } };
      const composed = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...composed,
        headers: { ...composed.headers, 'x-nextjs-cache': 'STALE' },
      });
      // Other bytes, under the mark the edge leaves a segment with as the application set it.
      const other = segmentAnswer('other tree bytes');
      partAnswers.set('/|/_tree', {
        ...other,
        headers: { ...other.headers, 'x-nextjs-cache': 'STALE' },
      });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [stale] }));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered 16 bytes other than the 10 the build wrote',
        },
      ]);
    });

    it("fails where a runtime generation's payload is answered postponed to a navigation", async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'partial since', {
          'x-nextjs-cache': 'HIT',
          'cache-control': 'private, no-store',
          'x-nextjs-prerender': '1',
          'x-nextjs-postponed': '1',
        }),
      );
      const result = await checkStack(stackOf(routes, {}));

      expect(result.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its whole React Server Components payload, answered with x-nextjs-postponed 1, a postponed payload, to a request that asks for a whole one',
        },
      ]);
    });

    it('is handed on where the headers the middleware changed meet a rule ahead of its class, though past the filesystem', async () => {
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const routes = [
        await routeOf('/items/[slug]', ITEM, { segments: { '/_tree': 'item tree' } }),
      ];
      // A rule behind the filesystem, which still claims a member ahead of its class (`dynamicRouteFor`).
      const behind: ReservedRoute = {
        sourceRegex: '^/items/(.*)$',
        has: [{ type: 'header', key: 'x-variant' }],
      };
      const dynamicRoutes: DynamicRoute[] = [
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[slug]' },
      ];
      const member = validationPathnameFor('/items/[slug]') ?? '';
      answers.set(member, documentAnswer(ITEM, 'mw=hit;route=/items/[slug]'));
      decisions.set(member, {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'x-variant',
        'x-middleware-request-x-variant': '1',
      });
      const tree = segmentAnswer('item tree');
      partAnswers.set(`${member}|/_tree`, {
        ...tree,
        headers: {
          ...tree.headers,
          'x-arkor-edge': `${String(tree.headers['x-arkor-edge'])};mw=hit`,
        },
      });
      const result = await checkStack(
        stackOf(routes, {}, { dynamicRoutes, reservedRoutes: [behind] }),
      );

      // Served all the same, where the edge routes the member as the middleware left it to none.
      expect(result.failures.filter((failure) => failure.path === member)).toStrictEqual([
        {
          path: member,
          reason:
            "served as the route asked for, though routed by the headers the application's middleware changed onto no route of the build",
        },
      ]);
    });

    it('is judged as the part of the route the headers the middleware changed route it onto', async () => {
      const VARIANT = '<!doctype html><html><head><title>Variant</title></head><body>';
      const ITEM = '<!doctype html><html><head><title>Item</title></head><body>';
      const routes = [
        await routeOf('/items/[id]', VARIANT, { segments: { '/_tree': 'variant tree' } }),
        await routeOf('/items/[slug]', ITEM, { segments: { '/_tree': 'item tree' } }),
      ];
      // Two classes of one pattern, the first for a request with a header the second's lack.
      const dynamicRoutes: DynamicRoute[] = [
        {
          sourceRegex: '^/items/([^/]+?)(?:/)?$',
          has: [{ type: 'header', key: 'x-variant' }],
          route: '/items/[id]',
        },
        { sourceRegex: '^/items/([^/]+?)(?:/)?$', route: '/items/[slug]' },
      ];
      const member = validationPathnameFor('/items/[slug]') ?? '';
      answers.set(member, documentAnswer(VARIANT, 'mw=hit;route=/items/[id]'));
      decisions.set(member, {
        'x-middleware-next': '1',
        'x-middleware-override-headers': 'x-variant',
        'x-middleware-request-x-variant': '1',
      });
      // And for the page's segment, with the router's headers Next.js puts back after an override,
      // which a middleware may not change (`FLIGHT_HEADERS`, `adapter.ts`).
      decidedForSegment.set(`${member}|/_tree`, {
        'x-middleware-next': '1',
        'x-middleware-override-headers':
          'x-variant,rsc,next-router-prefetch,next-router-segment-prefetch',
        'x-middleware-request-x-variant': '1',
        'x-middleware-request-rsc': '1',
        'x-middleware-request-next-router-prefetch': '1',
        'x-middleware-request-next-router-segment-prefetch': '/_tree',
      });
      // As the edge answers the part where the headers land it: another route's.
      partAnswers.set(`${member}|/_tree`, segmentBehindMiddleware('variant tree'));
      const result = await checkStack(stackOf(routes, {}, { dynamicRoutes }));
      // The route asked for's own, as though the middleware had moved it nowhere.
      partAnswers.set(`${member}|/_tree`, segmentBehindMiddleware('item tree'));
      const unmoved = await checkStack(stackOf(routes, {}, { dynamicRoutes }));

      // Nothing of the member's: the first class has no pathname of its own, which fails apart.
      expect(result.failures.filter((failure) => failure.path === member)).toStrictEqual([]);
      expect(partsAsked.has(`${member}|/_tree`)).toBe(true);
      expect(unmoved.failures.filter((failure) => failure.path === member)).toStrictEqual([
        {
          path: member,
          reason:
            "its prefetch segment /_tree, routed by the headers the application's middleware changed onto the route /items/[id], and answered 9 bytes other than the 12 the build wrote",
        },
      ]);
    });

    it('fails where it is answered from storage, though a rule claims the request as it was sent', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A rule for the router's requests, which the edge answers none of.
      const routers: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [{ type: 'header', key: 'rsc' }],
      };
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [routers] }));

      expect(result.failures[0]?.reason).toMatch(
        /^its prefetch segment \/_tree, answered from storage, though a rule of next\.config claims the request \(x-arkor-edge: segment;/u,
      );
    });

    it('is claimed in no coding by a rule ahead of the filesystem that asks for one the front line sets none of', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // A rule for the router's requests that accept nothing coded, which none reaches the edge as.
      const identityOnly: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        has: [
          { type: 'header', key: 'rsc' },
          { type: 'header', key: 'accept-encoding', value: 'identity' },
        ],
      };
      // Handed on as though the rule claimed it, which the edge does for no request of the router's.
      partAnswers.set('/|/_tree', {
        headers: { 'content-type': RSC, 'x-arkor-edge': 'passthrough;reason=route-not-proved' },
        body: 'rendered tree',
      });
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [identityOnly] }));

      expect(result.failures[0]?.reason).toMatch(/^its prefetch segment \/_tree, /u);
    });

    it("is asked for a resumable page's whole payload, held to a runtime generation's alone", async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      // From a generation the runtime rendered whole since, as the edge marks and keeps one.
      const since = { 'x-nextjs-cache': 'HIT', 'cache-control': 'private, no-store' };
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'rendered since', { ...since, 'x-nextjs-prerender': '1' }),
      );
      const runtime = await checkStack(stackOf(routes, {}));
      const asked = partsAsked.has('/|rsc');
      // Marked as no runtime generation's: the build's, which wrote none of it.
      partAnswers.set(
        '/|rsc',
        partAnswer('payload', 'rendered since', { 'x-nextjs-cache': 'HIT' }),
      );
      const unmarked = await checkStack(stackOf(routes, {}));
      // Handed on to the Function, as where the edge holds no such generation.
      partAnswers.delete('/|rsc');
      const handedOn = await checkStack(stackOf(routes, {}));

      expect(runtime).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(asked).toBe(true);
      expect(unmarked.failures).toStrictEqual([
        {
          path: '/',
          reason:
            "its whole React Server Components payload, answered 14 bytes not marked as a runtime generation's, though the build wrote none",
        },
      ]);
      expect(handedOn).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("is asked with the cookie the page's navigation carried", async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      // A rule that claims the page asked for without a consent cookie, which the check carries.
      const unconsented: ReservedRoute = {
        sourceRegex: '^/$',
        beforeFiles: true,
        missing: [{ type: 'cookie', key: 'consent' }],
      };
      answers.set('/', claimedWithout(documentAnswer(FRONT, 'mw=miss;route=/'), 'consent'));
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const result = await checkStack(stackOf(routes, {}, { reservedRoutes: [unconsented] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(partsAsked.get('/|/_tree')?.headers.cookie).toMatch(/consent=/u);
    });

    it("is a runtime generation's props where the edge kept them from every cache over the application's rule", async () => {
      const about = `${ABOUT}<main>finished</main></body></html>`;
      const props = '{"pageProps":{}}';
      const routes = [
        await routeOf('/about', about, { complete: true, pages: true, pagesData: props }),
      ];
      const data = '/_next/data/test/about.json';
      // A rule that lets shared caches keep the props, which the edge sets aside for a generation's.
      const cached: HeaderRule = {
        sourceRegex: String.raw`^/_next/data/test/about\.json$`,
        headers: { 'cache-control': 'public, max-age=60' },
      };
      const since = '{"pageProps":{"since":true}}';
      answers.set('/about', finishedAnswer(about, '/about'));
      answers.set(data, {
        headers: {
          'content-type': JSON_TYPE,
          vary: 'accept-encoding',
          'x-nextjs-cache': 'HIT',
          'cache-control': 'private, no-store',
          'x-arkor-edge': 'data;src=r2;enc=identity;strategy=r2;project=site;policy=default;m=0000',
        },
        body: since,
      });
      const result = await checkStack(stackOf(routes, {}, { headerRules: [cached] }));

      expect(result).toStrictEqual({ checked: 1, failures: [], skipped: [] });
    });

    it("fails where the manifest holds a page's parts otherwise than the build wrote them", async () => {
      const route = await routeOf('/', FRONT);
      const parted = await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } });
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      partAnswers.set('/|/_tree', segmentAnswer('tree bytes'));
      const invented = await checkStack(
        stackOf([route], {}, { held: { routes: { '/': parted } } }),
      );
      const dropped = await checkStack(stackOf([parted], {}, { held: { routes: { '/': route } } }));
      const tree = `10 bytes of ${RSC} (${sha256Of('tree bytes')})`;

      expect(invented.failures).toContainEqual({
        path: '/',
        reason: `held by the manifest the edge serves by with its prefetch segment /_tree as ${tree}, not the none the build wrote`,
      });
      expect(dropped.failures).toContainEqual({
        path: '/',
        reason: `held by the manifest the edge serves by with its prefetch segment /_tree as none, not the ${tree} the build wrote`,
      });
    });
  });

  describe('captured response and configured-header parity with the edge', () => {
    it('judges a file type on the Via supplied by forwarding, keeping incorrect types rejected', async () => {
      const files = { '/a.txt': fileOf('kept bytes', TEXT) };
      const rule: HeaderRule = {
        sourceRegex: '^/a[.]txt$',
        has: [{ type: 'header', key: 'via', value: '^1[.]1 arkor-edge$' }],
        headers: { 'content-type': 'image/png' },
      };
      const headers = {
        'content-type': 'image/png',
        'cache-control': GATED,
        'x-arkor-edge': FILE_EDGE,
      };
      answers.set('/a.txt', { headers, body: 'kept bytes' });
      const kept = await checkStack(stackOf([], files, { headerRules: [rule] }));
      answers.set('/a.txt', { headers: { ...headers, 'content-type': TEXT }, body: 'kept bytes' });
      const wrong = await checkStack(stackOf([], files, { headerRules: [rule] }));

      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(wrong.failures).toHaveLength(1);
      expect(wrong.failures[0]?.path).toBe('/a.txt');
      expect(wrong.failures[0]?.reason).toContain('image/png');
    });

    it('judges a document header on forwarding Via and rejects a missing selected header', async () => {
      const routes = [await routeOf('/', FRONT)];
      const rule: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'via', value: '^1[.]1 arkor-edge$' }],
        headers: { 'content-language': 'fr' },
      };
      const document = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', { ...document, headers: { ...document.headers, 'content-language': 'fr' } });
      const kept = await checkStack(stackOf(routes, {}, { headerRules: [rule] }));
      answers.set('/', document);
      const wrong = await checkStack(stackOf(routes, {}, { headerRules: [rule] }));

      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(wrong.failures).toHaveLength(1);
      expect(wrong.failures[0]?.path).toBe('/');
      expect(wrong.failures[0]?.reason).toContain('content-language');
    });

    it('judges a stored part header on forwarding Via and retains the selected-header check', async () => {
      const routes = [await routeOf('/', FRONT, { segments: { '/_tree': 'tree bytes' } })];
      const rule: HeaderRule = {
        sourceRegex: '^/$',
        has: [
          { type: 'header', key: 'rsc', value: '1' },
          { type: 'header', key: 'via', value: '^1[.]1 arkor-edge$' },
        ],
        headers: { 'content-language': 'fr' },
      };
      answers.set('/', documentAnswer(FRONT, 'mw=miss;route=/'));
      const segment = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...segment,
        headers: { ...segment.headers, 'cache-control': GATED, 'content-language': 'fr' },
      });
      const kept = await checkStack(stackOf(routes, {}, { headerRules: [rule] }));
      partAnswers.set('/|/_tree', {
        ...segment,
        headers: { ...segment.headers, 'cache-control': GATED },
      });
      const wrong = await checkStack(stackOf(routes, {}, { headerRules: [rule] }));

      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(partsAsked.has('/|/_tree')).toBe(true);
      expect(wrong.failures).toHaveLength(1);
      expect(wrong.failures[0]?.reason).toContain('content-language');
    });

    it('drops a Connection-nominated middleware tag and still rejects incorrect file bytes metadata', async () => {
      const files = { '/a.txt': fileOf('kept bytes', TEXT) };
      decisions.set('/a.txt', {
        'x-middleware-next': '1',
        connection: 'ETag',
        etag: '"discarded"',
      });
      const headers = {
        'content-type': TEXT,
        'cache-control': GATED,
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      };
      answers.set('/a.txt', { headers, body: 'kept bytes' });
      const kept = await checkStack(
        withMiddleware(stackOf([], files), [{ sourceRegex: '^/a[.]txt$' }]),
      );
      answers.set('/a.txt', { headers: { ...headers, etag: '"discarded"' }, body: 'kept bytes' });
      const wrong = await checkStack(
        withMiddleware(stackOf([], files), [{ sourceRegex: '^/a[.]txt$' }]),
      );

      expect(kept).toStrictEqual({ checked: 2, failures: [], skipped: [] });
      expect(wrong.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: `answered under the entity tag "discarded", not "${sha256Of('kept bytes')}"`,
        },
      ]);
    });

    it('filters rule-layer hop, platform and nominated fields before deriving a file expectation', async () => {
      const files = { '/a.txt': fileOf('kept bytes', TEXT) };
      const rule: HeaderRule = {
        sourceRegex: '^/a[.]txt$',
        headers: {
          connection: 'Content-Type, Content-Encoding, Cache-Control, Set-Cookie, X-Internal',
          'content-type': 'image/png',
          'content-encoding': 'gzip',
          'cache-control': 'public, max-age=999',
          'set-cookie': 'discarded=1; Path=/',
          'x-internal': 'discarded',
          'x-arkor-extra': 'discarded',
          'keep-alive': 'timeout=5',
          'x-visible': 'kept',
        },
      };
      const headers = {
        'content-type': TEXT,
        'cache-control': REVALIDATE,
        'x-arkor-edge': FILE_EDGE,
        'x-visible': 'kept',
      };
      answers.set('/a.txt', { headers, body: 'kept bytes' });
      const kept = await checkStack(stackOf([], files, { headerRules: [rule] }));
      answers.set('/a.txt', { headers: { ...headers, 'x-visible': 'other' }, body: 'kept bytes' });
      const wrong = await checkStack(stackOf([], files, { headerRules: [rule] }));

      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(wrong.failures).toStrictEqual([
        {
          path: '/a.txt',
          reason: 'answered with x-visible other, not the kept the application set',
        },
      ]);
    });

    it('filters only configured fields on stored parts and retains an independent recorded field', async () => {
      const routes = [
        await routeOf('/', FRONT, {
          segments: { '/_tree': 'tree bytes' },
          headers: { 'content-language': 'en' },
        }),
      ];
      const rule: HeaderRule = {
        sourceRegex: '^/$',
        has: [{ type: 'header', key: 'rsc', value: '1' }],
        headers: {
          connection: 'X-Internal, Set-Cookie',
          'x-internal': 'discarded',
          'set-cookie': 'discarded=1; Path=/',
          'x-arkor-extra': 'discarded',
          'keep-alive': 'timeout=5',
          'x-visible': 'kept',
        },
      };
      const document = documentAnswer(FRONT, 'mw=miss;route=/');
      answers.set('/', {
        ...document,
        headers: { ...document.headers, 'content-language': 'en', 'x-visible': 'kept' },
      });
      const segment = segmentAnswer('tree bytes');
      partAnswers.set('/|/_tree', {
        ...segment,
        headers: {
          ...segment.headers,
          'cache-control': GATED,
          'content-language': 'en',
          'x-visible': 'kept',
        },
      });
      const kept = await checkStack(stackOf(routes, {}, { headerRules: [rule] }));
      partAnswers.set('/|/_tree', {
        ...segment,
        headers: { ...segment.headers, 'cache-control': GATED, 'x-visible': 'kept' },
      });
      const wrong = await checkStack(stackOf(routes, {}, { headerRules: [rule] }));

      expect(kept).toStrictEqual({ checked: 1, failures: [], skipped: [] });
      expect(partsAsked.has('/|/_tree')).toBe(true);
      expect(wrong.failures).toStrictEqual([
        {
          path: '/',
          reason:
            'its prefetch segment /_tree, answered with content-language none, not the en the application set',
        },
      ]);
    });

    it.each([404, 418])(
      'accepts a captured %s same-URL rewrite handed to the Function for documents and parts',
      async (status) => {
        const routes = [
          await routeOf('/', FRONT + REST, {
            complete: true,
            segments: { '/_tree': 'tree bytes' },
            payload: 'payload bytes',
          }),
        ];
        decisions.set('/', { 'x-middleware-rewrite': '/', connection: 'x-middleware-rewrite' });
        decisionStatuses.set('/', status);
        const account = 'passthrough;reason=rewrite-status;mw=hit';
        answers.set('/', handedOnAs(account));
        partAnswers.set('/|/_tree', handedOnAs(account, RSC));
        partAnswers.set('/|rsc', handedOnAs(account, RSC));
        partAnswers.set('/|rsc-prefetch', handedOnAs(account, RSC));
        partAnswers.set('/|rsc-prefetch-2', handedOnAs(account, RSC));
        partAnswers.set('/|rsc-prefetch-3', handedOnAs(account, RSC));
        const result = await checkStack(
          withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]),
        );

        expect(result).toStrictEqual({
          checked: 1,
          failures: [],
          skipped: [
            {
              path: '/',
              reason: "the application's middleware gave its rewrite a status",
            },
          ],
        });
        expect(partsAsked.has('/|/_tree')).toBe(true);
        expect(partsAsked.has('/|rsc')).toBe(true);
      },
    );

    it('rejects a claimed rewrite-status handoff without a captured rewrite', async () => {
      const routes = [await routeOf('/', FRONT)];
      answers.set('/', handedOnAs('passthrough;reason=rewrite-status;mw=hit'));
      const result = await checkStack(
        withMiddleware(stackOf(routes, {}), [{ sourceRegex: '^/$' }]),
      );

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain('rewrite status');
    });

    it('keeps an error file status when the middleware gives its rewrite another status', async () => {
      const routes = [await routeOf('/', FRONT)];
      const files = { '/404': { ...fileOf('not here', HTML), status: 404 } };
      decisions.set('/', { 'x-middleware-rewrite': '/404' });
      decisionStatuses.set('/', 418);
      const headers = {
        'content-type': HTML,
        'cache-control': GATED,
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      };
      answers.set('/', { status: 404, headers, body: 'not here' });
      answers.set('/404', {
        status: 404,
        headers: { 'content-type': HTML, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
        body: 'not here',
      });
      const result = await checkStack(
        withMiddleware(stackOf(routes, files), [{ sourceRegex: '^/$' }]),
      );

      expect(result).toStrictEqual({
        checked: 2,
        failures: [],
        skipped: [
          {
            path: '/',
            reason: "the application's middleware rewrote it onto /404",
          },
        ],
      });
    });

    it.each([
      { status: 204, length: undefined },
      { status: 205, length: '0' },
    ])(
      'validates a same-file $status rewrite without using absent bytes as a range oracle',
      async ({ status, length }) => {
        const files = { '/a.txt': fileOf('kept bytes', TEXT) };
        decisions.set('/a.txt', { 'x-middleware-rewrite': '/a.txt' });
        decisionStatuses.set('/a.txt', status);
        answers.set('/a.txt', {
          status,
          lengthless: true,
          headers: {
            'content-type': TEXT,
            ...(length !== undefined && { 'content-length': length }),
            'cache-control': GATED,
            etag: `"${sha256Of('kept bytes')}"`,
            'accept-ranges': 'bytes',
            'x-arkor-edge': `${FILE_EDGE};mw=hit`,
          },
          body: '',
        });
        const result = await checkStack(
          withMiddleware(stackOf([], files), [{ sourceRegex: '^/a[.]txt$' }]),
        );

        expect(result).toStrictEqual({ checked: 2, failures: [], skipped: [] });
        expect(rangeTraces.size).toBe(0);
      },
    );

    it('rejects a nonzero length on a bodyless 205 HEAD received over HTTP', async () => {
      const file = fileOf('kept bytes', TEXT);
      const stack = stackOf([], { '/a.txt': file });
      const headers = {
        'content-type': TEXT,
        'content-length': '1',
        'cache-control': GATED,
        etag: `"${file.sha256}"`,
        'accept-ranges': 'bytes',
        'x-arkor-edge': `${FILE_EDGE};mw=hit`,
      };
      answers.set('/a.txt', { status: 205, headers, onHead: headers, body: '' });
      const answer = await read(new URL('/a.txt', stack.url), {
        method: 'HEAD',
        headers: {},
        deadlineMs: 1000,
      });

      expect(answer).toHaveLength(0);
      expect(answer.headers['content-length']).toBe('1');
      expect(
        fileHeadFailure(file, answer, {
          status: 205,
          ranges: 'bytes',
          bodylessRewrite: true,
          type: TEXT,
          etag: `"${file.sha256}"`,
          encoding: undefined,
          holding: { kind: 'private' },
          set: new Headers(),
        }),
      ).toBe('answered with Content-Length under a status that carries no body');
    });

    it.each([404, 204, 205, 304])(
      'judges a file under captured rewrite status %s with base representation metadata',
      async (status) => {
        const routes = [await routeOf('/', FRONT)];
        const files = { '/a.txt': fileOf('kept bytes', TEXT) };
        const absent = NULL_BODY_STATUSES.has(status);
        decisions.set('/', { 'x-middleware-rewrite': '/a.txt' });
        decisionStatuses.set('/', status);
        answers.set('/', {
          status,
          lengthless: absent,
          headers: {
            'content-type': TEXT,
            'cache-control': GATED,
            etag: `"${sha256Of('kept bytes')}"`,
            'accept-ranges': 'bytes',
            'x-arkor-edge': `${FILE_EDGE};mw=hit`,
          },
          body: absent ? '' : 'kept bytes',
        });
        answers.set('/a.txt', {
          headers: { 'content-type': TEXT, 'cache-control': REVALIDATE, 'x-arkor-edge': FILE_EDGE },
          body: 'kept bytes',
        });
        const result = await checkStack(
          withMiddleware(stackOf(routes, files), [{ sourceRegex: '^/$' }]),
        );

        expect(result).toStrictEqual({
          checked: 2,
          failures: [],
          skipped: [
            {
              path: '/',
              reason: "the application's middleware rewrote it onto /a.txt",
            },
          ],
        });
      },
    );
  });
});

/** The captured document required by its regression, with the existing explicit read failure. */
function requiredCapturedDocument(answer: Awaited<ReturnType<typeof documentAnswerAt>>) {
  if (typeof answer === 'string') {
    throw new TypeError(answer);
  }
  return answer;
}
