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
 * The one own key a generated object cannot carry.
 *
 * `{"__proto__": …}` in source is not a property. A JavaScript parser reads it as the literal's
 * prototype however the key is written — escaping the name changes nothing, since the rule is about
 * the name and not about the spelling — and the value is then not on the object at all. JSON has no
 * such rule: `JSON.parse` gives the key back as data and `JSON.stringify` writes it out again, so
 * this is the one value the escape below would hand on as something other than what it was given.
 */
const PROTOTYPE_KEY = '__proto__';

/**
 * Refuse that key, wherever it is, rather than write a literal that quietly drops it.
 *
 * `next build` is where a name nobody can generate should be answered. The other way round is a
 * Function missing an environment variable it was configured with, saying nothing about why.
 */
function assertNoPrototypeKey(value: GeneratedValue): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  // An array is asked the same question, and answers it: the key is never one of its own, since an
  // array's `__proto__` is its prototype's rather than the array's, and JSON has no name for it.
  if (Object.hasOwn(value, PROTOTYPE_KEY)) {
    throw new Error(
      `@stayingupwind/adapter: a generated object cannot carry a \`${PROTOTYPE_KEY}\` key, which JavaScript reads as a prototype rather than as a property`,
    );
  }
  for (const item of Object.values(value)) {
    assertNoPrototypeKey(item);
  }
}

/**
 * A JSON value as a JavaScript literal, escaped for the source it is written into.
 *
 * Sound for every value it accepts, because JSON says so: its structural characters are `[]{},:"`
 * and nothing else, so each character replaced below can only have come from inside a string, which
 * is the one place a unicode escape means what it says rather than standing for itself. The key
 * above is the exception JSON does not cover, and it is refused rather than written.
 */
export function jsLiteral(value: GeneratedValue): string {
  assertNoPrototypeKey(value);
  return JSON.stringify(value).replaceAll(
    UNSAFE_IN_SOURCE_PATTERN,
    (character) => UNSAFE_IN_SOURCE[character] ?? character,
  );
}
