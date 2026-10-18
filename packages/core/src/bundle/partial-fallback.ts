import { keyedParameters } from '../manifest/completion.ts';
import type { PartialFallbackUpgrade } from '../manifest/schema.ts';
import { queryDependent } from './query.ts';
import type { DeploymentBundle, Prerender } from './schema.ts';

const SINGLE_PARAMETER = /^\[([^.[\]]+)\]$/u;
const HTTP_OK = 200;

/** Every varying key is a route parameter, and the shell's template names that route. */
function parameterKeyed(prerender: Prerender): boolean {
  const allowed = prerender.allowQuery;
  if (allowed === undefined || allowed.length === 0) return false;
  const route = prerender.route.split('/');
  const template = prerender.pathname.split('/');
  if (route.length !== template.length) return false;
  const keys = new Set<string>();
  for (const [index, segment] of route.entries()) {
    const parameter = SINGLE_PARAMETER.exec(segment)?.[1];
    const value = template[index] ?? '';
    if (parameter === undefined) {
      if (segment !== value || segment.includes('[') || segment.includes(']')) return false;
    } else {
      keys.add(`nxtP${parameter}`);
      if (value !== segment && (value === '' || value.includes('[') || value.includes(']'))) {
        return false;
      }
    }
  }
  return (
    allowed.every((key) => keys.has(key)) &&
    queryDependent(prerender, prerender.route, prerender.pathname)
  );
}

/**
 * The entry a built partial fallback can be completed into behind its response. The build must
 * explicitly request that upgrade; an ordinary PPR shell, a shell whose remaining parameters no
 * build can supply, and a response varying on arbitrary query keys keep their existing behavior.
 *
 * The key is shared by the Function publishing the shell and a host looking it up: every route
 * parameter, or only the parameters Next.js names in `allowQuery`, with the rest left placeholders.
 */
export function partialFallbackUpgradeOf(
  bundle: Pick<DeploymentBundle, 'config' | 'entrypoints'>,
  prerender: Prerender,
): PartialFallbackUpgrade | undefined {
  if (
    bundle.config.cacheComponents !== true ||
    bundle.config.partialPrefetching !== true ||
    prerender.partialFallback !== true ||
    prerender.body === undefined ||
    prerender.postponed === undefined ||
    prerender.renderingMode !== 'PARTIALLY_STATIC' ||
    prerender.routeType === 'route' ||
    (prerender.response !== undefined && prerender.response !== 'initial') ||
    (prerender.compute !== undefined && prerender.compute !== 'resuming') ||
    (prerender.initialStatus !== undefined && prerender.initialStatus !== HTTP_OK) ||
    !parameterKeyed(prerender)
  ) {
    return undefined;
  }
  const entry = bundle.entrypoints.find((candidate) => candidate.pathname === prerender.route);
  if (entry?.kind !== 'app-page' || entry.runtime === 'edge') return undefined;
  const keyedBy = keyedParameters(prerender.route, prerender.pathname, prerender.allowQuery);
  return { route: prerender.route, ...(keyedBy !== undefined && { keyedBy }) };
}
