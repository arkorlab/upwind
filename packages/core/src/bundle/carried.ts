import * as z from '../schema/index.ts';

/**
 * What a deployment's manifest carries on from its bundle, for a host's edge to read with it: a
 * route's conditions, how the deployment's Functions fill a header's references, which app
 * Function a route's code is in, and which gate a route is asked of first.
 *
 * Apart from the bundle's own schema (`schema.ts`) so that a reader of a manifest builds these and
 * nothing else. A schema is built when its module is evaluated, whether anything reads it or not,
 * and a bundler keeps a module's top-level calls for what they might do: a reader that took these
 * from `schema.ts` built every schema an upload is checked with as well — the bundle, its routes,
 * prerenders and Functions, its crons, and the pattern checks behind them — and carried them all.
 */

/**
 * The name of an app Function after the first: `app-2`, `app-3` and on, which is how the adapter
 * names them. The first is `app`, and is `functions.app` itself rather than a key of `split`.
 */
export const splitFunctionNameSchema = z
  .string()
  .regex(/^app-(?:[2-9]|[1-9]\d+)$/u, 'expected app-2, app-3, …');

export const routeHasSchema = z.object({
  type: z.enum(['header', 'cookie', 'query', 'host']),
  key: z.string().optional(),
  value: z.string().optional(),
});
export type RouteHas = z.infer<typeof routeHasSchema>;

/**
 * How a deployment's Functions fill the `$` references in a header's key and value. `one-pass` is
 * `@next/routing` from 16.4: one pass over the value, each reference read as the longest name it
 * spells — `$10` is the tenth capture or nothing, never the first and a `0` — and what that names
 * put in as it is. The router before it replaced each name over the whole value in turn, as a
 * replacement string, which is how a deployment whose bundle does not say has its headers filled.
 */
export const routerReferencesSchema = z.literal('one-pass');
export type RouterReferences = z.infer<typeof routerReferencesSchema>;

/**
 * The name a build gives a gate, and a host binds one under: a lowercase letter, then lowercase
 * letters, digits and hyphens. Upper-cased, each hyphen an underscore, it is a name an environment
 * binds a service under, and no two names come to the same one there.
 */
export const gateNameSchema = z
  .string()
  .regex(/^[a-z][\da-z-]*$/u, 'expected a gate name: a lowercase letter, then a-z, 0-9 or -');

/**
 * The routes a build declares a gate for, each with the name of its gate: a route as Next.js names
 * it — an entrypoint's pathname, its dynamic segments as written (`/posts/[slug]`) — under the
 * `basePath`, as every pathname of a build is. In printable ASCII, as a header carries it: the gate
 * is told the route a request is of in one (`GATE_ROUTE_HEADER`), and a value no header can hold
 * would fail every request of the route where it is asked rather than where it was declared.
 */
export const routeGatesSchema = z.record(
  z.string().regex(/^\/[\u{20}-\u{7E}]*$/u, 'expected a route: /, then printable ASCII'),
  gateNameSchema,
);
export type RouteGates = z.infer<typeof routeGatesSchema>;
