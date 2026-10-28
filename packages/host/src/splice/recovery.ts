import {
  EDGE_BYPASS_COOKIE,
  EDGE_BYPASS_COOKIE_MAX_AGE_SECONDS,
  RECOVERY_LOOP_GUARD_SECONDS,
  RECOVERY_MARKER,
} from '@stayingupwind/core/request';
import { encodeUtf8, toBase64 } from '@stayingupwind/core/util';

export interface RecoveryHtmlOptions {
  readonly cookieName?: string | undefined;
  readonly maxAgeSeconds?: number | undefined;
  readonly loopGuardSeconds?: number | undefined;
  /**
   * The nonce of the document the script is appended to, which it then carries itself: nothing
   * stamps what follows a shell (`noncedBody`, in the edge), and a policy the script's hash was
   * never added to — one a middleware set at request time — still runs it by the nonce. A nonce is
   * never in the hash, which is taken over the script alone.
   */
  readonly nonce?: string | undefined;
}

/** A nonce as CSP spells one (`base64-value`): nothing that could leave the attribute it is in. */
const NONCE_VALUE = /^[\w+/-]+={0,2}$/u;

const MS_PER_SECOND = 1000;

/** The default script emitted now; checked against the emitted bytes by the host's suite. */
export const RECOVERY_SCRIPT_CSP_SOURCE = "'sha256-MXE+seoZCrcKyo81yxfujw3J7ntHZ3m+tuAFOWCS4pA='";
/** The default script deployed before a failed storage guard stopped the reload. */
export const LEGACY_RECOVERY_SCRIPT_CSP_SOURCE =
  "'sha256-T/OL9lSzpXVWaZqFmDChVEeKEFuHBdvZl7iXqSgvZys='";

// A whole source token only: a URL or longer token containing the hash is not its permission.
const LEGACY_RECOVERY_TOKEN =
  /(^|[\t\n\f\r ])'sha256-T\/OL9lSzpXVWaZqFmDChVEeKEFuHBdvZl7iXqSgvZys='(?=$|[\t\n\f\r ;,])/gu;
const CURRENT_RECOVERY_TOKEN = `$1${RECOVERY_SCRIPT_CSP_SOURCE}`;

/**
 * Keep an old deployment's permission for the default recovery script matched to today's script.
 * Only the owned hash is rotated, in its existing place; no policy is parsed or otherwise widened.
 * This scans one final enforcing policy when a partial document carries one, before its nonce is
 * applied. The new string is retained only where that policy named the old script.
 */
export function replaceLegacyRecoverySource(policy: string): string {
  // eslint-disable-next-line unicorn/no-unsafe-string-replacement -- A fixed public hash follows the intended $1 separator capture; no replacement text comes from input.
  return policy.replaceAll(LEGACY_RECOVERY_TOKEN, CURRENT_RECOVERY_TOKEN);
}

/**
 * Elements whose content the parser does not read as markup.
 *
 * Inside any of them the recovery `<script>` is text. Only the matching end tag leaves the state,
 * so all of them are emitted: an end tag with nothing open is a parse error the parser ignores.
 * `plaintext` has no end tag at all and is the one state nothing escapes.
 */
const MARKUP_BLIND_ELEMENTS: readonly string[] = [
  'script',
  'style',
  'textarea',
  'title',
  'noscript',
  'noembed',
  'noframes',
  'iframe',
  'xmp',
];

/**
 * How many templates the escape closes, after the elements above: in a template's own text-holding
 * child, a `</template>` is text until that child is left.
 *
 * In a template the recovery `<script>` is an element that never executes, and one `</template>`
 * closes only the innermost. Templates nest, client-side templating writing one inside another, so
 * the escape closes this many; one with no template open is ignored, as a stray end tag is, and
 * costs its bytes and nothing else. Past this depth the script is left inert, on markup nothing
 * writes.
 */
const NESTED_TEMPLATES = 16;

