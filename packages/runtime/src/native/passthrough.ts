import {
  hasRouteBodyControlHeader,
  NULL_BODY_STATUSES,
  PLATFORM_HEADER_PREFIX,
  SHARED_CACHE_CONTROL_HEADERS,
  unsharedUnlessPublic,
} from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

/**
 * What the native target answers of everything the edge would pass on: as the edge passes a
 * Function's answer on (`passthrough.ts` in the edge, and its own answers for a middleware,
 * `middleware.ts`). What the application said of its keeping stands for a shared cache only where
 * it said `public` of itself, to a request that carried nothing of a visitor's — as the client sent
 * it, and as a middleware handed it on — and the application set no cookie; otherwise `s-maxage`
 * goes and the answer is the visitor's, and one that said nothing is kept by no one
 * (`unsharedUnlessPublic`).
 *
 * Not a shipped file, nor an image, which the edge answers by handlers of their own: those are
 * decided apart, before routing lays its headers over them (`decidedApart`), and go out as their own
 * rules left them. Nor what `delivery.ts` decides by the edge's rules for a prerendered output, but
 * where it leaves one to its visitor.
 */

/** An answer of a kind decided by a rule of its own (`decidedApart`): a shipped file, an image. */
const APART = `${PLATFORM_HEADER_PREFIX}apart`;
const CACHE_CONTROL = 'cache-control';

/** Each client's request as the middleware that ran for it handed it on (`handedOn`). */
const handedRequests = new WeakMap<Request, Headers>();

/** `answer` again under `headers`: its status and its body, but none for a status that has none. */
function reframed(answer: Response, headers: Headers): Response {
  const bodyless = NULL_BODY_STATUSES.has(answer.status);
  if (bodyless) releaseStream(answer.body, 'a status with no body');
  return new Response(bodyless ? null : answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

export function decidedApart(answer: Response): Response {
  const headers = new Headers(answer.headers);
  headers.set(APART, '1');
  return reframed(answer, headers);
}

/**
 * An answer decided apart, as its own rules left it — without the mark, which is the platform's —
 * or `undefined` for any other.
 */
export function leftApart(answer: Response): Response | undefined {
  if (!answer.headers.has(APART)) return undefined;
  const headers = new Headers(answer.headers);
  headers.delete(APART);
  return reframed(answer, headers);
}

export function handedOn(request: Request, headers: Headers): void {
  handedRequests.set(request, headers);
}

/**
 * Whether headers a request carried hold nothing of a visitor's an answer could have been told by,
 * as the edge judges them (`anonymousRequest`): no cookie and no `Authorization` — all the
 * visitor's own here, a host having no credentials of its own to take off — and none of Next.js's
 * control or router-protocol headers (`hasRouteBodyControlHeader`), which a navigation's payload is
 * told apart from its document by. A validation, the edge's other case, is the edge's own.
 */
function carriesNothingOfAVisitor(headers: Headers): boolean {
  return (
    !headers.has('cookie') && !headers.has('authorization') && !hasRouteBodyControlHeader(headers)
  );
}

/** As the client sent the request, and as the middleware that ran for it handed it on. */
function anonymous(request: Request): boolean {
  const handed = handedRequests.get(request);
  return (
    carriesNothingOfAVisitor(request.headers) &&
    (handed === undefined || carriesNothingOfAVisitor(handed))
  );
}

/**
 * An answer as the edge passes on a Function's (`unsharedUnlessPublic`): the application's word that
 * shared caches may keep it standing where it said `public`, to an anonymous request and with no
 * cookie set; `s-maxage` gone and the answer the visitor's otherwise; no word, kept by no one. The
 * same answer where none of that changes it.
 */
export function passedOn(request: Request, answer: Response): Response {
  const headers = new Headers(answer.headers);
  unsharedUnlessPublic(headers, anonymous(request));
  const unchanged =
    headers.get(CACHE_CONTROL) === answer.headers.get(CACHE_CONTROL) &&
    SHARED_CACHE_CONTROL_HEADERS.every((name) => !answer.headers.has(name));
  return unchanged ? answer : reframed(answer, headers);
}
