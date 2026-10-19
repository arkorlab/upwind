import { type StaticFileEntry, staticFileKey } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';

import { type CheckedStack, keptFailure, keptOf, middlewareCovers, edgeReads } from './answers.ts';
import { type Decided, DID_NOT_RUN } from './file-expectations.ts';
import type { Reading } from './reading.ts';

/**
 * What the application's middleware decided for a request for a file, as the check reads it
 * (`files.ts`, `follow-ups.ts`): kept by the stack as the edge ran it (`keptOf`), and where it took
 * the request — onto another file of the build, onto none, or to other bytes of the file.
 */

/**
 * What a request selects of a file by beside its path: a range of it, and the conditions it is
 * answered on. The edge serves a file on the request as the middleware left it, so where the
 * middleware changed one of these, what comes back is the application's choosing.
 */
const SELECTING: readonly string[] = [
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
];
/** Why a file is judged no further where the middleware changed what the request selects of it. */
export const CHANGED_SELECTION =
  "the application's middleware changed what the request selects of the file (a range, a condition)";

/**
 * What the middleware decided for a request the edge answered, as the stack kept it — read whether
 * or not the edge says the middleware ran, which is what is checked: `DID_NOT_RUN` where it did not,
 * and a failure where the edge's word and what the stack kept disagree (`keptFailure`).
 */
export async function decisionOf(
  stack: CheckedStack,
  answer: Reading,
  asked: {
    readonly trace: string;
    readonly url: URL;
    readonly sent: Readonly<Record<string, string>>;
  },
): Promise<{ readonly decided: Decided } | { readonly failure: string }> {
  const { decided } = await keptOf(stack, asked.trace, asked.url, asked.sent);
  const failure = keptFailure(answer, decided, middlewareCovers(stack, asked.url, asked.sent));
  return failure === undefined ? { decided: decided ?? DID_NOT_RUN } : { failure };
}

/** The middleware's decision where it let the request on, rewritten or not; none otherwise. */
function continued(decided: Decided): Extract<MiddlewareResult, { kind: 'continue' }> | undefined {
  return decided !== DID_NOT_RUN && decided.kind === 'continue' ? decided : undefined;
}

/**
 * The pathname the middleware rewrote a request for a file onto, where that is no file of the build
 * — a route, a pathname the Function answers — which the edge hands on to the Function as rewritten
 * (`routeHostedStaticFile`), the middleware's to answer (`middlewareAnswered`), and serves nothing
 * of from storage. None where it rewrote the request onto a file, or not at all.
 */
export function rewrittenOntoNoFile(stack: CheckedStack, decided: Decided): string | undefined {
  const middleware = continued(decided);
  if (middleware?.rewritten !== true) {
    return undefined;
  }
  const { pathname } = middleware.url;
  return staticFileKey(stack.manifest, pathname) === undefined ? pathname : undefined;
}

/** Why a request rewritten onto `pathname`, no file of the build, fails, answered from storage. */
export function ignoredRewrite(pathname: string): string {
  return `the application's middleware rewrote it onto ${pathname}, which is no file of the build, and the edge answered it from storage`;
}

/**
 * The other file of the build the middleware rewrote a request for the file at `url` onto, which the
 * edge serves in its place (`shippedFileAt`): its key in the manifest and its entry. None where it
 * rewrote the request onto none, or onto the file itself — a query added, a locale in front.
 */
export function ontoAnotherFile(
  stack: CheckedStack,
  url: URL,
  decided: Decided,
): { readonly pathname: string; readonly file: StaticFileEntry } | undefined {
  const middleware = continued(decided);
  if (middleware?.rewritten !== true) {
    return undefined;
  }
  const { manifest } = stack;
  const onto = staticFileKey(manifest, middleware.url.pathname);
  const file = onto === undefined ? undefined : manifest.staticFiles?.[onto];
  return onto === undefined || file === undefined || onto === staticFileKey(manifest, url.pathname)
    ? undefined
    : { pathname: onto, file };
}

/** Whether the middleware left the request selecting of the file other than `sent` did. */
export function selectionChanged(
  sent: Readonly<Record<string, string>>,
  decided: Decided,
): boolean {
  const middleware = continued(decided);
  if (middleware === undefined) {
    return false;
  }
  const asked = edgeReads(sent);
  return SELECTING.some((name) => asked.get(name) !== middleware.requestHeaders.get(name));
}
