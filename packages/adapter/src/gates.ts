import { declaredRouteGates, ROUTE_GATES_ENV, type RouteGates } from '@stayingupwind/core/bundle';

/**
 * The gates the build's environment declares (`ROUTE_GATES_ENV`), or `undefined` for none. One that
 * cannot be read fails the build, saying what is wrong with it: read as declaring none, it would
 * leave each route it names to be served with no gate asked. Which routes it names, and whether the
 * build has them, the bundle's schema judges once the build's routes are known.
 */
export function declaredGates(): RouteGates | undefined {
  try {
    return declaredRouteGates(process.env[ROUTE_GATES_ENV]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`@stayingupwind/adapter: ${detail}`, { cause: error });
  }
}
