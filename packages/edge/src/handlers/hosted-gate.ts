import { isReserved, type ProjectManifest } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import { PatternBudgetExceededError } from '@stayingupwind/core/request';

import type { EdgeContext } from '../strategies/context.ts';
import {
  decideMiddleware,
  followExternalRewrite,
  judgeHeaderRulesAhead,
  middlewareFailedReason,
  middlewareMatches,
  type MiddlewareOutcome,
  middlewareResponse,
  type MiddlewareTiming,
} from './middleware.ts';
import { PATTERN_BUDGET } from './passthrough.ts';

export type MiddlewareContinue = Extract<MiddlewareResult, { kind: 'continue' }>;

export interface HostedGateInput {
  readonly request: Request;
  readonly url: URL;
  readonly edge: EdgeContext;
  readonly manifest: ProjectManifest;
  /**
   * Proxy the request to the application's Worker, with what the middleware decided if it ran —
   * and how long it took, which the answer's metric records (`passthroughFor`, in `route.ts`).
   */
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome & Partial<MiddlewareTiming>,
  ) => Promise<Response>;
}

export interface HostedGate {
  /**
   * Answer the request as it stands, with what the middleware set when it ran, and the dispatches
   * it took to decide (`decideMiddleware`: none, one, or two after a retry), which the answer's
   * metric counts among its subrequests.
   */
  readonly serve: (
    middleware: MiddlewareContinue | undefined,
    dispatches: number,
  ) => Promise<Response>;
  /**
   * Answer a request the middleware rewrote elsewhere, when the edge can; `undefined` hands it to
   * the Worker. Absent, every rewrite is the Worker's.
   */
  readonly rewritten?: (
    middleware: MiddlewareContinue,
    dispatches: number,
  ) => Promise<Response> | undefined;
  /**
   * Start what the answer will need while the middleware decides whether there is to be one — a
   * read of storage, which would otherwise wait behind the middleware's whole round trip. Called
   * only when the middleware runs; `serve` and `rewritten` take what it started or let it go, and
   * `abandon` lets it go when neither is asked.
   */
  readonly start?: () => void;
  readonly abandon?: () => void;
  /**
   * What answers where a pattern of the application's costs more against the request, as the
   * middleware left it, than the edge runs (`budgetPatterns`). Absent, the Worker, handed what the
   * middleware decided; an image refuses instead, since no Worker of the application optimizes one.
   */
  readonly overBudget?: () => Promise<Response>;
}

/**
 * Serve something the edge holds for a hosted application — a shipped file, an optimized image —
 * once what Next.js runs ahead of its filesystem has had its say. A redirect or a rewrite
 * `next.config` puts before the filesystem claims the path first, and is the Worker's to answer.
 * Then the application's middleware, when its matchers cover the path: Next.js runs it for a
 * public file or an image as for a page, and what it decides there — a redirect away from a
 * protected download, a cookie, a header — has to hold whether the edge or the Worker answers.
 * Most matchers leave these paths out, and those cost nothing here. Validation proves what is
 * stored, not what the middleware would make of the request, and skips it.
 *
 * What the application's Worker cannot answer in the edge's place, it is not handed to answer:
 * a middleware that failed is asked of it again, alone (`decideMiddleware`), and its decision is
 * acted on here.
 */
export async function serveAfterMiddleware(
  input: HostedGateInput,
  gate: HostedGate,
): Promise<Response> {
  const { request, url, edge, manifest } = input;
  if (isReserved(manifest, url, request.headers, true)) {
    return input.passthrough('reserved');
  }
  // Ahead of the middleware, and of whatever serving the file costs — a read of storage, a source
  // fetched and transformed — with the middleware or without it.
  judgeHeaderRulesAhead(manifest, url, request.headers);
  if (edge.validated || !middlewareMatches(edge, manifest, url, request.headers)) {
    return gate.serve(undefined, 0);
  }
  gate.start?.();
  const { outcome: middleware, dispatches } = await decideMiddleware(edge, request);
  try {
    return await actOnMiddleware(input, gate, { middleware, dispatches });
  } catch (error) {
    if (!(error instanceof PatternBudgetExceededError)) {
      throw error;
    }
    // A pattern of the application's the edge does not run against the request as the middleware
    // left it (`budgetPatterns`): handed on with what the middleware decided, which the Function
    // does not run again — or refused, where the Function cannot answer either.
    gate.abandon?.();
    return gate.overBudget?.() ?? input.passthrough(PATTERN_BUDGET, middleware);
  }
}

/** What the middleware decided for something the edge holds, acted on (`serveAfterMiddleware`). */
async function actOnMiddleware(
  input: HostedGateInput,
  gate: HostedGate,
  decided: {
    readonly middleware: MiddlewareOutcome & Partial<MiddlewareTiming>;
    readonly dispatches: number;
  },
): Promise<Response> {
  const { edge, request } = input;
  const { middleware, dispatches } = decided;
  switch (middleware.kind) {
    case 'responded': {
      gate.abandon?.();
      return middlewareResponse(edge, middleware.response);
    }
    case 'failed': {
      gate.abandon?.();
      return input.passthrough(middlewareFailedReason(middleware.cause), middleware);
    }
    case 'external-rewrite': {
      gate.abandon?.();
      return followExternalRewrite(edge, request, middleware);
    }
    case 'skipped': {
      return gate.serve(undefined, dispatches);
    }
    case 'continue': {
      if (!middleware.rewritten) {
        return gate.serve(middleware, dispatches);
      }
      const answered = gate.rewritten?.(middleware, dispatches);
      if (answered !== undefined) {
        return answered;
      }
      gate.abandon?.();
      return input.passthrough('rewritten', middleware);
    }
  }
}
