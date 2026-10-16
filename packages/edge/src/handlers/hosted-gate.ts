import {
  type ConfiguredHeaders,
  isReserved,
  type ProjectManifest,
} from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import { PatternBudgetExceededError } from '@stayingupwind/core/request';

import type { EdgeContext, StaticFileContext } from '../strategies/context.ts';
import {
  decideMiddleware,
  followExternalRewrite,
  headerRulesAsRouted,
  type MiddlewareDecision,
  middlewareFailedReason,
  middlewareMatches,
  type MiddlewareOutcome,
  middlewareResponse,
  type MiddlewareTiming,
  routedHeaders,
} from './middleware.ts';
import { PATTERN_BUDGET } from './passthrough.ts';

export type MiddlewareContinue = Extract<MiddlewareResult, { kind: 'continue' }>;

export interface HostedGateInput<Context extends StaticFileContext = EdgeContext> {
  readonly request: Request;
  readonly url: URL;
  readonly edge: Context;
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

/** A shipped file whose policy has not had to be waited on yet. */
export interface DeferredHostedGateInput extends HostedGateInput<StaticFileContext> {
  /** The full policy is needed only when matching middleware is about to run. */
  readonly policyReady: () => EdgeContext | Promise<EdgeContext>;
}

/** What the middleware decided where it let the request on, and how long deciding it took. */
export type TimedContinue = MiddlewareContinue & Partial<MiddlewareTiming>;

export interface HostedGate {
  /** The complete context once a matching middleware required the selected policy. */
  readonly ready?: (edge: EdgeContext) => void;
  /**
   * Answer the request as it stands, with what the middleware set when it ran and how long it took
   * (`middlewareMs`), and the dispatches it took to decide (`decideMiddleware`: none, one, or two
   * after a retry): what the answer's metric reports of the middleware.
   */
  readonly serve: (
    middleware: TimedContinue | undefined,
    dispatches: number,
    configured: ConfiguredHeaders,
  ) => Promise<Response>;
  /**
   * Answer a request the middleware rewrote elsewhere, when the edge can; `undefined` hands it to
   * the Worker. Absent, every rewrite is the Worker's.
   */
  readonly rewritten?: (
    middleware: TimedContinue,
    dispatches: number,
    configured: ConfiguredHeaders,
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
   * middleware left it, than the edge runs (`budgetPatterns`): handed what the middleware decided,
   * and the dispatches it took. Absent, the Worker, handed what the middleware decided; an image
   * refuses instead, since no Worker of the application optimizes one.
   */
  readonly overBudget?: (
    middleware: (MiddlewareOutcome & Partial<MiddlewareTiming>) | undefined,
    dispatches: number,
    configured: ConfiguredHeaders,
  ) => Promise<Response>;
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
  input: HostedGateInput | DeferredHostedGateInput,
  gate: HostedGate,
): Promise<Response> {
  const { request, url, edge, manifest } = input;
  // On the headers the application's routing is handed, as the middleware's matchers are judged.
  const routed = routedHeaders(edge, manifest.reservedRoutes, request.headers);
  if (isReserved(manifest, url, routed, true)) {
    return input.passthrough('reserved');
  }
  // Ahead of the middleware, and of whatever serving the file costs — a read of storage, a source
  // fetched and transformed — with the middleware or without it.
  const configured = headerRulesAsRouted(edge, manifest, url, request.headers);
  let matches: boolean;
  try {
    matches = !edge.validated && middlewareMatches(edge, manifest, url, request.headers);
  } catch (error) {
    if (!(error instanceof PatternBudgetExceededError)) {
      throw error;
    }
    // The rules were already selected, but the matcher spent what remained. An image refusal
    // keeps those headers without asking the same rules to fit the allowance a second time.
    return gate.overBudget?.(undefined, 0, configured) ?? input.passthrough(PATTERN_BUDGET);
  }
  if (!matches) {
    return gate.serve(undefined, 0, configured);
  }
  const ready = 'policyReady' in input ? await input.policyReady() : input.edge;
  const resolved = { ...input, edge: ready };
  gate.ready?.(ready);
  gate.start?.();
  let decided: MiddlewareDecision;
  try {
    decided = await decideMiddleware(ready, request);
  } catch (error) {
    // An answer of the middleware's that cannot be read — a rewrite to no URL at all — answers
    // nothing here: what was started for the answer is let go, as wherever no answer takes it.
    gate.abandon?.();
    throw error;
  }
  const { outcome: middleware, dispatches } = decided;
  try {
    return await actOnMiddleware(resolved, gate, { middleware, dispatches, configured });
  } catch (error) {
    if (!(error instanceof PatternBudgetExceededError)) {
      throw error;
    }
    // A pattern of the application's the edge does not run against the request as the middleware
    // left it (`budgetPatterns`): handed on with what the middleware decided, which the Function
    // does not run again — or refused, where the Function cannot answer either.
    gate.abandon?.();
    return (
      gate.overBudget?.(middleware, dispatches, configured) ??
      input.passthrough(PATTERN_BUDGET, middleware)
    );
  }
}

/** What the middleware decided for something the edge holds, acted on (`serveAfterMiddleware`). */
async function actOnMiddleware(
  input: HostedGateInput,
  gate: HostedGate,
  decided: {
    readonly middleware: MiddlewareOutcome & Partial<MiddlewareTiming>;
    readonly dispatches: number;
    readonly configured: ConfiguredHeaders;
  },
): Promise<Response> {
  const { edge, request } = input;
  const { middleware, dispatches, configured } = decided;
  // What the middleware took, for an answer it gives itself.
  const itself = {
    pathname: input.url.pathname,
    middlewareMs: middleware.middlewareMs,
    dispatches,
  };
  switch (middleware.kind) {
    case 'responded': {
      gate.abandon?.();
      return middlewareResponse(edge, request, middleware.response, itself);
    }
    case 'failed': {
      gate.abandon?.();
      return input.passthrough(middlewareFailedReason(middleware.cause), middleware);
    }
    case 'external-rewrite': {
      gate.abandon?.();
      return followExternalRewrite(edge, request, middleware, { ...itself, configured });
    }
    case 'skipped': {
      return gate.serve(undefined, dispatches, configured);
    }
    case 'continue': {
      if (!middleware.rewritten) {
        return gate.serve(middleware, dispatches, configured);
      }
      const answered = gate.rewritten?.(middleware, dispatches, configured);
      if (answered !== undefined) {
        return answered;
      }
      gate.abandon?.();
      return input.passthrough('rewritten', middleware);
    }
  }
}
