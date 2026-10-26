import type { Prerender } from '@stayingupwind/core/bundle';
import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';

import type { CurrentGeneration } from './cache/current.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import type { Representation } from './representations.ts';
import type { RoutedInput } from './serve.ts';
import type { Store } from './store.ts';

/**
 * Where a host that serves the build itself decides what of the runtime's answers goes out as
 * everyone's: a prerendered page, its data, a route handler's body, a page's loading fallback.
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

/** A render the runtime is publishing as an entry's first generation, and how it reached it. */
export interface FirstPublish {
  readonly runtime: CacheRuntime;
  readonly descriptor: RouteEntryDescriptor;
  /** Its publish: settled once the generation is committed, or is not to be. Never rejects. */
  readonly published: Promise<unknown>;
}

/** The answer the runtime makes from a render it is publishing as the entry's first generation. */
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

/** The answer to the client's request, once everything of it is said. */
export function delivered(_request: Request, answer: Response): Response {
  return answer;
}
