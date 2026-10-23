import { deriveEntry } from '@stayingupwind/core/cache';
import { findPagesFallback, findStaticPage } from '@stayingupwind/core/manifest';
import { classifyRequest, type RequestClass } from '@stayingupwind/core/request';

import {
  answeredBy,
  type CheckedStack,
  EDGE_HEADER,
  edgeReads,
  failed,
  failureStatus,
  recordedGenerationsOf,
  skipped,
  type Verdict,
} from './answers.ts';
import type { ReadOptions, Reading } from './reading.ts';
import type { RecordedGeneration } from './workers/protocol.ts';

/** A request the edge handed on, by the reason it gives. */
const HANDOFF = /^passthrough;reason=([a-z0-9-]+)(?:;|$)/u;
/**
 * A shared Pages request the edge answered itself, from a source of its own: a page from its record
 * (`serveCurrentPage`), a fallback route's loading shell from the build (`loadingPage`), a page's
 * props from its record (`servePairedPageData`).
 */
const SERVED = /^(static-page|pages-fallback|pages-data);src=[^;]*(?:;|$)/u;
const HTTP_OK = 200;
/** How the edge shares a Pages answer of its own, `no-transform` kept where the page asked it. */
const SHARED_REVALIDATION = 'public, max-age=0, must-revalidate';
const NO_TRANSFORM = ', no-transform';
const PAGES_DATA = 'pages-data';
const STATIC_PAGE = 'static-page';
const PAGES_FALLBACK = 'pages-fallback';
const BYPASS = 'static-page-bypass';
/** What the edge says of props it served itself, as Next.js says it (`x-nextjs-cache`). */
const DATA_CACHE: ReadonlySet<string> = new Set(['HIT', 'STALE']);

/**
 * The reasons the edge hands a GET of a Pages class on with, past the class itself, as its handlers
 * give them (static-page.ts, fallback-page.ts and the gate in front of them, in the edge): those the
 * page and its props share, the fallback route's own, and the props' own.
 */
const SHARED_HANDOFFS = [
  'static-page-private',
  'static-page-unproved',
  'static-page-cache-disabled',
  'static-page-not-fresh',
  'static-page-record-unproved',
  'static-page-invalidated',
  'static-page-response-private',
  'regenerate',
  'demoted',
  'suspect',
  'pattern-budget',
  'reserved',
  'middleware-failed',
];
const HANDOFFS: Readonly<Record<'static-page' | 'pages-fallback', ReadonlySet<string>>> = {
  [STATIC_PAGE]: new Set([STATIC_PAGE, ...SHARED_HANDOFFS]),
  [PAGES_FALLBACK]: new Set([
    'pages-fallback-shell-unavailable',
    PAGES_FALLBACK,
    ...SHARED_HANDOFFS,
  ]),
};
const DATA_HANDOFFS: ReadonlySet<string> = new Set([
  'pages-data-capture',
  'pages-data-record-unavailable',
  'pages-data-record-unproved',
]);

/** A request the shared classifier gives a Pages class, as the edge routes it. */
interface PagesAsked {
  readonly kind: 'static-page' | 'pages-fallback' | 'static-page-bypass';
  /** Whether it asks for the page's props (`pages-data`) rather than its HTML. */
  readonly data: boolean;
  /** A HEAD, which the edge hands on before anything else (`static-page-head`). */
  readonly head: boolean;
  readonly classified: RequestClass;
}

/** The Pages class the shared classifier gives a request, by its representation and its method. */
function pagesAskedOf(
  stack: CheckedStack,
  url: URL,
  headers: Readonly<Record<string, string>>,
  method: 'GET' | 'HEAD',
): PagesAsked | undefined {
  const { manifest } = stack;
  if (manifest.staticPages === undefined && manifest.pagesFallbacks === undefined) return undefined;
  const classified = classifyRequest({
    method,
    url,
    headers: edgeReads(headers),
    manifest,
    deployment: manifest.deployment,
  });
  const head = method === 'HEAD';
  if (classified.kind === STATIC_PAGE || classified.kind === PAGES_FALLBACK) {
    const data = classified.representation === PAGES_DATA;
    return { kind: classified.kind, data, head, classified };
  }
  return classified.kind === 'passthrough' && classified.reason === BYPASS
    ? { kind: classified.reason, data: false, head, classified }
    : undefined;
}

/**
 * Whether the edge hands a request so asked on with `reason`: a bypass with its own, a HEAD with
 * the one it gives every HEAD of a page (`routeHostedStaticPage`, `routeHostedFallbackPage`), a GET
 * with any its handlers give the class.
 */
function handsOnWith(asked: PagesAsked, reason: string): boolean {
  if (asked.kind === BYPASS) return reason === asked.kind;
  if (asked.head) return reason === 'static-page-head';
  return HANDOFFS[asked.kind].has(reason) || (asked.data && DATA_HANDOFFS.has(reason));
}

