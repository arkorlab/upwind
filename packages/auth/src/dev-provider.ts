/**
 * What the stand-in is called for a project that declared no providers at all.
 *
 * Better Auth's `provider` is any string, not only one of the providers it ships, so a project that
 * has not decided between GitHub and Google yet can still sign somebody in.
 *
 * A module of its own, holding one string and importing nothing, because of who reads it. The
 * application that calls `signIn.social({ provider: DEV_PROVIDER_ID })` is a browser bundle, and
 * the only other thing that knows this name is `fake-oauth.ts` — which is the HTML page, the code
 * signing and `better-auth/api`'s endpoint builder, none of which has any business being reachable
 * from a client component. Re-exporting it from there would make the client's import of this
 * constant an import of all of that, resolved by whatever tree-shaking the project's bundler
 * happens to do. One string in one file needs no tree-shaking to be one string.
 */
export const DEV_PROVIDER_ID = 'upwind';
