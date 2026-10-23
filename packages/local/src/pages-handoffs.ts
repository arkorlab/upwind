import { classifyRequest } from '@stayingupwind/core/request';

import {
  answeredBy,
  type CheckedStack,
  EDGE_HEADER,
  failed,
  failureStatus,
  skipped,
  type Verdict,
} from './answers.ts';
import type { ReadOptions, Reading } from './reading.ts';
import { classifiedReads } from './routing-reads.ts';

const PAGES_HANDOFF = /^passthrough;reason=(static-page|pages-fallback|static-page-bypass)(?:;|$)/u;

/** The current edge hands these shared Pages classes to the Function before edge middleware. */
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
    headers: classifiedReads(manifest, url, headers),
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

/** Require the exact shared-classifier handoff; application rendering is no shell-byte proof. */
export function pagesHandoffVerdict(
  stack: CheckedStack,
  url: URL,
  sent: Readonly<Record<string, string>>,
  read: { readonly answer: Reading; readonly method?: 'GET' | 'HEAD' },
): Verdict | undefined {
  const { answer, method = 'GET' } = read;
  const expected = expectedHandoff(stack, url, sent, method);
  const actual = PAGES_HANDOFF.exec(answeredBy(answer))?.[1];
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