/**
 * Whether the edge serves a request so asked itself as `served`: props as props, and a page as a
 * page — or, for a fallback route's member it holds no record of, as the route's loading shell.
 */
function servesAs(asked: PagesAsked, served: string): boolean {
  if (asked.head || asked.kind === BYPASS) return false;
  if (asked.data) return served === PAGES_DATA;
  return served === STATIC_PAGE || (asked.kind === PAGES_FALLBACK && served === PAGES_FALLBACK);
}

/** A reason a request of no Pages class is never handed on with. */
function pagesOnly(reason: string): boolean {
  return (
    reason.startsWith(STATIC_PAGE) ||
    reason.startsWith(PAGES_FALLBACK) ||
    reason.startsWith('pages-data-record') ||
    reason === 'pages-data-capture'
  );
}

/** Read application-owned Pages bodies only as headers, retaining every other reader decision. */
export function pagesHeadersOnly(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  otherwise: ReadOptions['headersOnly'],
): ReadOptions['headersOnly'] {
  const asked = pagesAskedOf(stack, url, sent, 'GET');
  return (status, headers) => {
    const reason = HANDOFF.exec(String(headers[EDGE_HEADER] ?? ''))?.[1];
    return (
      (asked !== undefined && reason !== undefined && handsOnWith(asked, reason)) ||
      otherwise === true ||
      (typeof otherwise === 'function' && otherwise(status, headers))
    );
  };
}

/** The Pages reason the edge handed the request on with; nothing where it handed none. */
export function pagesHandoffOf(answer: Reading): string | undefined {
  const reason = HANDOFF.exec(answeredBy(answer))?.[1];
  return reason !== undefined && pagesOnly(reason) ? reason : undefined;
}

/** Why a Pages answer the edge served itself is not one it may share; nothing where it is. */
function sharedFailure(answer: Reading, served: string): string | undefined {
  const { headers } = answer;
  if (headers['set-cookie'] !== undefined) {
    return `answered a ${served} the edge shares with set-cookie`;
  }
  const control = headers['cache-control'] ?? '';
  if (control !== SHARED_REVALIDATION && control !== `${SHARED_REVALIDATION}${NO_TRANSFORM}`) {
    return `answered a ${served} the edge shares with cache-control ${control || 'unsaid'}, not ${SHARED_REVALIDATION}`;
  }
  const type = (headers['content-type'] ?? '').toLowerCase();
  const wanted = served === PAGES_DATA ? 'application/json' : 'text/html';
  return type.startsWith(wanted)
    ? undefined
    : `answered a ${served} the edge shares as ${type || 'no type'}, not ${wanted}`;
}

/**
 * The record a request so asked is answered from: a page's own, or — for a fallback route's member
 * the build did not write — the member's, as the edge derives it (`choose` in its fallback handler).
 */
async function entryOf(stack: CheckedStack, asked: PagesAsked): Promise<string | undefined> {
  const { classified } = asked;
  if (classified.kind === STATIC_PAGE) return classified.entry.entryId;
  const scopeId = stack.manifest.cache?.scopeId;
  if (scopeId === undefined || classified.kind !== PAGES_FALLBACK) return undefined;
  const derived = await deriveEntry(scopeId, {
    kind: 'pages',
    route: classified.entry.route,
    pathname: classified.pathname,
  });
  return derived.entryId;
}

/** The generations of the record a request so asked is answered from, as the stack's edge read them. */
async function generationsOf(
  stack: CheckedStack,
  asked: PagesAsked,
): Promise<readonly RecordedGeneration[]> {
  const scopeId = stack.manifest.cache?.scopeId;
  const entryId = await entryOf(stack, asked);
  if (scopeId === undefined || entryId === undefined) return [];
  return [...(await recordedGenerationsOf(stack, { scopeId, entryId })).values()];
}

/**
 * Props the edge served itself, held to its account of them (`x-nextjs-cache`) and to the bytes of
 * the props a generation of the page's record holds (`pageDataArtifact` in the edge).
 */
function dataVerdict(answer: Reading, generations: readonly RecordedGeneration[]): Verdict {
  if (generations.length === 0) {
    return failed(
      'answered props the edge served itself, of a page its record holds no generation of',
    );
  }
  const cache = String(answer.headers['x-nextjs-cache'] ?? '');
  if (!DATA_CACHE.has(cache)) {
    return failed(`answered props the edge served itself with x-nextjs-cache ${cache || 'unsaid'}`);
  }
  if (answer.truncated) return failed(undefined);
  const held = generations
    .flatMap((generation) => generation.artifacts)
    .filter((output) => output.role === PAGES_DATA || output.representationKey === PAGES_DATA);
  const own = held.some(
    (output) => output.sha256 === answer.sha256 && output.byteLength === answer.length,
  );
  return failed(
    own
      ? undefined
      : `answered props with ${String(answer.length)} bytes, not those of a generation its record holds`,
  );
}

