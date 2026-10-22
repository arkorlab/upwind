import { findPagesFallback, findStaticPage } from '@stayingupwind/core/manifest';
import { classifyRequest } from '@stayingupwind/core/request';

import {
  answeredBy,
  type CheckedStack,
  EDGE_HEADER,
  edgeReads,
  failed,
  failureStatus,
  skipped,
  type Verdict,
} from './answers.ts';
import type { ReadOptions, Reading } from './reading.ts';

const PAGES_HANDOFF = /^passthrough;reason=(static-page|pages-fallback|static-page-bypass)(?:;|$)/u;
/** A shared Pages class the edge answered itself, from a source of its own (`serveCurrentPage`). */
const PAGES_SERVED = /^(static-page|pages-fallback);src=[^;]*(?:;|$)/u;
const HTTP_OK = 200;
/** How the edge shares a Pages answer of its own, `no-transform` kept where the page asked it. */
const SHARED_REVALIDATION = 'public, max-age=0, must-revalidate';
const NO_TRANSFORM = ', no-transform';

/**
 * The class the shared classifier gives a Pages request, which the edge answers itself — a static
 * page from its record, a fallback route's loading shell from the build — or hands to the Function
 * before the middleware (`passthrough;reason=…`).
 */
function expectedHandoff(
  stack: CheckedStack,
  url: URL,
  headers: Readonly<Record<string, string>>,
  method: 'GET' | 'HEAD',
): string | undefined {
  const { manifest } = stack;
  if (manifest.staticPages === undefined && manifest.pagesFallbacks === undefined) return undefined;
  const classified = classifyRequest({
    method,
    url,
    headers: edgeReads(headers),
    manifest,
    deployment: manifest.deployment,
  });
  if (classified.kind === 'static-page' || classified.kind === 'pages-fallback') {
    return classified.kind;
  }
  return classified.kind === 'passthrough' && classified.reason === 'static-page-bypass'
    ? classified.reason
    : undefined;
}

/** Read application-owned Pages bodies only as headers, retaining every other reader decision. */
export function pagesHeadersOnly(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  otherwise: ReadOptions['headersOnly'],
): ReadOptions['headersOnly'] {
  const expected = expectedHandoff(stack, url, sent, 'GET');
  return (status, headers) => {
    const given = PAGES_HANDOFF.exec(String(headers[EDGE_HEADER] ?? ''))?.[1];
    return (
      (expected !== undefined && given === expected) ||
      otherwise === true ||
      (typeof otherwise === 'function' && otherwise(status, headers))
    );
  };
}

/** The shared Pages class the edge handed the request on as; nothing where it handed none. */
export function pagesHandoffOf(answer: Reading): string | undefined {
  return PAGES_HANDOFF.exec(answeredBy(answer))?.[1];
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
  const type = headers['content-type'] ?? '';
  return type.toLowerCase().startsWith('text/html')
    ? undefined
    : `answered a ${served} the edge shares as ${type || 'no type'}, not HTML`;
}

/**
 * The bytes a Pages answer the edge served itself stands for: a static page's record, which the
 * build's prerender seeded and a regeneration alone replaces — none of a page the build did not
 * leave static (`regenerable`) — or a fallback route's loading shell, which is the build's alone.
 */
function servedBytes(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  served: string,
):
  | { readonly sha256: string; readonly byteLength: number; readonly regenerable: boolean }
  | undefined {
  const { manifest } = stack;
  if (served === 'static-page') {
    const entry = findStaticPage(manifest, url.pathname);
    const route = entry === undefined ? undefined : manifest.routes[entry.pathname];
    return entry === undefined || route === undefined
      ? undefined
      : { ...route.shell, regenerable: entry.staticPagePrivacy !== undefined };
  }
  const fallback = findPagesFallback(manifest, url, edgeReads(sent));
  return fallback === undefined
    ? undefined
    : { ...fallback.entry.shell.artifact, regenerable: false };
}

/**
 * A Pages answer the edge served itself, held to what makes it shareable and to the bytes it stands
 * for (`servedBytes`): read at its headers alone, the first is all there is to judge.
 */
function servedVerdict(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  read: { readonly answer: Reading; readonly served: string },
): Verdict {
  const { answer, served } = read;
  const unhealthy = failureStatus(answer);
  if (unhealthy !== undefined) return failed(unhealthy);
  if (answer.status !== HTTP_OK) {
    return failed(`answered ${String(answer.status)} as a ${served} the edge serves itself`);
  }
  const shared = sharedFailure(answer, served);
  if (shared !== undefined || answer.truncated) return failed(shared);
  const bytes = servedBytes(stack, url, sent, served);
  if (bytes === undefined) {
    return failed(`answered as a ${served} the manifest holds none of at ${url.pathname}`);
  }
  if (answer.sha256 === bytes.sha256 && answer.length === bytes.byteLength)
    return failed(undefined);
  return bytes.regenerable
    ? skipped(
        `a ${served} the edge serves from a record a regeneration may have replaced since the build, which the check keeps no copy of`,
      )
    : failed(
        `answered a ${served} with ${String(answer.length)} bytes, not the bytes the build wrote for it`,
      );
}

/**
 * Require the exact shared-classifier handoff, where the edge hands the request on — application
 * rendering is no shell-byte proof — and hold an answer the edge served itself to its own rules
 * (`servedVerdict`).
 */
export function pagesHandoffVerdict(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  read: { readonly answer: Reading; readonly method?: 'GET' | 'HEAD' },
): Verdict | undefined {
  const { answer, method = 'GET' } = read;
  const expected = expectedHandoff(stack, url, sent, method);
  const served = PAGES_SERVED.exec(answeredBy(answer))?.[1];
  if (served !== undefined) {
    return served === expected
      ? servedVerdict(stack, url, sent, { answer, served })
      : failed(
          `Pages answer ${served} does not match the shared request classification ${expected ?? 'none'}`,
        );
  }
  const actual = pagesHandoffOf(answer);
  if (expected === undefined) {
    return actual === undefined
      ? undefined
      : failed(`Pages handoff ${actual} does not match the shared request classification none`);
  }
  if (actual !== expected) {
    return failed(
      `Pages handoff ${actual ?? 'none'} does not match the shared request classification ${expected}`,
    );
  }
  const unhealthy = failureStatus(answer);
  return unhealthy === undefined
    ? skipped(
        `the Function owns this ${expected} request; its application body is not a shell proof`,
      )
    : failed(unhealthy);
}
