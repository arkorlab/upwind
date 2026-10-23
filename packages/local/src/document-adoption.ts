import {
  answeredBy,
  type CheckedStack,
  EDGE_HEADER,
  middlewareAnswered,
  middlewareHeadersOnly,
} from './answers.ts';
import { sentBlockingMetadata } from './browsers.ts';
import type { Accepted } from './codings.ts';
import { capturedDocument } from './document-reading.ts';
import { documentVerdict } from './documents.ts';
import { documentRouteAt, exactRouteAt, landedRouteOf } from './landings.ts';
import { pagesHandoffOf, pagesHandoffVerdict } from './pages-handoffs.ts';
import { type Answered, answeredOf, redirectHeaders, type Sent } from './redirects.ts';

/** A redirected document's own reading and deferred verdict, retained while its trace still exists. */
export async function documentAnswerAt(
  stack: CheckedStack,
  headBytes: number,
  sent: Sent,
  coding: Accepted,
): Promise<Answered | string> {
  const { url, headers } = sent;
  const requested = `${url.pathname}${url.search}`;
  const requestedKey = documentRouteAt(stack.manifest, url, headers);
  const keyOf = (account: string): string | undefined =>
    requestedKey ?? landedRouteOf(stack.manifest, account);
  const requestHeaders = new Headers(headers);
  const blockingOf = (key: string | undefined): boolean => {
    const route = key === undefined ? undefined : stack.manifest.routes[key];
    return route !== undefined && sentBlockingMetadata(stack.manifest, route, requestHeaders);
  };
  const read = await capturedDocument(stack, headBytes, {
    requested,
    headers,
    coding,
    headersOnly: (status, responseHeaders) => {
      if (redirectHeaders(status, responseHeaders)) {
        return true;
      }
      if (middlewareHeadersOnly(status, responseHeaders)) {
        return true;
      }
      const key = keyOf(String(responseHeaders[EDGE_HEADER] ?? ''));
      return key === undefined || blockingOf(key);
    },
  });
  if (typeof read === 'string') {
    return read;
  }
  const answered = answeredOf(read.answer);
  if (read.kind === 'headers' && redirectHeaders(read.answer.status, read.answer.headers)) {
    return answered;
  }
  if (middlewareAnswered(read.answer) !== undefined) {
    return { ...answered, documentFailure: () => Promise.resolve(undefined) };
  }
  const key = keyOf(answeredBy(read.answer));
  // A Pages handoff released at its headers (`pagesHeadersOnly`) is judged as a handoff — but an
  // answer released for its blocking metadata only where the edge handed it on: one the edge served
  // itself (a fallback's loading shell, Sentry) is no handoff missing, and is the route's below.
  const pages =
    read.kind === 'headers' && (!blockingOf(key) || pagesHandoffOf(read.answer) !== undefined)
      ? await pagesHandoffVerdict(stack, url, headers, { answer: read.answer })
      : undefined;
  if (pages !== undefined) {
    return {
      ...answered,
      documentFailure: () => Promise.resolve(pages.kind === 'failed' ? pages.reason : undefined),
    };
  }
  const route = key === undefined ? undefined : stack.manifest.routes[key];
  if (key === undefined || route === undefined) {
    return answered;
  }
  if (blockingOf(key)) {
    return { ...answered, documentFailure: () => Promise.resolve(undefined) };
  }
  if (read.kind === 'headers') {
    return answered;
  }
  const asked = {
    key,
    route,
    requested,
    headers,
    coding,
    exact: exactRouteAt(stack.manifest, url.pathname, key),
  };
  return {
    ...answered,
    documentFailure: async () => {
      const verdict = await documentVerdict(stack, asked, {
        answer: read.answer,
        kept: () => Promise.resolve(read.kept),
      });
      return verdict.kind === 'failed' ? verdict.reason : undefined;
    },
  };
}
