import { stripEdgeHeaders } from '../request-context.ts';

/**
 * What a route's gate is asked about a request of a method other than `GET` and `HEAD` — a Server
 * Action's `POST`, a form's, a `PUT`, a `DELETE`, an `OPTIONS` — in place of the request itself: a
 * probe (`probeOf`), a `GET` of the request's URL, which the gate answers as it answers a read of the
 * route, told the method it stands for beside it (`GATE_METHOD_HEADER`, set by `gateRequest`).
 *
 * The request's body is never the gate's: a body is a stream that can be read once, and the visitor's
 * goes to the Function, whole, where the gate passes the probe. A request built from the visitor's
 * would take that stream over (the Fetch standard's `Request` constructor proxies an input's body,
 * and refuses one beside a `GET`), and a copy would hold or tee what a client uploads. So the probe is
 * built from the URL alone, and carries none of the headers that describe a body it does not have, nor
 * the validators and range of a stored copy, which no `GET` of the visitor's asked for.
 */

/** Whether a request is asked of its gate by a probe (above), rather than as itself. */
export function askedByProbe(request: Request): boolean {
  return request.method !== 'GET' && request.method !== 'HEAD';
}

/** What frames or describes a body beside the `content-*` fields: none of it is a probe's. */
const BODY_FIELDS: ReadonlySet<string> = new Set([
  'digest',
  'expect',
  'repr-digest',
  'trailer',
  'transfer-encoding',
]);
/** What makes a `GET` conditional on, or partial of, a copy kept somewhere (RFC 9110 §13, §14). */
const STORED_COPY_FIELDS: ReadonlySet<string> = new Set([
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
]);

function probeCarries(name: string): boolean {
  return !name.startsWith('content-') && !BODY_FIELDS.has(name) && !STORED_COPY_FIELDS.has(name);
}

/**
 * The probe of `request` (above): a request of its URL alone, which is a `GET` with no body, on the
 * visitor's other headers, cancelled with `signal`. The visitor's request is left as it came, its
 * body unread.
 */
export function probeOf(request: Request, signal: AbortSignal): Request {
  const headers = stripEdgeHeaders(request.headers);
  const dropped = [...headers.keys()].filter((name) => !probeCarries(name));
  for (const name of dropped) {
    headers.delete(name);
  }
  return new Request(request.url, { headers, signal });
}
