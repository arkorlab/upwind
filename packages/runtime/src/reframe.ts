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
  change(changed.headers);
  return changed;
}
