import type { Plugin } from 'rolldown';

/**
 * Globals Rolldown takes for pure although they throw on an ordinary argument: a malformed escape or
 * a lone surrogate for the URI functions, a code point out of range for `String.fromCodePoint`. It
 * drops a call to one whose result nothing reads, in a `try` block too, so a check that works by the
 * throw passes everything: `try { decodeURIComponent(path); return true } catch { return false }`
 * becomes `return true`. Every bundle the adapter makes, the application's code as the runtime's,
 * defines each of them as a property of the global object instead, read when the call is made: a
 * property read, which Rolldown keeps, and the call with it.
 *
 * The global object is a binding of the bundle's own, injected from a module the adapter provides
 * (`GLOBAL_OBJECT`), not `globalThis` as the module in hand reads it: a module that binds a
 * `globalThis` of its own is left as it reads. Read at the call, a global a module replaces is the
 * one called, and the function is the global's own (`decodeURIComponent === globalThis.decodeURIComponent`).
 * The URI functions are called unbound (`(0, g.decodeURI)(…)`), as their bare names are, so a
 * replacement is not handed the global object as `this`; `String.fromCodePoint` was a method call
 * already. Rolldown defines before it injects, so the name the definitions spell is the one
 * injected; a module would have to bind that name itself to read anything else.
 *
 * The globals that only coerce their arguments (`parseInt`, `Math.*`, `String.fromCharCode`) stay
 * as they are: they throw on a Symbol or a BigInt alone, which the minifier assumes they are not
 * handed.
 */
const GLOBAL_BINDING = '__upwindGlobalObject';

const GLOBAL_MODULE = '\0upwind:global-object';

/** For `transform.define`: each throwing global, as a property of the global object. */
export const THROWING_GLOBALS: Readonly<Record<string, string>> = {
  decodeURI: `(0, ${GLOBAL_BINDING}.decodeURI)`,
  decodeURIComponent: `(0, ${GLOBAL_BINDING}.decodeURIComponent)`,
  encodeURI: `(0, ${GLOBAL_BINDING}.encodeURI)`,
  encodeURIComponent: `(0, ${GLOBAL_BINDING}.encodeURIComponent)`,
  'String.fromCodePoint': `${GLOBAL_BINDING}.String.fromCodePoint`,
};

/** For `transform.inject`: the global object those definitions read the globals off. */
export const GLOBAL_OBJECT: Readonly<Record<string, [string, string]>> = {
  [GLOBAL_BINDING]: [GLOBAL_MODULE, 'g'],
};

/**
 * The module the global object is injected from; first among a bundle's plugins. Its binding is a
 * letter: every call site spells it, and the adapter's bundles keep their names.
 */
export function globalObjectPlugin(): Plugin {
  return {
    name: 'upwind-global-object',
    resolveId: (source) => (source === GLOBAL_MODULE ? source : null),
    load: (id) => (id === GLOBAL_MODULE ? 'export const g = globalThis;' : null),
  };
}
