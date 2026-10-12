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
}

const MS_PER_SECOND = 1000;

/**
 * Elements whose content the parser does not read as markup.
 *
 * Inside any of them the recovery `<script>` is text — or, in a template, an element that never
 * executes. Only the matching end tag leaves the state, so all of them are emitted: an end tag with
 * nothing open is a parse error the parser ignores, and a `</template>` with no template on the
 * stack is ignored too. `plaintext` has no end tag at all and is the one state nothing escapes.
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
  'template',
];

const END_TAGS = MARKUP_BLIND_ELEMENTS.map((name) => `</${name}>`).join('');
/**
 * Leaves whatever HTML state the origin stopped in, so the recovery script is markup and runs.
 *
 * The continuation can be cut at any byte. `"'">` closes an attribute value of either quoting — or
 * none, or one not started yet — and then the tag itself; `-->` closes a comment; the end tags
 * leave the elements above. In the ordinary case, a cut in character data, this is a few stray
 * characters on a document that is about to reload itself: the trade against a reload that never
 * happens and a user left on a truncated page.
 */
const ESCAPE_PREFIX = `"'">-->${END_TAGS}`;

/**
 * Appended when the continuation cannot be completed after the shell was flushed: sets a
 * short-lived bypass cookie (the edge then sends the reload straight to the deployment's own
 * Worker) and reloads once. A sessionStorage guard prevents reload loops when cookies are
 * disabled — keyed by the whole request, path and query, since `/search?q=a` failing is no reason
 * to leave the next visitor to `/search?q=b` on a truncated document for the rest of the guard's
 * window.
 */
export function buildRecoveryHtml(options: RecoveryHtmlOptions = {}): string {
  return `${ESCAPE_PREFIX}${RECOVERY_MARKER}<script>${buildRecoveryScript(options)}</script></body></html>`;
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
    '}catch(e){}',
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
