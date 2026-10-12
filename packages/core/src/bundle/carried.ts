import * as z from '../schema/index.ts';

/**
 * What a deployment's manifest carries on from its bundle, for a host's edge to read with it: a
 * route's conditions, how the deployment's Functions fill a header's references, and which app
 * Function a route's code is in.
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
