/**
 * An Edge entrypoint's answer as the Node.js server sends it (`node-function-parts.ts`): without
 * `content-encoding`, `content-length` and `transfer-encoding`, the three Next.js deletes from every
 * Edge function's result (`FORBIDDEN_HEADERS`, `server/web/sandbox/sandbox.js`). An Edge handler
 * answers with a Web `Response`, and one that hands a `fetch` on unchanged hands over the bytes
 * Node.js's Fetch decoded under the headers they arrived with: a coding they no longer have, and
 * the encoded length, which on a connection kept for the next request ends the answer early and
 * leaves the rest to be read as another answer (GHSA-pc58-hwjq-p385). Node then frames what it
 * writes.
 *
 * Every Edge answer, as Next.js does: a fetched response cannot be told from one the application
 * made, so an Edge route that compresses its own body is sent as plain bytes, and compressing is
 * left to the server in front. A Node.js handler's answer is not one of these — the loopback bridge
 * reads it as written, and it is sent so — and neither is anything on another target: the native
 * target keeps a coding Fetch did not decode (`native/edge-answer.ts`), and workerd encodes a body
 * to the header it goes out under.
 *
 * Source for the Edge bundle's entry module (`edgeEntrySource`), where each entrypoint's handler
 * is wrapped as it is loaded. An answer that carries none of the three — the usual one — is handed
 * on as it is; one that does is made again without them, since a fetched response's headers cannot
 * be changed.
 */
export const NODE_EDGE_ANSWER_WRAPPER = 'upwindNodeEdgeAnswer';

export const NODE_EDGE_ANSWER_SOURCE = [
  'const NODE_FRAMING_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];',
  'function nodeEdgeAnswerOf(response) {',
  '  if (!(response instanceof Response)) return response;',
  '  if (!NODE_FRAMING_HEADERS.some((name) => response.headers.has(name))) return response;',
  '  const headers = new Headers(response.headers);',
  '  for (const name of NODE_FRAMING_HEADERS) headers.delete(name);',
  '  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });',
  '}',
  `function ${NODE_EDGE_ANSWER_WRAPPER}(handler) {`,
  '  if (typeof handler !== "function") return handler;',
  '  return async (request, ctx) => nodeEdgeAnswerOf(await handler(request, ctx));',
  '}',
].join('\n');
