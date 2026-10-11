/**
 * Globals Rolldown takes for pure although they throw on an ordinary argument: a malformed escape or
 * a lone surrogate for the URI functions, a code point out of range for `String.fromCodePoint`. It
 * drops a call to one whose result nothing reads, in a `try` block too, so a check that works by the
 * throw passes everything: `try { decodeURIComponent(path); return true } catch { return false }`
 * becomes `return true`. Read through `globalThis`, the call is a property read, which Rolldown
 * keeps; a name a module binds itself is not replaced. Every bundle the adapter makes defines these,
 * for the application's code as for the runtime's.
 *
 * The globals that only coerce their arguments (`parseInt`, `Math.*`, `String.fromCharCode`) stay
 * as they are: they throw on a Symbol or a BigInt alone, which the minifier assumes they are not
 * handed.
 */
export const THROWING_GLOBALS: Readonly<Record<string, string>> = {
  decodeURI: 'globalThis.decodeURI',
  decodeURIComponent: 'globalThis.decodeURIComponent',
  encodeURI: 'globalThis.encodeURI',
  encodeURIComponent: 'globalThis.encodeURIComponent',
  'String.fromCodePoint': 'globalThis.String.fromCodePoint',
};
