/**
 * Evaluated before any Next.js module: `async-local-storage.js` reads the global once, at module
 * evaluation, and settles for a fake that throws when it is absent.
 */
export const FUNCTION_BANNER =
  "globalThis.AsyncLocalStorage ??= require('node:async_hooks').AsyncLocalStorage;";
