import { releaseStream } from '@stayingupwind/core/util';
import type { ContinuationHandle } from '@stayingupwind/host/delivery';

import type { ContinuationFailureKind } from '../reports.ts';
import type { ShellLoadResult } from '../strategies/shell-loader.ts';
import type { DocumentInput } from './document.ts';

/**
 * The resume as the document handler holds it: observed from the moment it starts, and what
 * becomes of it when the shell it was to complete cannot be served.
 */

export type Upstream =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly error: unknown };

/**
 * Observe the resume from the moment it starts: its consumer (splice or fallback) is chosen only
 * after the shell lookup, and a rejection before that must not go unhandled.
 */
export async function settle(promise: Promise<Response>): Promise<Upstream> {
  try {
    return { ok: true, response: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Let go of a response nobody is going to read. */
async function releaseUpstream(upstream: Promise<Upstream>): Promise<void> {
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

export interface ShellFailure {
  readonly reason: ContinuationFailureKind;
  readonly detail: string | undefined;
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
  failure: ShellFailure,
  handle?: ContinuationHandle,
): Promise<Response> {
  const { edge, entry } = input;
  const { reason } = failure;
  // Reported, as a validation request's failures are not; a host may count these rather than send
  // each, since a storage outage fails every document (`RouteReports`).
  const sent = edge.validated
    ? undefined
    : edge.runtime.reports?.report({
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
  handle?.abort(reason);
  edge.ctx.waitUntil(releaseUpstream(upstream));
  // As every passthrough of the request goes: routed again from the pointer when its Workers turned
  // out to be gone (`DocumentInput.passthrough`), and counted under the route.
  return input.passthrough(reason, input.middleware, entry.pathname);
}
