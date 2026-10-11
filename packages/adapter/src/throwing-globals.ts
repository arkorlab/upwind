import type { Plugin } from 'rolldown';

/**
 * Globals Rolldown takes for pure although they throw on an ordinary argument: a malformed escape or
 * a lone surrogate for the URI functions, a code point out of range for `String.fromCodePoint`. It
 * drops a call to one whose result nothing reads, in a `try` block too, so a check that works by the
 * throw passes everything: `try { decodeURIComponent(path); return true } catch { return false }`
 * becomes `return true`. Every bundle the adapter makes, the application's code as the runtime's,
 * injects these instead: each reference to the global becomes a binding of the bundle's own,
 * read off the global object, which Rolldown does not take for pure and so keeps the call.
 *
 * Injected, not defined as `globalThis.<name>`: the binding is the bundle's, so a module that binds
 * `globalThis` (or the name itself) is left as it reads, where a definition would read the call off
 * that module's own `globalThis`.
 *
 * The globals that only coerce their arguments (`parseInt`, `Math.*`, `String.fromCharCode`) stay
 * as they are: they throw on a Symbol or a BigInt alone, which the minifier assumes they are not
 * handed.
 */
const THROWING_MODULE = '\0upwind:throwing-globals';

const THROWING_SOURCE = `const globalObject = globalThis;
export const decodeURI = globalObject.decodeURI;
export const decodeURIComponent = globalObject.decodeURIComponent;
export const encodeURI = globalObject.encodeURI;
export const encodeURIComponent = globalObject.encodeURIComponent;
export const fromCodePoint = globalObject.String.fromCodePoint;
`;

/** For `transform.inject`: each global, and the binding of the module above it becomes. */
export const THROWING_GLOBALS: Readonly<Record<string, [string, string]>> = {
  decodeURI: [THROWING_MODULE, 'decodeURI'],
  decodeURIComponent: [THROWING_MODULE, 'decodeURIComponent'],
  encodeURI: [THROWING_MODULE, 'encodeURI'],
  encodeURIComponent: [THROWING_MODULE, 'encodeURIComponent'],
  'String.fromCodePoint': [THROWING_MODULE, 'fromCodePoint'],
};

/** The module the throwing globals are injected from; first among a bundle's plugins. */
export function throwingGlobalsPlugin(): Plugin {
  return {
    name: 'upwind-throwing-globals',
    resolveId: (source) => (source === THROWING_MODULE ? source : null),
    load: (id) => (id === THROWING_MODULE ? THROWING_SOURCE : null),
  };
}
