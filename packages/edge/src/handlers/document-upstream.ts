import { releaseStream } from '@stayingupwind/core/util';
import type { ContinuationHandle } from '@stayingupwind/host/delivery';
import type { SpliceOutcome } from '@stayingupwind/host/splice';

import type { ContinuationFailureKind } from '../reports.ts';
import { stripEdgeHeaders } from '../request-context.ts';
import type { EdgeContext } from '../strategies/context.ts';
import type { ShellLoadResult } from '../strategies/shell-loader.ts';
import type { DocumentInput } from './document.ts';
import { sendReport } from './observer.ts';
import { dispatchesMade } from './upstream.ts';

/**
 * The resume as the document handler holds it: observed from the moment it starts, and what
 * becomes of it when the shell it was to complete cannot be served.
 */

export type Upstream =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly error: unknown };

/** What lets an ask be made again until the runtime answers and owns its background job. */
export interface PendingRegeneration {
  onAbandoned: (() => void) | undefined;
}

/**
 * Observe the resume from the moment it starts: its consumer (splice or fallback) is chosen only
 * after the shell lookup, and a rejection before that must not go unhandled.
 */
export async function settle(
  promise: Promise<Response>,
  regeneration?: PendingRegeneration,
): Promise<Upstream> {
  try {
    const response = await promise;
    if (regeneration !== undefined) {
      regeneration.onAbandoned = undefined;
    }
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Let go of a response nobody is going to read. */
export async function releaseUpstream(upstream: Promise<Upstream>): Promise<void> {
  const result = await upstream;
  if (result.ok) {
    releaseStream(result.response.body, 'resume abandoned');
  }
}

/** Re-raise the settled result for consumers that expect a plain response promise. */
export async function unsettle(settled: Promise<Upstream>): Promise<Response> {
  const result = await settled;
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.response;
}

/**
 * The request the continuation is asked for: the client's, or the request as the middleware left
 * it — its rewrite target and its headers — with the URL the client asked for kept on the context
 * for the runtime to see.
 */
export function continuationRequest(input: DocumentInput): { client: Request; edge: EdgeContext } {
  const { middleware } = input;
  const stripped = stripEdgeHeaders(input.request.headers);
  if (middleware?.kind !== 'continue') {
    return { client: new Request(input.request, { headers: stripped }), edge: input.edge };
  }
  const client = new Request(middleware.url.href, {
    method: input.request.method,
    headers: stripEdgeHeaders(middleware.requestHeaders),
  });
  return {
    client,
    edge: middleware.rewritten ? { ...input.edge, originalUrl: input.request.url } : input.edge,
  };
}

/** Why a resume is let go of when its client leaves before a splice holds it. */
const CLIENT_LEFT = 'client left';

/**
 * Let the resume go with a client that leaves before a splice holds it. The splice lets it go with
 * the client from then on, as the client cancels what it reads; until then nothing would, and the
 * application's Worker would render on for nobody while the shell was read, then until the
 * continuation's deadline. The returned call stops following the client, once a splice is about to
 * hold the resume, and says whether the client left by then, taking the resume with it.
 */
export function followClient(
  signal: AbortSignal,
  handle: ContinuationHandle | undefined,
  regeneration?: PendingRegeneration,
): () => boolean {
  if (handle === undefined) {
    return () => false;
  }
  const leave = (): void => {
    regeneration?.onAbandoned?.();
    handle.abort(CLIENT_LEFT);
  };
  if (signal.aborted) {
    leave();
  } else {
    signal.addEventListener('abort', leave, { once: true });
  }
  return () => {
    signal.removeEventListener('abort', leave);
    return signal.aborted;
  };
}

interface FollowedResume {
  readonly upstream: Promise<Upstream> | undefined;
  readonly clientLeft: () => boolean;
  readonly cancelled: (outcome: SpliceOutcome) => void;
}

/** Follow a resume through both the shell lookup and the splice, until its answer owns the job. */
export function followResume(
  input: DocumentInput,
  handle: ContinuationHandle | undefined,
): FollowedResume {
  const regeneration: PendingRegeneration | undefined =
    input.generation?.onAbandoned === undefined
      ? undefined
      : { onAbandoned: input.generation.onAbandoned };
  return {
    upstream: handle === undefined ? undefined : settle(handle.response, regeneration),
    clientLeft: followClient(input.request.signal, handle, regeneration),
    cancelled: (outcome) => {
      if (outcome.kind === 'client-cancelled') {
        regeneration?.onAbandoned?.();
      }
    },
  };
}

export interface ShellFailure {
  readonly reason: ContinuationFailureKind;
  readonly detail: string | undefined;
}

/** A shell that could not be served: why, and the reads of storage it and its rendering took. */
export interface FailedShell extends ShellFailure {
  readonly storageReads: number;
}

export function shellFailure(shell: Exclude<ShellLoadResult, { kind: 'ok' }>): ShellFailure {
  switch (shell.kind) {
    case 'missing': {
      return { reason: 'shell-missing', detail: undefined };
    }
    case 'corrupt': {
      return { reason: 'shell-corrupt', detail: shell.source };
    }
    case 'unavailable': {
      return { reason: 'shell-unavailable', detail: shell.detail };
    }
  }
}

/**
 * The shell is unavailable, so there is nothing for the resume to complete: it is the suffix
 * alone, no document on its own. The application's Worker is asked for the whole document
 * instead, as it would be for any request the edge cannot serve, and the resume is let go.
 */
export function fallbackToApp(
  input: DocumentInput,
  upstream: Promise<Upstream>,
  failure: FailedShell,
  handle?: ContinuationHandle,
): Promise<Response> {
  const { edge, entry } = input;
  const { reason } = failure;
  // Reported, as a validation request's failures are not; a host may count these rather than send
  // each, since a storage outage fails every document (`RouteReports`).
  const sent = edge.validated
    ? undefined
    : sendReport(edge.runtime.reports, {
        projectId: edge.projectId,
        manifestId: edge.manifestId,
        pathname: entry.pathname,
        colo: edge.colo,
        kind: 'continuation-failure',
        reason,
        detail: failure.detail,
      });
  if (sent !== undefined) {
    edge.ctx.waitUntil(sent);
  }
  // What the resume had sent before it is let go: none where there was no resume to send.
  const resumeDispatches = handle === undefined ? 0 : dispatchesMade(handle.response);
  handle?.abort(reason);
  edge.ctx.waitUntil(releaseUpstream(upstream));
  // As every passthrough of the request goes: routed again from the pointer when its Workers turned
  // out to be gone (`DocumentInput.passthrough`), and counted under the route — with the reads that
  // found no shell to serve and the resume let go, which went out all the same, as a served
  // document's are counted.
  return input.passthrough(reason, input.middleware, entry.pathname, {
    storageReads: failure.storageReads,
    resumeDispatches,
  });
}
