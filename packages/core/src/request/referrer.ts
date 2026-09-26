/**
 * What a referrer policy says about a request this platform would make on a document's behalf.
 *
 * A fetch a header starts — a `Link` value, or a `103` replayed from one — is made before the
 * document's own policy has reached the browser, so it carries what the default policy carries:
 * for a same-origin request, the document's full URL. A document that asked for less than that is
 * a document no hint may be sent for.
 */

/**
 * The policies under which a document's own request for a file of its origin carries less than a
 * URL.
 *
 * Every other value leaves a same-origin fetch sending the document's full URL, which is what a
 * fetch started from a header sends when no policy has reached the browser yet. These three do
 * not, so under them a hint would put in the `Referer` what the document asked to keep out of it.
 */
const QUIETER_THAN_A_HINT: ReadonlySet<string> = new Set([
  'no-referrer',
  'origin',
  'strict-origin',
]);
/** Every value a browser recognises: those three, and the ones that leave a fetch as it is. */
const REFERRER_POLICIES: ReadonlySet<string> = new Set([
  ...QUIETER_THAN_A_HINT,
  'no-referrer-when-downgrade',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);
const VALUE_SEPARATOR = ',';
const HTML_SPACES = '\t\n\f\r ';

function trimmed(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && HTML_SPACES.includes(value[start] ?? '')) {
    start += 1;
  }
  while (end > start && HTML_SPACES.includes(value[end - 1] ?? '')) {
    end -= 1;
  }
  return value.slice(start, end).toLowerCase();
}

/**
 * What a `<meta name="referrer">` is allowed to say that a header is not.
 *
 * The markup form was there before the header was, and the standard still maps what it used to be
 * written as: `never` is `no-referrer`, and a document that writes it asks for the same silence.
 */
const LEGACY_META_POLICIES: ReadonlyMap<string, string> = new Map([
  ['always', 'unsafe-url'],
  // `default` is the policy a document has when nothing sets one, which is not one of the names.
  ['default', ''],
  ['never', 'no-referrer'],
  ['origin-when-crossorigin', 'origin-when-cross-origin'],
]);

/**
 * The policy a `Referrer-Policy` header puts in force: the last value of the list it recognises.
 *
 * A header may carry a list so that a document can name a policy an older browser knows beside
 * the one it prefers; the last one that browser recognises is the one it uses.
 */
export function effectiveReferrerPolicy(declared: string | undefined): string {
  const tokens = (declared ?? '').split(VALUE_SEPARATOR);
  let policy = '';
  for (const token of tokens) {
    const candidate = trimmed(token);
    if (REFERRER_POLICIES.has(candidate)) {
      policy = candidate;
    }
  }
  return policy;
}

/**
 * And the policy a `<meta name="referrer">` puts in force, which is read differently.
 *
 * One token, not a list: the standard lowercases the whole `content`, maps the legacy spellings,
 * and sets the policy only "if value is a referrer policy". So `content="unsafe-url, no-referrer"`
 * is no policy at all and the document keeps the one it had — where the header form would have
 * read the list and taken the last of them.
 *
 * Trimmed first, which the standard does not do: a ` no-referrer` sets no policy there and is read
 * as one here. That reading only ever ends a walk sooner, which costs the hints below it and sends
 * none the document asked against.
 */
export function metaReferrerPolicy(content: string | undefined): string {
  const declared = trimmed(content ?? '');
  const policy = LEGACY_META_POLICIES.get(declared) ?? declared;
  return REFERRER_POLICIES.has(policy) ? policy : '';
}

/** Whether a document's own same-origin fetches say less than a fetch a header starts would. */
export function quietensASameOriginFetch(policy: string): boolean {
  return QUIETER_THAN_A_HINT.has(policy);
}
