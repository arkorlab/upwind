/**
 * How the adapter writes a value into the JavaScript it generates.
 *
 * The entry tables the bundlers are fed, the rewrites the patches apply and the `define` values
 * esbuild substitutes are all source, and a value that goes into one has to be escaped for source.
 */

/**
 * Characters a generated JavaScript source must not carry as themselves.
 *
 * `JSON.stringify` escapes for JSON, and JSON is not JavaScript: it leaves these four alone.
 * U+2028 and U+2029 are line terminators to a JavaScript parser, so either one ends the string
 * literal it sits inside. `<` and `>` end nothing a parser reads, but a `</script` inside a literal
 * ends the element the source was written into, and escaped they cannot — which is the same set, and
 * the same escape, React writes its own inline scripts with. Every control character is already
 * escaped by `JSON.stringify`.
 */
const UNSAFE_IN_SOURCE: Readonly<Record<string, string>> = {
  '<': String.raw`\u003C`,
  '>': String.raw`\u003E`,
  '\u{2028}': String.raw`\u2028`,
  '\u{2029}': String.raw`\u2029`,
};
const UNSAFE_IN_SOURCE_PATTERN = /[<>\u{2028}\u{2029}]/gu;

/**
 * What may be written into generated source: a value with a JSON form, and nothing without one.
 *
 * `unknown` would take `undefined`, a function or a symbol, and `JSON.stringify` answers each of
 * those with `undefined` rather than a string — which the escape below would then fail on, in the
 * middle of somebody's build and about a line of generated code rather than about the value.
 */
type GeneratedValue =
  | string
  | number
  | boolean
  | null
  | readonly GeneratedValue[]
  | { readonly [key: string]: GeneratedValue };

/**
 * A JSON value as a JavaScript literal, escaped for the source it is written into.
 *
 * Sound for any value, because JSON says so: its structural characters are `[]{},:"` and nothing
 * else, so each character replaced below can only have come from inside a string, which is the one
 * place a unicode escape means what it says rather than standing for itself.
 */
export function jsLiteral(value: GeneratedValue): string {
  return JSON.stringify(value).replaceAll(
    UNSAFE_IN_SOURCE_PATTERN,
    (character) => UNSAFE_IN_SOURCE[character] ?? character,
  );
}
