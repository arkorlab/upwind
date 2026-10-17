import { EDGE_BYPASS_COOKIE, NEXT_DATA_HEADER } from '../request/constants.ts';
import { handedOnAsSent } from '../request/headers.ts';
import type { RouteHas } from './carried.ts';

/**
 * What of a request the rules a gate is found by ask for, held to what the edge and the
 * deployment's router both read the same: the edge judges a rule on the request as it came, and the
 * router on the request as the edge hands it on.
 */

/** A rule of the build's routing, as far as what of a request it asks for. */
interface Conditioned {
  readonly source?: string | undefined;
  readonly sourceRegex: string;
  readonly destination?: string | undefined;
  readonly status?: number | undefined;
  readonly has?: readonly RouteHas[] | undefined;
  readonly missing?: readonly RouteHas[] | undefined;
}

/** A build's routing, as far as the rules a request's gate is found past or by. */
interface ConditionedRouting {
  readonly routing: {
    readonly beforeMiddleware: readonly Conditioned[];
    readonly beforeFiles: readonly Conditioned[];
    readonly afterFiles: readonly Conditioned[];
    readonly dynamicRoutes: readonly Conditioned[];
  };
}

/**
 * What `condition` asks for that the router is not handed as the visitor sent it: a header the edge
 * takes off what it hands on, or writes there itself (`handedOnAsSent`), or the cookie it takes off
 * (`EDGE_BYPASS_COOKIE`). `x-nextjs-data` is none: the edge judges it as the router does
 * (`routerDataHeaders`). `undefined` for a condition both read alike.
 */
function readApart(condition: RouteHas): string | undefined {
  const { type, key } = condition;
  if (key === undefined) {
    return undefined;
  }
  if (type === 'header') {
    const name = key.toLowerCase();
    return name === NEXT_DATA_HEADER || handedOnAsSent(name) ? undefined : `the ${name} header`;
  }
  return type === 'cookie' && key === EDGE_BYPASS_COOKIE ? `the ${key} cookie` : undefined;
}

/**
 * Each rule a request's gate is found past or by (`gateFor`) — one that claims a request ahead of
 * the filesystem or after it, or a dynamic route — that asks for what the deployment's router is
 * not handed as the visitor sent it (`readApart`). The edge would judge such a rule on what the
 * visitor sent, and the router on what it is handed: a gated page the edge took for one a rule
 * claims, asking no gate of it, the router could serve as itself, and a page the router has a rule
 * claim, the edge serve from what it keeps. A build that declares a gate judges no rule so; one that
 * does is refused (`gateIssues`, in `schema.ts`).
 */
export function judgedApart(build: ConditionedRouting): string[] {
  const { routing } = build;
  const rules = [
    ...routing.beforeMiddleware.filter(
      (rule) => rule.status !== undefined || rule.destination !== undefined,
    ),
    ...routing.beforeFiles,
    ...routing.afterFiles,
    ...routing.dynamicRoutes,
  ];
  return rules.flatMap((rule) => {
    const apart = [...(rule.has ?? []), ...(rule.missing ?? [])].flatMap((condition) => {
      const read = readApart(condition);
      return read === undefined ? [] : [read];
    });
    return apart.length === 0
      ? []
      : [
          `a build that declares a gate may judge no route on what its router is not handed as the visitor sent it: the rule of ${rule.source ?? rule.sourceRegex} asks for ${[...new Set(apart)].join(' and ')}`,
        ];
  });
}
