import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';

const CONTENT_LENGTH = 'content-length';

/** Flat `[name, value, …]` headers, as `writeHead` takes them, without a length. */
function lengthlessPairs(headers: readonly unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (let index = 0; index + 1 < headers.length; index += 2) {
    const name: unknown = headers[index];
    if (typeof name === 'string' && name.toLowerCase() === CONTENT_LENGTH) continue;
    kept.push(name, headers[index + 1]);
  }
  return kept;
}

/** Headers by name, as `writeHead` takes them, without a length. */
function lengthlessFields(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== CONTENT_LENGTH) kept[name] = value;
  }
  return kept;
}

/**
 * Node frames a loopback answer's body itself, by what the handler writes, never by the length the
 * handler names. A `Content-Length` it names that is not the body's — a fetched answer Next.js
 * before 16.4.5 forwards decoded under the encoded length (GHSA-pc58-hwjq-p385) — would end the
 * answer early on a connection kept for the next request, which would then read the rest as its own.
 * An answer whose handler named no length keeps the one Node counts for a body `end` is given
 * whole; one that named a length is chunked. An answer to `HEAD` keeps its length, which is the
 * `GET` body's and frames nothing.
 */
export function ownFraming(method: string | undefined, res: ServerResponse): void {
  if (method === 'HEAD') return;
  const writeHead = res.writeHead.bind(res) as (status: number, ...rest: unknown[]) => unknown;
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    // Only where it is there: a removed length is one Node does not count again either.
    if (res.hasHeader(CONTENT_LENGTH)) res.removeHeader(CONTENT_LENGTH);
    const last = rest.at(-1);
    if (Array.isArray(last)) rest[rest.length - 1] = lengthlessPairs(last);
    else if (typeof last === 'object' && last !== null)
      rest[rest.length - 1] = lengthlessFields(last as OutgoingHttpHeaders);
    return writeHead(status, ...rest);
  }) as typeof res.writeHead;
}
