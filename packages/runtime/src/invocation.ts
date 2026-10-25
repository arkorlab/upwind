import type { IncomingMessage, ServerResponse } from 'node:http';

import type { NodeHandler } from './app-module.ts';

/** Re-enter the request's context after a transport crossed an HTTP boundary. */
export type Run = <T>(work: () => Promise<T>) => Promise<T>;

/** The route's error page, when it can still answer before any headers were committed. */
export type FailureAnswer = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/**
 * The complete invocation contract, independent of the transport. Metadata deliberately stays in
 * memory: it can contain callbacks, including Next.js's capture and not-found handlers.
 */
export interface InvokeInput {
  readonly handler: NodeHandler;
  readonly request: Request;
  readonly url?: string | undefined;
  readonly requestMeta: Record<string, unknown>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly run?: Run | undefined;
  /** A capture can answer through its callback without ever writing an HTTP response. */
  readonly expectNoResponse?: boolean | undefined;
  readonly onFailure?: FailureAnswer | undefined;
  readonly status?: number | undefined;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function changesSomething(method: string): boolean {
  return !SAFE_METHODS.has(method);
}
