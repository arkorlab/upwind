/**
 * The answers whose body goes out as the application encoded it (`encodeBody: 'manual'`, set by
 * `node-bridge.ts`). workerd keeps the setting on the `Response` but does not let it be read, so the
 * answers made again from one say so here, and one made with another status — which cannot be made
 * from the response itself — is given the setting again.
 */
const asEncoded = new WeakSet<Response>();

/** `response`, its body to go out as it is: one the bridge made with `encodeBody: 'manual'`. */
export function sentAsEncoded(response: Response): Response {
  asEncoded.add(response);
  return response;
}

/**
 * `response` again, its headers as `change` leaves them: made from the response itself, which keeps
 * what a runtime holds of one beside its status and headers. On workerd that includes a body the
 * application encoded itself (`encodeBody: 'manual'`, `node-bridge.ts`), which goes out as it is;
 * one remade from a plain init is encoded again to its `content-encoding`, and a route that gzips its
 * own answer reached its client compressed twice. Its status and status text are kept too.
 */
export function withHeadersChanged(
  response: Response,
  change: (headers: Headers) => void,
): Response {
  const changed = new Response(response.body, response);
  if (asEncoded.has(response)) {
    asEncoded.add(changed);
  }
  change(changed.headers);
  return changed;
}

/**
 * `response` under another status, with `body` in place of its own: made from a plain init, which a
 * status other than the response's needs, and given back the body's `encodeBody: 'manual'` where the
 * response had it (`sentAsEncoded`) — a route that gzips its own answer, reached through a rewrite
 * that names a status, went out compressed twice (greptile, Sentry).
 */
export function withStatus(response: Response, status: number, body: BodyInit | null): Response {
  const encoded = asEncoded.has(response);
  // workerd's own member of `ResponseInit`, which the DOM's type does not know.
  const init: ResponseInit & { readonly encodeBody?: 'manual' } = {
    status,
    headers: response.headers,
    ...(encoded && { encodeBody: 'manual' }),
  };
  const made = new Response(body, init);
  if (encoded) {
    asEncoded.add(made);
  }
  return made;
}
