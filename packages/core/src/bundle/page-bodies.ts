import type { Entrypoint, Prerender } from './schema.ts';
import { standsForClass } from './spelling.ts';

const HTTP_OK = 200;
const ERROR_PAGES: ReadonlySet<string> = new Set(['/_error', '/_global-error', '/_not-found']);

/**
 * A completed Node App page's document or whole Flight payload. These are the only page bodies
 * a Function may leave to a host blob reader: every other representation still needs its bytes
 * locally, including the state and initial shell of a render that has something left to do.
 * Classification belongs to the group's document; Next.js does not classify its Flight twin.
 */
export function completeAppPageBody(input: {
  readonly prerender: Prerender;
  readonly document: Prerender | undefined;
  readonly entry: Entrypoint | undefined;
  readonly basePath: string;
  readonly rscSuffix: string;
}): boolean {
  const { prerender, document, entry, basePath, rscSuffix } = input;
  if (
    document === undefined ||
    !nodeAppPage(document, entry) ||
    !completeDocument(document) ||
    prerender.postponed !== undefined ||
    (prerender.initialStatus ?? HTTP_OK) !== HTTP_OK ||
    document.route !== prerender.route ||
    document.groupId !== prerender.groupId ||
    document.parentOutputId !== prerender.parentOutputId ||
    prerender.segmentPath !== undefined ||
    !(document.route === basePath || document.route.startsWith(`${basePath}/`)) ||
    ERROR_PAGES.has(document.route.slice(basePath.length))
  ) {
    return false;
  }
  // Keep aliases the current runtime cannot select embedded (rscBase maps only the bare root).
  const rscBase = document.pathname === '/' ? '/index' : document.pathname;
  return (
    prerender.id === document.id ||
    (rscSuffix === '.rsc' && prerender.pathname === `${rscBase}${rscSuffix}`)
  );
}

function nodeAppPage(document: Prerender, entry: Entrypoint | undefined): boolean {
  return (
    entry?.kind === 'app-page' && entry.runtime !== 'edge' && entry.pathname === document.route
  );
}

function completeDocument(document: Prerender): boolean {
  return (
    document.routeType === 'page' &&
    document.response === 'complete' &&
    document.compute === 'static' &&
    document.partialFallback !== true &&
    document.postponed === undefined &&
    (document.initialStatus ?? HTTP_OK) === HTTP_OK &&
    !standsForClass(document)
  );
}
