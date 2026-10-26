/**
 * An Edge entrypoint's answer as Next.js hands it on from its own server: without `content-length`,
 * `content-encoding` and `transfer-encoding`, which `next start` deletes from every Edge function's
 * result (`FORBIDDEN_HEADERS`, `server/web/sandbox/sandbox.js`). They say how a body travels, and the
 * body an Edge function answers with is not always the one they described: one that answers with a
 * `fetch` as it is answers with the bytes Node.js's Fetch decoded, under the `content-encoding` they
 * arrived with, and the client then fails to decode them again (`Decompression failed`). The server
 * frames what it sends itself.
 *
 * The native target's alone, for Edge entrypoints alone, as Next.js does it: a Node.js route that
 * compresses its own body says so truly, and keeps the header. On Cloudflare's runtime workerd
 * encodes a body to the header it goes out under, so an answer passed on as it is arrives intact.
 *
 * Source for the Edge bundle's entry module (`emit.ts`), where each entrypoint's handler is wrapped as
 * it is loaded. An answer that carries none of the three — the usual one — is handed on as it is; one
 * that does is copied without them, its headers being the guarded ones of a `fetch` response.
 */
export const EDGE_ANSWER_WRAPPER = 'upwindEdgeAnswer';

export const EDGE_ANSWER_SOURCE = [
  'const TRANSPORT_HEADERS = ["content-length", "content-encoding", "transfer-encoding"];',
  'function edgeAnswerOf(response) {',
  '  if (!(response instanceof Response) || !TRANSPORT_HEADERS.some((name) => response.headers.has(name))) return response;',
  '  const headers = new Headers(response.headers);',
  '  for (const name of TRANSPORT_HEADERS) headers.delete(name);',
  '  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });',
  '}',
  `function ${EDGE_ANSWER_WRAPPER}(handler) {`,
  '  if (typeof handler !== "function") return handler;',
  '  return async (request, ctx) => edgeAnswerOf(await handler(request, ctx));',
  '}',
].join('\n');
