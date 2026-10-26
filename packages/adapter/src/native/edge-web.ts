import type { Plugin } from 'rolldown';

/**
 * `Request` and `fetch` as the Edge Runtime has them, for the native target's Edge bundle alone: a
 * body taken as it is handed, without the `duplex: 'half'` Node.js's Fetch asks of a streamed one.
 * The Edge Runtime does not ask it, and Next.js's Edge code does not give it — `NextRequest` adds it
 * only where `process.env.NEXT_RUNTIME` is not `'edge'`, which the Edge bundle defines it as. On
 * Node.js, then, every request with a body that reached Edge code failed as Next.js wrapped it:
 * middleware, an Edge route, a Server Action behind Edge middleware. `next start` runs that code
 * on the Edge Runtime's own primitives, which add the option where it is missing; so does this.
 *
 * Only the Edge bundle's: the Node.js graph shares the realm (`server.ts`), and keeps Node.js's
 * `Request` and `fetch` as they are. The two names are defined as properties of an object injected
 * into that bundle alone, rather than imported from it — so a module that assigns either global, as
 * a polyfill may, assigns the property rather than failing the build on an import. The `Request` is
 * Node.js's own behind a proxy: its prototype, its instances, and `instanceof` with a request made
 * elsewhere, are Node.js's. The `fetch` is the global one, read at each call, so whatever patched
 * it (Next.js's data cache) is what is called.
 */
const EDGE_WEB_BINDING = '__upwindEdgeWeb';

const EDGE_WEB_MODULE = '\0upwind:native-edge-web';

/** For `transform.define`: the Edge Runtime's `Request` and `fetch`, as properties of the object. */
export const NATIVE_EDGE_WEB_GLOBALS: Readonly<Record<string, string>> = {
  Request: `${EDGE_WEB_BINDING}.Request`,
  fetch: `${EDGE_WEB_BINDING}.fetch`,
};

/** For `transform.inject`: the object those definitions read the two off. */
export const NATIVE_EDGE_WEB_OBJECT: Readonly<Record<string, [string, string]>> = {
  [EDGE_WEB_BINDING]: [EDGE_WEB_MODULE, 'upwindEdgeWeb'],
};

const EDGE_WEB_SOURCE = [
  // As the Edge Runtime's primitives do: the option only where a body is given and nothing was said
  // of it. Node.js knows no other value, so nothing it took before is taken otherwise.
  'const halfDuplex = (init) =>',
  '  init != null && init.body != null && init.duplex === undefined ? { ...init, duplex: "half" } : init;',
  'export const upwindEdgeWeb = {',
  '  Request: new Proxy(globalThis.Request, {',
  '    construct: (target, args, newTarget) =>',
  '      Reflect.construct(target, args.length < 2 ? args : [args[0], halfDuplex(args[1]), ...args.slice(2)], newTarget),',
  '  }),',
  '  fetch: (input, init) => globalThis.fetch(input, halfDuplex(init)),',
  '};',
  '',
].join('\n');

/** The module the object is injected from. */
export function nativeEdgeWebPlugin(): Plugin {
  return {
    name: 'upwind-native-edge-web',
    resolveId: (source) => (source === EDGE_WEB_MODULE ? source : null),
    load: (id) => (id === EDGE_WEB_MODULE ? EDGE_WEB_SOURCE : null),
  };
}
