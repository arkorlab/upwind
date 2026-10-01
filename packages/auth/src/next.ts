import { UPWIND_AUTH_BASE_PATH } from '@stayingupwind/core/paas';
import type { AuthContext, BetterAuthOptions } from 'better-auth';

import { ensureSchema, type Migratable } from './schema.ts';
import { missingProductionSecret } from './secret.ts';

/**
 * The route upwind writes, and the only thing in it.
 *
 * `upwind dev` and `upwind build` put a four-line route handler under `app` that imports the
 * project's auth config and hands the whole module to this. Everything that could be decided from
 * the config is decided here, at request time, rather than by whatever wrote the file — which is
 * what lets the generated route be identical in every project and never need rewriting when the
 * config changes.
 *
 * Three decisions, in order:
 *
 * 1. **Whose config is it.** A module exporting `auth`, or exporting one by default. Both, because
 *    both are things people write, and a package that only accepted one would be a package whose
 *    first instruction is to rename something.
 * 2. **Is this route still the right place.** A config that set a `basePath` of its own is mounted
 *    wherever it says by whoever wrote that, and this route answers nothing — it exists because
 *    `/__upwind/auth` was the default, and it steps aside the moment it is not. Not an error:
 *    a `404` from a path that is genuinely not serving anything.
 * 3. **Can it answer at all.** A production run with no signing key is told so, once, in a message
 *    naming the variable to set — rather than serving sessions signed with a key that was never
 *    meant to leave one machine.
 *
 * Nothing above runs at module evaluation. This route is one entry among a deployment's, loaded on
 * the first request that reaches it (`@stayingupwind/runtime`), and everything it pulls in — Better
 * Auth, the project's config, whatever that config imports — is evaluated then and not before. A
 * request that never touches authentication never pays for any of it.
 */

/** As much of a Better Auth instance as serving one requires. */
interface MountableAuth extends Migratable {
  readonly handler: (request: Request) => Promise<Response>;
  readonly options: BetterAuthOptions;
  readonly $context: Promise<AuthContext>;
}

/** What Next.js calls for each method it was handed. */
type RouteHandler = (request: Request) => Promise<Response>;

/** A configuration this cannot serve is this application's fault, not the caller's. */
const STATUS_MISCONFIGURED = 500;

function isMountable(value: unknown): value is MountableAuth {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { handler?: unknown }).handler === 'function'
  );
}

/** A refusal with a reason a developer can act on, and headers that keep it out of every cache. */
function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Nothing is served here, in the shape a path serving nothing has. */
function notFound(): Response {
  return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
}

/**
 * The auth object a config module exports, or nothing.
 *
 * `auth` first, because it is what Better Auth's own documentation names and what every example
 * writes; `default` after it, for a module whose subject is the one thing it exports.
 */
function authOf(config: Record<string, unknown>): MountableAuth | undefined {
  for (const value of [config['auth'], config['default']]) {
    if (isMountable(value)) {
      return value;
    }
  }
  return undefined;
}

async function answer(config: Record<string, unknown>, request: Request): Promise<Response> {
  const mounted = authOf(config);
  if (mounted === undefined) {
    return refuse(
      STATUS_MISCONFIGURED,
      `@stayingupwind/auth: the auth config beside this app exports no Better Auth instance. Export it as \`auth\`, or as the module's default:\n\n  export const auth = defineAuth();\n`,
    );
  }
  if ((mounted.options.basePath ?? UPWIND_AUTH_BASE_PATH) !== UPWIND_AUTH_BASE_PATH) {
    return notFound();
  }
  const missing = missingProductionSecret(mounted.options.secret);
  if (missing !== undefined) {
    return refuse(STATUS_MISCONFIGURED, missing);
  }
  await ensureSchema(mounted);
  return mounted.handler(request);
}

/**
 * The `GET` and `POST` a Next.js route handler exports, for the module a config file is.
 *
 * Two methods and no others, which is what Better Auth's own Next.js integration mounts: everything
 * it serves is one or the other, and a `PUT` arriving here is answered by Next.js with the `405` it
 * would give any route that does not export one.
 */
export function toNextHandler(config: Record<string, unknown>): {
  readonly GET: RouteHandler;
  readonly POST: RouteHandler;
} {
  const handler: RouteHandler = async (request) => answer(config, request);
  return { GET: handler, POST: handler };
}
