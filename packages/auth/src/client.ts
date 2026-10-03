import { UPWIND_AUTH_BASE_PATH as BASE_PATH } from '@stayingupwind/core/paas';
import { createAuthClient as createBetterAuthClient } from 'better-auth/react';

/**
 * The browser half, pointed at where the server half is.
 *
 * Better Auth's client defaults to `/api/auth`, which is the right default for Better Auth and the
 * wrong one here — the server is at `/__upwind/auth`, and a client left on the default would ask a
 * path nothing serves and report it as a network error. The two defaults have to move together, so
 * they move from the same constant.
 *
 * That is the whole of what this is. Everything else is `createAuthClient` exactly as Better Auth
 * documents it, including the plugin inference that makes `authClient.signIn` know what the server
 * can do — which is why the options are passed through rather than reshaped, and why a project that
 * would rather import from `better-auth/react` directly loses nothing but the base path:
 *
 * ```ts
 * import { createAuthClient } from 'better-auth/react';
 * import { UPWIND_AUTH_BASE_PATH } from '@stayingupwind/auth/client';
 *
 * export const authClient = createAuthClient({ basePath: UPWIND_AUTH_BASE_PATH });
 * ```
 *
 * React, because the server half is a Next.js route and nothing reaches it that is not already a
 * React application. A project on another framework's client builds it the way above, against the
 * same constant.
 */

export { DEV_PROVIDER_ID } from './dev-provider.ts';

/**
 * Re-declared here rather than re-exported from `@stayingupwind/core`.
 *
 * Core is published as the TypeScript it is and is bundled into this package rather than installed
 * beside it, so it is a devDependency and no project that installs this has it. A declaration that
 * said `export … from '@stayingupwind/core/paas'` — or that typed this as `typeof BASE_PATH`, which
 * keeps the import for the type alone — would be a public type nobody could resolve.
 *
 * So the path is written out, and then checked: the annotation is the literal and the value is
 * core's, so a release that moves the base path and not this line does not compile. The duplication
 * is the assertion.
 */
export const UPWIND_AUTH_BASE_PATH: '/__upwind/auth' = BASE_PATH;

type ClientOptions = NonNullable<Parameters<typeof createBetterAuthClient>[0]>;

export function createAuthClient<O extends ClientOptions>(
  options?: O,
): ReturnType<typeof createBetterAuthClient<O>> {
  // Applied after the spread and only to an absent value, so that a project naming its own base
  // path wins and one that passed `basePath: undefined` — meaning "I have not chosen" exactly as
  // `defineAuth` reads it on the server — is not left pointing at Better Auth's `/api/auth`.
  const asked: ClientOptions = { ...options };
  const basePath = asked.basePath ?? BASE_PATH;
  return createBetterAuthClient<O>({ ...asked, basePath } as O);
}
