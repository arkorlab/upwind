import { EDGE_BYPASS_COOKIE, NEXT_DATA_HEADER } from '../request/constants.ts';
import { handedOnAsSent } from '../request/headers.ts';
import type { RouteHas } from './carried.ts';
import {
  type BuildRerouting,
  gatedEitherWay,
  isOptimizerPath,
  rewritesOnto,
} from './gate-routes.ts';

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

export interface GatedBundle extends BuildRerouting, ConditionedRouting {
  readonly gates?: Readonly<Record<string, string>> | undefined;
  readonly routing: BuildRerouting['routing'] &
    ConditionedRouting['routing'] & {
      readonly middlewareMatchers: readonly unknown[];
      readonly shouldNormalizeNextData: boolean;
    };
  readonly middleware?: unknown;
  readonly functions: {
    readonly middleware?: unknown;
  };
}

/** Whether the build has a middleware: its matchers, in either place, or a Function of its own. */
function hasMiddleware(bundle: GatedBundle): boolean {
  return (
    bundle.middleware !== undefined ||
    bundle.functions.middleware !== undefined ||
    bundle.routing.middlewareMatchers.length > 0
  );
}

/**
 * What of a bundle's gates no host could ask: a `gates` that declares none; a route the build ships
 * as a file, which is answered from storage before any route is looked for, or the image
 * optimizer's own path, which is answered as the optimizer's before any route is; a route the
 * build does not have, a misspelling among them; any gate of a build with `i18n`, whose dynamic
 * routes the edge leaves to its Function unread, and so could not tell a request of a gated route
 * from another; any gate of a build with a middleware, whose rewrites no build can know, and which
 * runs in the Function for every request the edge hands on rather than serves itself — or whose
 * router reads a data URL as the page it names, which Next.js writes for such a build alone; a
 * route a rewrite of `next.config` may send a request to, or have the image optimizer fetch as its
 * source (`rewritesOnto`), which is served there with no gate asked; a rule a gate is found by that
 * asks for what the deployment's router is not handed as the visitor sent it (`judgedApart`), which
 * the edge would judge otherwise; and a prerendered pathname that may be served as a gated route
 * or as another (`gatedEitherWay`), of which the one gate asked would answer for a route it is not
 * the gate of. Each would be a route served to some visitor with no gate asked, or answered by a
 * gate that is not its own, which declaring a gate says must not happen: the build is refused
 * rather than served so.
 */
export function gateIssues(bundle: GatedBundle): string[] {
  const { gates } = bundle;
  if (gates === undefined) {
    return [];
  }
  const routes = Object.keys(gates);
  if (routes.length === 0) {
    return ['gates declares no gate; a bundle that declares none leaves it out'];
  }
  const issues: string[] = [];
  const { i18n } = bundle.config;
  if (i18n !== undefined && i18n !== null) {
    issues.push(
      'a build with i18n may declare no gate: the edge leaves its dynamic routes to its Function',
    );
  }
  if (hasMiddleware(bundle)) {
    issues.push(
      'a build with a middleware may declare no gate: the edge runs the middleware itself only for the requests it serves as documents, and one it hands on runs it in the Function, where a rewrite onto a gated route reaches that route with no gate asked',
    );
  }
  if (bundle.routing.shouldNormalizeNextData) {
    issues.push(
      'a build whose router reads a Pages Router data URL as the page it names (shouldNormalizeNextData) may declare no gate: Next.js has it do so only for a build with a middleware',
    );
  }
  const entrypoints = new Set(bundle.entrypoints.map((entry) => entry.pathname));
  const files = new Set(bundle.staticFiles.map((file) => file.pathname));
  issues.push(...judgedApart(bundle), ...gatedEitherWay(bundle, gates));
  for (const route of routes) {
    if (files.has(route)) {
      issues.push(`gates names ${route}, which the build ships as a file, served before any gate`);
    } else if (isOptimizerPath(bundle, route)) {
      issues.push(
        `gates names ${route}, the image optimizer's path, answered as the optimizer's before any gate`,
      );
    } else if (!entrypoints.has(route)) {
      issues.push(`gates names ${route}, which is no route of this build`);
    }
  }
  return [...issues, ...rewritesOnto(bundle, routes)];
}
