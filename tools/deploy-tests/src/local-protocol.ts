/**
 * What a server the deploy hook starts on this machine says once it serves, which is where the hook
 * reads the site's address from (`local-server.ts`).
 */

/** Said by `serve-cloudflare.ts`, before the address. */
export const CLOUDFLARE_SERVING = 'adapter-test: serving ';

/** Said by the native server `upwind start` runs, before the address. */
export const NODE_LISTENING = 'upwind: native server listening on ';
