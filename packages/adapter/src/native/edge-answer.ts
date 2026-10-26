import { NATIVE_EDGE_WEB_BINDING } from './edge-web.ts';

/**
 * An Edge entrypoint's answer as it can be sent from Node.js: without `content-length` and
 * `transfer-encoding`, which say how a body travels and which the server sets itself, and without a
 * `content-encoding` its bytes no longer have. `next start` deletes all three from every Edge
 * function's result (`FORBIDDEN_HEADERS`, `server/web/sandbox/sandbox.js`), because an Edge function
 * that answers with a `fetch` answers with the bytes Node.js's Fetch decoded, under the coding they
 * arrived with, and a client then fails to decode them again (`Decompression failed`).
 *
 * The coding is dropped where it no longer holds alone (Sentry): for an answer that is a `fetch`'s as
 * it is (`type` not `default`) under a coding Fetch decodes (`fetchDecodes`; one it does not decode
 * still describes the bytes, Codex), or one made of a body Node.js's Fetch decoded — the Edge
 * bundle's `fetch` notes such a body (`decodedBody`, `edge-web.ts`), which an answer made again of
 * it, or of a clone of it, carries. A body the application made anew of decoded bytes, piped
 * through a stream of its own, is not known for one: its coding is kept, as the application left it.
 * One whose bytes the route compressed itself and says so keeps it, and arrives as it would deployed;
 * `next start` sends those bytes as if they were plain.
 *
 * The native target's alone, for Edge entrypoints alone: a Node.js route that compresses its own body
 * says so truly, and keeps the header. On Cloudflare's runtime workerd encodes a body to the header it
 * goes out under, so an answer passed on as it is arrives intact.
 *
 * Source for the Edge bundle's entry module (`emit.ts`), where each entrypoint's handler is wrapped as
 * it is loaded; the bundle injects the object it reads `decodedBody` off. An answer that carries none
 * of the headers to drop — the usual one — is handed on as it is; one that does is copied without
 * them, its headers being the guarded ones of a `fetch` response.
 */
export const EDGE_ANSWER_WRAPPER = 'upwindEdgeAnswer';

export const EDGE_ANSWER_SOURCE = [
  'const FRAMING_HEADERS = ["content-length", "transfer-encoding"];',
  'const DECODED_HEADERS = [...FRAMING_HEADERS, "content-encoding"];',
  'function edgeAnswerOf(response) {',
  '  if (!(response instanceof Response)) return response;',
  // A fetch's answer as it is was decoded where Fetch decodes its coding; one made again, where its
  // body is one Fetch decoded.
  `  const decoded = response.type === "default" ? ${NATIVE_EDGE_WEB_BINDING}.decodedBody(response.body) : ${NATIVE_EDGE_WEB_BINDING}.fetchDecodes(response.headers.get("content-encoding"));`,
  '  const dropped = decoded ? DECODED_HEADERS : FRAMING_HEADERS;',
  '  if (!dropped.some((name) => response.headers.has(name))) return response;',
  '  const headers = new Headers(response.headers);',
  '  for (const name of dropped) headers.delete(name);',
  '  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });',
  '}',
  `function ${EDGE_ANSWER_WRAPPER}(handler) {`,
  '  if (typeof handler !== "function") return handler;',
  '  return async (request, ctx) => edgeAnswerOf(await handler(request, ctx));',
  '}',
].join('\n');