const END_TAGS = [
  ...MARKUP_BLIND_ELEMENTS.map((name) => `</${name}>`),
  '</template>'.repeat(NESTED_TEMPLATES),
].join('');
/**
 * A start tag SVG and MathML hand back to HTML.
 *
 * Inside either, a `<script>` is that language's element, and a MathML one never runs. This tag is
 * one the foreign-content rules break out on: it pops every foreign element, however deep they
 * nest, down to the nearest HTML one or integration point, where a `<script>` is HTML's. Elsewhere
 * it is an empty `<meta>`, which shows nothing and sets nothing.
 */
const LEAVE_FOREIGN_CONTENT = '<meta>';
/**
 * Leaves whatever HTML state the origin stopped in, so the recovery script is markup and runs.
 *
 * The continuation can be cut at any byte. `"'">` closes an attribute value of either quoting — or
 * none, or one not started yet — and then the tag itself; `]]>` closes a CDATA section, which SVG
 * and MathML may hold and only that ends; `-->` closes a comment; the end tags leave the elements
 * above, and then every template the cut was in; and last, inside none of them, a `<meta>` leaves
 * SVG and MathML. In the ordinary case, a cut in character data, this is a few stray characters on
 * a document that is about to reload itself: the trade against a reload that never happens and a
 * user left on a truncated page.
 */
const ESCAPE_PREFIX = `"'">]]>-->${END_TAGS}${LEAVE_FOREIGN_CONTENT}`;

/**
 * Appended when the continuation cannot be completed after the shell was flushed: sets a
 * short-lived bypass cookie (the edge then sends the reload straight to the deployment's own
 * Worker) and reloads once. A sessionStorage guard prevents reload loops when cookies are
 * disabled — keyed by the whole request, path and query, since `/search?q=a` failing is no reason
 * to leave the next visitor to `/search?q=b` on a truncated document for the rest of the guard's
 * window. If storage cannot retain that guard, no automatic reload is attempted.
 */
export function buildRecoveryHtml(options: RecoveryHtmlOptions = {}): string {
  const { nonce } = options;
  if (nonce !== undefined && !NONCE_VALUE.test(nonce)) {
    throw new TypeError('a recovery script is given a nonce, not markup');
  }
  const named = nonce === undefined ? '' : ` nonce="${nonce}"`;
  return `${ESCAPE_PREFIX}${RECOVERY_MARKER}<script${named}>${buildRecoveryScript(options)}</script></body></html>`;
}

/** The recovery script on its own: what a Content-Security-Policy hash has to be taken over. */
function buildRecoveryScript(options: RecoveryHtmlOptions = {}): string {
  const cookieName = options.cookieName ?? EDGE_BYPASS_COOKIE;
  const maxAge = options.maxAgeSeconds ?? EDGE_BYPASS_COOKIE_MAX_AGE_SECONDS;
  const guardMs = (options.loopGuardSeconds ?? RECOVERY_LOOP_GUARD_SECONDS) * MS_PER_SECOND;
  const script = [
    '(function(){',
    'try{',
    `var k="arkor-edge-recovery:"+location.pathname+location.search;`,
    'var t=Number(sessionStorage.getItem(k)||0);',
    `if(Date.now()-t<${guardMs}){return;}`,
    'sessionStorage.setItem(k,String(Date.now()));',
    '}catch(e){return;}',
    `document.cookie="${cookieName}=1; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure";`,
    'location.reload();',
    '})();',
  ].join('');
  return script;
}

/**
 * The CSP source expression that authorises the recovery script.
 *
 * A route's own Content-Security-Policy is sent with the shell, and the recovery script is
 * appended to a document whose headers went out long before. If that policy restricts inline
 * scripts, the browser blocks the one piece of code that gets the user off a broken document, so
 * the manifest records the policy with this hash already added.
 */
export async function recoveryScriptCspSource(options: RecoveryHtmlOptions = {}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encodeUtf8(buildRecoveryScript(options)) as BufferSource,
  );
  return `'sha256-${toBase64(new Uint8Array(digest))}'`;
}

export function buildRecoveryBytes(options: RecoveryHtmlOptions = {}): Uint8Array {
  return encodeUtf8(buildRecoveryHtml(options));
}
