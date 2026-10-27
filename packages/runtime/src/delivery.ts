import type { Prerender } from '@stayingupwind/core/bundle';
import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';

import type { CurrentGeneration } from './cache/current.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import type { Representation } from './representations.ts';
import type { RoutedInput } from './serve.ts';
import type { Store } from './store.ts';

/**
 * Where a host that serves the build itself decides what of the runtime's answers goes out as
 * everyone's: a prerendered page, its data, a route handler's body, a page's loading fallback — and,
 * of everything else the application answered, how much of what it said of its keeping stands (the
 * edge's passthrough: `unsharedUnlessPublic`).
 *
 * On Workers that host is the edge, which decides it before the request reaches a Function
 * (`static-page.ts`, `route-body.ts`, `fallback-page.ts` in the edge), and the Function answers every
 * request as one visitor's: `private, no-store` (`representations.ts`, `documentHeaders`). Were it to
 * answer otherwise, the edge's passthrough would keep what it said for an anonymous visitor, and the
 * Function would be deciding what the edge decides. So here nothing changes: each of these is the
 * answer as it is. A target with no edge in front of it answers by the edge's rules in their place
 * (`native/delivery.ts`, swapped in by the build).
 */

/** The answer the runtime makes from an entry's current generation. */
export function offeredFromGeneration(
  _input: RoutedInput,
  _current: CurrentGeneration,
  _representation: Representation,
  answer: Response,
): Response {
  return answer;
}

/**
 * Whether a stale generation is answered as it stands, as everyone's, rather than from the render
 * this isolate is regenerating it with. The edge decides it before a request reaches a Function:
 * it serves the standing record as everyone's where it may (`serveCurrentPage`), and leaves the
 * rest to the Function, which answers them from the render, as the visitor's. So on Workers, never.
 */
export const standingShared: (
  input: RoutedInput,
  current: CurrentGeneration,
  representation: Representation,
) => boolean = () => false;

/** An entry's first generation in the making, and how the runtime answers from it once made. */
export interface FirstPublish {
  readonly runtime: CacheRuntime;
  readonly descriptor: RouteEntryDescriptor;
  /** Its publish, where this isolate makes it: settled once committed, or not to be. Never rejects. */
  readonly published: Promise<unknown> | undefined;
  /**
   * Whether a render whose publish this isolate does not hold has the entry's lease (`busy`): a
   * generation may come of it all the same. Where neither this nor `published` says so, nobody is
   * making one — the regeneration was refused, failed or skipped — and there is none to wait for.
   */
  readonly elsewhere: boolean;
  /** The answer a generation gives, as from any record read (`answerFromGeneration`). */
  readonly fromRecord: (current: CurrentGeneration) => Promise<Response | undefined>;
}

/** The answer the runtime makes while an entry's first generation is in the making. */
export function offeredOncePublished(
  _input: RoutedInput,
  _first: FirstPublish,
  _representation: Representation,
  answer: Response,
): Response | Promise<Response> {
  return answer;
}

/** The loading fallback the build wrote for a member it did not render. */
export function offeredFromFallback(
  _input: RoutedInput,
  _store: Store,
  _shell: Prerender,
  answer: Response,
): Response {
  return answer;
}

/**
 * An answer of a kind the host decides by a rule of its own — a shipped file, an image — which the
 * rule for whatever else the runtime answers (`delivered`) leaves as it is. On the edge these are
 * answered before a request reaches the Function, by handlers of their own (`static-file.ts`,
 * `image.ts`), and nothing is said of them here.
 */
export function decidedApart(answer: Response): Response {
  return answer;
}

/**
 * The request's headers as a middleware handed them on (`request` being the client's), for the
 * host to judge whether what was asked carried anything of a visitor's in either. On Workers the
 * edge judges it from the middleware it ran itself (`passthrough.ts`, `anonymous`).
 */
export const handedOn: (request: Request, headers: Headers) => void = () => {
  // Nothing to keep: the edge decides.
};

/** The answer to the client's request, once everything of it is said. */
export function delivered(_request: Request, answer: Response): Response {
  return answer;
}
