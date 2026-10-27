import { lookAtScopeBehind } from './cache/scope-signal.ts';
import type { ManifestRoutingInput } from './preview/pointer-request.ts';

/**
 * Next.js's own paths, the build's files chief among them: nothing under them is judged by a tag,
 * but for a Pages Router page's data (`/_next/data/`), which the page's Function renders as it
 * renders the page, from what an invalidation reaches.
 */
const NEXT_OWN_PATHS = '/_next/';
const PAGES_DATA_PATHS = '/_next/data/';

/**
 * Begin the scope's look behind a request handed to the Function without reading a generation:
 * a page behind a rewrite, a route handler, or a Pages Router page's data. A document that reads a
 * generation begins its look there, after its policy is ready, so the question does not suppress
 * the build shell's read beside a cold record (`startRecordRead`). Neither waits for the look.
 * Not for another path of Next.js's own, a validation, or a non-read method. No manifest is read
 * for this: a GET or HEAD already has it, and a request of another method is left alone.
 */
export function lookAtScopeOf(input: ManifestRoutingInput): void {
  const { request, state } = input;
  const scopeId = state.manifest?.cache?.scopeId;
  if (
    scopeId === undefined ||
    state.validated ||
    state.function !== undefined ||
    (request.method !== 'GET' && request.method !== 'HEAD')
  ) {
    return;
  }
  const { pathname } = input.url;
  const nextOwn = pathname.startsWith(NEXT_OWN_PATHS) && !pathname.startsWith(PAGES_DATA_PATHS);
  if (nextOwn) {
    return;
  }
  lookAtScopeBehind(
    { app: input.state.app, ctx: input.ctx, host: input.host, runtime: input.runtime },
    scopeId,
  );
}
