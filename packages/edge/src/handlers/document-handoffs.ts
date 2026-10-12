import { sandboxBlocksRecovery } from '@stayingupwind/core/request';

import type { DocumentInput } from './document.ts';

/**
 * The documents the edge hands to the application's Worker whole rather than compose itself
 * (`handleDocument`): each through the request's own passthrough (`DocumentInput.passthrough`),
 * counted under the route it was classified as.
 */

/**
 * A `HEAD` of a document a resume completes. What its headers are is decided by the part the
 * resume renders — a redirect, a cookie — which only the application knows: a `GET` here goes out
 * under the shell's status before that part is rendered, and learns of such a part only from the
 * resume it splices, which a `HEAD` would never run. Next.js answers a `HEAD` as it answers the
 * `GET`, so the application answers it, as it answered every `HEAD` before they were classified
 * with `GET`.
 */
export function headToApplication(input: DocumentInput): Promise<Response> {
  return input.passthrough('head-resumed', input.middleware, input.entry.pathname);
}

/** A request whose final policy blocks recovery must ask the Worker for a whole document. */
export function delegateSandboxedDocument(
  input: DocumentInput,
  complete: boolean,
  headers: Headers,
): Promise<Response> | undefined {
  const { edge, entry } = input;
  if (complete || edge.app === undefined) return undefined;
  const middleware = input.middleware?.kind === 'continue' ? input.middleware : undefined;
  // Middleware replaces a same-named response header. Nonce stamping and the remaining response
  // decorations do not change sandbox flags, so this is the policy the browser will enforce.
  const policy =
    middleware?.responseHeaders.get('content-security-policy') ??
    headers.get('content-security-policy');
  if (policy === null || sandboxBlocksRecovery(policy) === undefined) return undefined;
  return input.passthrough('csp-sandbox', input.middleware, entry.pathname);
}
