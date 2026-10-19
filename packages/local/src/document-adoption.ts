import { answeredBy, type CheckedStack } from './answers.ts';
import { browserCodingsOf } from './codings.ts';
import { capturedDocument } from './document-reading.ts';
import { documentVerdict } from './documents.ts';
import { documentRouteAt, exactRouteAt, landedRouteOf } from './landings.ts';
import { type Answered, answeredOf, type Sent } from './redirects.ts';

/** A redirected document's own reading and deferred verdict, retained while its trace still exists. */
export async function documentAnswerAt(
  stack: CheckedStack,
  headBytes: number,
  sent: Sent,
): Promise<Answered | string> {
  const { url, headers } = sent;
  const requested = `${url.pathname}${url.search}`;
  const coding = browserCodingsOf(headers['user-agent'] ?? '');
  const read = await capturedDocument(stack, headBytes, { requested, headers, coding });
  if (typeof read === 'string') {
    return read;
  }
  const answered = answeredOf(read.answer);
  const key =
    documentRouteAt(stack.manifest, url, headers) ??
    landedRouteOf(stack.manifest, answeredBy(read.answer));
  const route = key === undefined ? undefined : stack.manifest.routes[key];
  if (key === undefined || route === undefined) {
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
        kept: async () => read.kept,
      });
      return verdict.kind === 'failed' ? verdict.reason : undefined;
    },
  };
}
