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
 * into that bundle alone, rather than imported from it, so that a module may still assign either, as
 * a polyfill may: an import would fail the build. Each property is the global as it stands when the
 * name is read, wrapped, and assigning it assigns the global — the name means what the global does,
 * as it would unbundled, and only the option differs. So a module that keeps the `fetch` it found and
 * installs one of its own that calls it calls the one it kept, not its own again (greptile). Each
 * wrapper is a proxy of the global it was made for, kept while that global stays: its prototype, its
 * instances, `instanceof`, and whatever a patch hung on the function (Next.js's marks its fetch) are
 * the global's.
 */
const EDGE_WEB_BINDING = '__upwindEdgeWeb';

/**
 * The object's name in the Edge bundle, for its entry module to read off it whether a body is one
 * Node.js's Fetch decoded (`decodedBody`, `edge-answer.ts`).
 */
export const NATIVE_EDGE_WEB_BINDING = EDGE_WEB_BINDING;

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

/**
 * The members of the Fetch standard's `RequestInit` Node.js reads, with its own `dispatcher` and
 * Next.js's `next`.
 */
const FETCH_MEMBERS = [
  'method',
  'headers',
  'body',
  'referrer',
  'referrerPolicy',
  'mode',
  'credentials',
  'cache',
  'redirect',
  'integrity',
  'keepalive',
  'signal',
  'window',
  'priority',
  'dispatcher',
  'next',
];

const EDGE_WEB_SOURCE = [
  // As the Edge Runtime's primitives do: the option only where a body is given and nothing was said
  // of it. Node.js knows no other value, so nothing it took before is taken otherwise. What else the
  // dictionary says is read as Fetch reads it, by property, so none of it is lost to a copy (Codex):
  // what a loop over its keys finds, its prototype's included, and each member Fetch reads, which a
  // class's getter or a non-enumerable property may hold. A plain object, with the option its own: a
  // patched fetch that copies the dictionary again (Next.js's) keeps it.
  `const FETCH_MEMBERS = ${JSON.stringify(FETCH_MEMBERS)};`,
  'const halfDuplex = (init) => {',
  '  if (init == null || init.body == null || init.duplex !== undefined) return init;',
  '  const given = {};',
  '  for (const key in init) given[key] = init[key];',
  '  for (const key of FETCH_MEMBERS) if (!(key in given) && init[key] !== undefined) given[key] = init[key];',
  '  given.duplex = "half";',
  '  return given;',
  '};',
  'const withOption = (args) => (args.length < 2 ? args : [args[0], halfDuplex(args[1]), ...args.slice(2)]);',
  // A wrapper for each global the name has stood for, the last one kept: the same function for as
  // long as the global stays, as the bare name would be.
  'const keptFor = (wrap) => {',
  '  let wrapped, wrapper;',
  '  return (current) => {',
  '    if (typeof current !== "function") return current;',
  '    if (current !== wrapped) {',
  '      wrapped = current;',
  '      wrapper = wrap(current);',
  '    }',
  '    return wrapper;',
  '  };',
  '};',
  'const requestFor = keptFor((current) => new Proxy(current, {',
  '  construct: (target, args, newTarget) => Reflect.construct(target, withOption(args), newTarget),',
  '}));',
  // The bodies Node.js's Fetch handed over decoded, under the `content-encoding` they arrived with:
  // an answer made of one says a coding its bytes no longer have (`edge-answer.ts`). Kept by the
  // stream, which an answer made again of the body — `new Response(answer.body, answer)` — carries
  // on as it is.
  'const decodedBodies = new WeakSet();',
  'const noteDecoded = (response) => {',
  '  const coding = response instanceof Response ? response.headers.get("content-encoding") : null;',
  '  if (coding !== null && coding.trim().toLowerCase() !== "identity" && response.body !== null) decodedBodies.add(response.body);',
  '  return response;',
  '};',
  'const fetchFor = keptFor((current) => new Proxy(current, {',
  // Called as the bare name is, `fetch(…)` reads as a method of this object: not its `this`.
  '  apply: (target, self, args) => {',
  '    const answered = Reflect.apply(target, self === upwindEdgeWeb ? undefined : self, withOption(args));',
  '    return answered instanceof Promise ? answered.then(noteDecoded) : answered;',
  '  },',
  '}));',
  'export const upwindEdgeWeb = {',
  '  get Request() { return requestFor(globalThis.Request); },',
  '  set Request(value) { globalThis.Request = value; },',
  '  get fetch() { return fetchFor(globalThis.fetch); },',
  '  set fetch(value) { globalThis.fetch = value; },',
  '  decodedBody: (body) => body != null && decodedBodies.has(body),',
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