/**
 * A page the edge served itself, held to the bytes it stands for: the build's, where the build
 * wrote it — other bytes left unjudged where a regeneration may have replaced them, said so — or,
 * for a fallback route's member the build did not write, a generation of its record, which a
 * completed render left: without one, its loading shell was due.
 */
function pageVerdict(
  stack: CheckedStack,
  url: URL,
  read: {
    readonly answer: Reading;
    readonly asked: PagesAsked;
    readonly generations: readonly RecordedGeneration[];
  },
): Verdict {
  const { answer, asked, generations } = read;
  if (asked.kind === PAGES_FALLBACK && generations.length === 0) {
    return failed(
      'answered a static-page of a fallback route member its record holds no generation of, where its loading shell was due',
    );
  }
  const entry = findStaticPage(stack.manifest, url.pathname);
  const route = entry === undefined ? undefined : stack.manifest.routes[entry.pathname];
  if (entry === undefined || route === undefined || answer.truncated) return failed(undefined);
  if (answer.sha256 === route.shell.sha256 && answer.length === route.shell.byteLength) {
    return failed(undefined);
  }
  return entry.staticPagePrivacy === undefined
    ? failed(
        `answered a static-page with ${String(answer.length)} bytes, not the bytes the build wrote for it`,
      )
    : skipped(
        'a static-page the edge serves from a record a regeneration may have replaced since the build, which the check keeps no copy of',
      );
}

/** A fallback route's loading shell the edge served itself, held to the bytes the build wrote. */
function loadingVerdict(
  stack: CheckedStack,
  url: URL,
  read: { readonly answer: Reading; readonly sent: Readonly<Record<string, string>> },
): Verdict {
  const { answer, sent } = read;
  const fallback = findPagesFallback(stack.manifest, url, edgeReads(sent));
  if (fallback === undefined) {
    return failed(`answered as a pages-fallback the manifest holds none of at ${url.pathname}`);
  }
  const { artifact } = fallback.entry.shell;
  return failed(
    answer.truncated || (answer.sha256 === artifact.sha256 && answer.length === artifact.byteLength)
      ? undefined
      : `answered a pages-fallback with ${String(answer.length)} bytes, not the loading shell the build wrote`,
  );
}

/**
 * A Pages answer the edge served itself, held to what makes it shareable and to what it stands for
 * (`pageVerdict`, `loadingVerdict`, `dataVerdict`): read at its headers alone, what they say is all
 * there is to judge of its bytes.
 */
async function servedVerdict(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  read: { readonly answer: Reading; readonly served: string; readonly asked: PagesAsked },
): Promise<Verdict> {
  const { answer, served, asked } = read;
  const unhealthy = failureStatus(answer);
  if (unhealthy !== undefined) return failed(unhealthy);
  if (answer.status !== HTTP_OK) {
    return failed(`answered ${String(answer.status)} as a ${served} the edge serves itself`);
  }
  const shared = sharedFailure(answer, served);
  if (shared !== undefined) return failed(shared);
  if (served === PAGES_FALLBACK) return loadingVerdict(stack, url, { answer, sent });
  const generations = await generationsOf(stack, asked);
  return served === PAGES_DATA
    ? dataVerdict(answer, generations)
    : pageVerdict(stack, url, { answer, asked, generations });
}

/**
 * A request of a Pages class judged as the edge answers it: by its class, its representation and
 * its method (`pagesAskedOf`), a handoff the edge gives it — the Function's to answer, and no shell
 * proof — or an answer the edge served itself (`servedVerdict`). Nothing for a request of no Pages
 * class answered as none.
 */
export async function pagesHandoffVerdict(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  read: { readonly answer: Reading; readonly method?: 'GET' | 'HEAD' },
): Promise<Verdict | undefined> {
  const { answer, method = 'GET' } = read;
  const asked = pagesAskedOf(stack, url, sent, method);
  const account = answeredBy(answer);
  const served = SERVED.exec(account)?.[1];
  const reason = HANDOFF.exec(account)?.[1];
  if (asked === undefined) {
    if (served !== undefined) {
      return failed(`Pages answer ${served} does not match the shared request classification none`);
    }
    return reason !== undefined && pagesOnly(reason)
      ? failed(`Pages handoff ${reason} does not match the shared request classification none`)
      : undefined;
  }
  const classification = `${asked.kind}${asked.data ? ' props' : ''}${asked.head ? ' HEAD' : ''}`;
  if (served !== undefined) {
    return servesAs(asked, served)
      ? await servedVerdict(stack, url, sent, { answer, served, asked })
      : failed(
          `Pages answer ${served} does not match the shared request classification ${classification}`,
        );
  }
  if (reason === undefined || !handsOnWith(asked, reason)) {
    return failed(
      `Pages handoff ${reason ?? 'none'} does not match the shared request classification ${classification}`,
    );
  }
  const unhealthy = failureStatus(answer);
  return unhealthy === undefined
    ? skipped(
        `the Function owns this ${asked.kind} request; its application body is not a shell proof`,
      )
    : failed(unhealthy);
}
