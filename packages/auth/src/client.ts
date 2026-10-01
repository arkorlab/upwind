import { UPWIND_AUTH_BASE_PATH } from '@stayingupwind/core/paas';
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

export { UPWIND_AUTH_BASE_PATH } from '@stayingupwind/core/paas';
export { DEV_PROVIDER_ID } from './dev-provider.ts';

type ClientOptions = NonNullable<Parameters<typeof createBetterAuthClient>[0]>;

export function createAuthClient<O extends ClientOptions>(
  options?: O,
): ReturnType<typeof createBetterAuthClient<O>> {
  // The base path first, so a project that names one of its own still wins — which is the same
  // precedence `defineAuth` gives the server's `basePath`, and has to be, since the two are one
  // decision made in two places.
  return createBetterAuthClient<O>({ basePath: UPWIND_AUTH_BASE_PATH, ...options } as O);
}
