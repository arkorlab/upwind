import type { ReservedRoute } from '../manifest/schema.ts';
import type { DeploymentBundle } from './schema.ts';

/**
 * The names Next.js keeps for itself, wherever a base path puts them. `next build` writes the base
 * path into every pathname of a build, its own included (`normalizePathnames`), so a name the edge
 * recognizes at the root has to be recognized under the prefix as well.
 */

/** Documents Next.js renders for an error, never for a request at their own pathname. */
const INTERNAL_PAGES: ReadonlySet<string> = new Set(['/_error', '/_global-error', '/_not-found']);

/** Whether a pathname of the build names one of Next.js's error documents, under its base path. */
export function isInternalPage(bundle: DeploymentBundle, pathname: string): boolean {
  const { basePath } = bundle.config;
  return pathname.startsWith(basePath) && INTERNAL_PAGES.has(pathname.slice(basePath.length));
}

/** A base path as a pattern matches it: every character as itself. */
function escaped(basePath: string): string {
  return basePath.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/**
 * Next.js's own namespace under the base path, `<basePath>/_next/`, as the dynamic routes are to be
 * kept out of it: at the root the edge leaves `/_next/` to the Function before it looks for a route
 * (`classifyRequest`), and under a prefix nothing did — a document asked for at a file the build did
 * not ship there matched a catch-all class and was answered with its page. Reserved from the
 * dynamic routes alone: a file the build did ship there is still served, ahead of every rule.
 */
export function nextNamespaceRoutes(bundle: DeploymentBundle): ReservedRoute[] {
  const { basePath } = bundle.config;
  return basePath === '' ? [] : [{ sourceRegex: `^${escaped(basePath)}/_next/` }];
}
