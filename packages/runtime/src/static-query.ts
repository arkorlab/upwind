import { resolveRoutes } from '@next/routing';
import { builtNameOf } from '@stayingupwind/core/manifest';

import { escapedNameOf } from './name-spellings.ts';
import { renderQuery } from './render-query.ts';
import type { Store } from './store.ts';

export type StaticQuery = (request: Request) => Promise<Record<string, string | string[]>>;
const HTTP_REDIRECT = 300;
const HTTP_CLIENT_ERROR = 400;

function memberOf(pathname: string): string | undefined {
  const bare = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return builtNameOf(bare);
}

/** Header-only rules and redirects cannot add a render's query. */
function isRewrite(route: {
  readonly destination?: string | undefined;
  readonly status?: number | undefined;
}): boolean {
  return (
    route.destination !== undefined &&
    (route.status === undefined ||
      route.status < HTTP_REDIRECT ||
      route.status >= HTTP_CLIENT_ERROR)
  );
}

/** A static render resolves only in memory: no middleware, fetch, or response-header rules. */
async function queryOf(
  store: Store,
  request: Request,
  route: string,
): Promise<Record<string, string | string[]>> {
  // Keep parameter-only callers from importing the routing/HTTP bridge graph. Production
  // bundles inline this import; only this special path evaluates it.
  const { pathnamesFor, routingI18n, routingTables } = await import('./routing.ts');
  const url = new URL(request.url);
  const routes = routingTables(store, true, url, true);
  const { i18n, basePath } = store.manifest.config;
  const resolved = await resolveRoutes({
    url,
    buildId: store.manifest.buildId,
    basePath,
    ...(i18n !== undefined && i18n !== null && { i18n: routingI18n(i18n) }),
    headers: new Headers(request.headers),
    requestBody: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    pathnames: pathnamesFor(store, url),
    routes: {
      ...routes,
      middlewareMatchers: [],
      beforeMiddleware: routes.beforeMiddleware.filter((rule) => isRewrite(rule)),
      beforeFiles: routes.beforeFiles.filter((rule) => isRewrite(rule)),
      afterFiles: routes.afterFiles.filter((rule) => isRewrite(rule)),
      fallback: routes.fallback.filter((rule) => isRewrite(rule)),
      onMatch: [],
    },
    invokeMiddleware: () => Promise.resolve({}),
  });
  const resolvedPath = resolved.resolvedPathname;
  const named =
    resolvedPath === undefined ? undefined : (escapedNameOf(store, resolvedPath) ?? resolvedPath);
  const page = named === undefined ? undefined : (store.slashSpellings.get(named) ?? named);
  const template =
    page === undefined ? undefined : (store.prerendersByPathname.get(page)?.route ?? page);
  const target = resolved.invocationTarget;
  if (
    template !== route ||
    target === undefined ||
    memberOf(target.pathname) !== memberOf(url.pathname)
  ) {
    throw new Error('A static render query must resolve to its own local entry and member');
  }
  return target.query;
}

/** Only percent-sensitive App renders with configured rewrites need this extra routing work. */
export function prepareStaticQuery(store: Store, route: string): StaticQuery | undefined {
  const routing = store.manifest.routing;
  const configured = [
    routing.beforeMiddleware,
    routing.beforeFiles,
    routing.afterFiles,
    routing.fallback,
  ];
  if (configured.every((routes) => routes.every((rule) => !isRewrite(rule)))) return undefined;
  return async (request) => renderQuery(await queryOf(store, request, route));
}
