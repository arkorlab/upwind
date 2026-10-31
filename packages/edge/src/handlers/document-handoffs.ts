import { sandboxBlocksRecovery } from '@stayingupwind/core/request';
import type {
  ContinuationHandle,
  ContinuationResume,
  ContinuationStart,
} from '@stayingupwind/host/delivery';

import type { EdgeContext } from '../strategies/context.ts';
import { PublicationResumeUnavailableError } from '../strategies/continuation-publication.ts';
import { resumeContinuation } from '../strategies/continuation-resume.ts';
import type { ShellLoadResult } from '../strategies/shell-loader.ts';
import type { DocumentInput } from './document.ts';
import { abandonShellRead, withShellAccounting } from './observer.ts';

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

/** Give back an undispatched regeneration ask before handing unusable metadata to the Function. */
export function delegateCorruptDocument(
  input: DocumentInput,
  shellLookup: Promise<ShellLoadResult>,
): Promise<Response> {
  return delegateDocument(input, shellLookup, 'shell-corrupt');
}

/** No continuation was dispatched, so its ask and speculative build read remain this request's. */
export function delegateExpiredDocument(input: DocumentInput): Promise<Response> {
  const accounted = withShellAccounting(input);
  (input.generation?.onAbandoned ?? input.onBuildAbandoned)?.();
  abandonShellRead(accounted.edge, input.shellRead);
  return accounted.passthrough('publication-expired', input.middleware, input.entry.pathname);
}

function delegateDocument(
  input: DocumentInput,
  shellLookup: Promise<ShellLoadResult>,
  reason: string,
): Promise<Response> {
  (input.generation?.onAbandoned ?? input.onBuildAbandoned)?.();
  if (input.generation !== undefined) {
    input.edge.ctx.waitUntil(shellLookup);
    return input.passthrough(reason, input.middleware, input.entry.pathname);
  }
  const accounted = withShellAccounting(input);
  abandonShellRead(accounted.edge, shellLookup);
  return accounted.passthrough(reason, input.middleware, input.entry.pathname);
}

/** Keep the shared strategy's start contract; only this document can choose a whole render. */
export function startDocumentContinuation(
  selection: { readonly complete: boolean; readonly head: boolean },
  input: () => ContinuationStart<EdgeContext>,
): { readonly handle: ContinuationHandle | undefined; readonly unavailable?: true } {
  if (selection.complete || selection.head) return { handle: undefined };
  try {
    return { handle: resumeContinuation.start(input()) };
  } catch (error) {
    if (error instanceof PublicationResumeUnavailableError)
      return { handle: undefined, unavailable: true };
    throw error;
  }
}

/** A build keeps its state in the Worker; a regenerated shell carries its original state. */
export function documentResumeOf(
  generation: DocumentInput['generation'],
): ContinuationResume | undefined {
  if (generation === undefined || generation.pack.header.source === 'build') return undefined;
  const { postponed } = generation.pack;
  return postponed === undefined
    ? undefined
    : { kind: 'runtime', state: postponed, route: generation.pack.header.route };
}

interface SpeculativeRendering {
  readonly pending: Promise<void>;
  readonly ready: () => ShellLoadResult | undefined;
}

async function abandonedRendering(rendering: SpeculativeRendering): Promise<ShellLoadResult> {
  await rendering.pending;
  return rendering.ready() ?? { kind: 'unavailable', detail: 'The shell rendering failed.' };
}

/** No selected bytes or response headers have escaped when the proof handoff is refused. */
export function delegateUnresumableDocument(
  input: DocumentInput,
  shellLookup: Promise<ShellLoadResult>,
  rendering: SpeculativeRendering | undefined,
): Promise<Response> {
  const accounted = withShellAccounting(input);
  if (rendering !== undefined) abandonShellRead(accounted.edge, abandonedRendering(rendering));
  return delegateDocument(accounted, shellLookup, 'publication-handoff-unavailable');
}

/**
 * A request whose final policy blocks recovery must ask the Worker for a whole document. No resume
 * goes out for its regeneration ask to ride beside, so the ask is given back before the handoff, as
 * for unusable metadata (Sentry): the next request may ask again rather than wait out the cooldown.
 */
export function delegateSandboxedDocument(
  input: DocumentInput,
  complete: boolean,
  headers: Headers,
  shellLookup: Promise<ShellLoadResult>,
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
  (input.generation?.onAbandoned ?? input.onBuildAbandoned)?.();
  if (input.generation !== undefined) {
    // generationShell is a synthetic view of metadata already read, not another backend lookup.
    edge.ctx.waitUntil(shellLookup);
    return input.passthrough('csp-sandbox', input.middleware, entry.pathname);
  }
  const accounted = withShellAccounting(input);
  abandonShellRead(accounted.edge, shellLookup);
  return accounted.passthrough('csp-sandbox', input.middleware, entry.pathname);
}
