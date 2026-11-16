import type { Plugin } from 'rolldown';

/** The id `server-only` is bundled under: no file is read for it. */
const SERVER_ONLY_MODULE = '\0upwind:server-only';

/**
 * The marker module `server-only` is an empty module in a class module's bundle, as it is in
 * Next.js's server bundles. A class runs in the object alone, never in a Client Component, so what
 * the package guards against cannot happen: the bare specifier is answered here, whichever module
 * imports it and whether or not the package is installed, where the package's own entry throws on
 * load and a missing one would fail the build. Nothing else is: `client-only` and the subpaths of
 * the package keep resolving as any import does.
 */
export function serverOnlyPlugin(): Plugin {
  return {
    name: 'upwind-server-only',
    resolveId: {
      filter: { id: /^server-only$/u },
      handler: () => SERVER_ONLY_MODULE,
    },
    load: {
      filter: { id: /^\0upwind:server-only$/u },
      handler: () => ({ code: '', moduleType: 'js' }),
    },
  };
}
