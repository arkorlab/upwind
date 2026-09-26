/**
 * Content-Security-Policy adjustments for documents the edge splices.
 *
 * The edge replays a proved route's own policy with the shell, and appends the recovery script to a
 * document whose headers went out long before the failure that needs recovering from. A policy that
 * restricts inline scripts would block the one piece of code that gets the user off a broken
 * document, so the manifest records the policy with the recovery script's hash already permitted.
 */

const CSP_HEADER = 'content-security-policy';
const SCRIPT_ELEM_DIRECTIVE = 'script-src-elem';
const SCRIPT_DIRECTIVE = 'script-src';
const DEFAULT_DIRECTIVE = 'default-src';
const STYLE_ELEM_DIRECTIVE = 'style-src-elem';
const STYLE_DIRECTIVE = 'style-src';
const FONT_DIRECTIVE = 'font-src';
const SELF = "'self'";
const ANY_SOURCE = '*';
/**
 * The scheme sources a file of an https document's own origin is fetched under.
 *
 * `http:` among them because CSP says so: "We always allow a secure upgrade from an explicitly
 * insecure expression", and `style-src http:` is
 * [treated as](https://www.w3.org/TR/CSP3/#match-schemes) `style-src http: https:`. Everything
 * this platform serves is https, so both permit what a hint would fetch.
 */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);
const UNSAFE_INLINE = "'unsafe-inline'";

interface Directive {
  readonly name: string;
  readonly sources: readonly string[];
}

function parseCsp(value: string): Directive[] {
  const directives: Directive[] = [];
  for (const part of value.split(';')) {
    const tokens = part
      .trim()
      .split(/\s+/u)
      .filter((token) => token !== '');
    const [name, ...sources] = tokens;
    if (name !== undefined) {
      directives.push({ name: name.toLowerCase(), sources });
    }
  }
  return directives;
}

function serializeCsp(directives: readonly Directive[]): string {
  return directives.map((directive) => [directive.name, ...directive.sources].join(' ')).join('; ');
}

function isNonce(source: string): boolean {
  return source.toLowerCase().startsWith("'nonce-");
}

function isNonceOrHash(source: string): boolean {
  const lower = source.toLowerCase();
  return isNonce(source) || lower.startsWith("'sha");
}

function withoutNonceSources(directive: Directive): Directive {
  return {
    name: directive.name,
    sources: directive.sources.filter((source) => !isNonce(source)),
  };
}

/**
 * The same policy with every nonce source removed.
 *
 * A nonce is minted per response. Two samples of one route therefore never agree on the header, so
 * the route is delegated as `headers-unstable` — which is every route of an application that uses
 * one, even when the document itself is byte-identical across requests.
 *
 * Removing rather than replaying is the point. A shell goes to every visitor, so a nonce carried on
 * it is a nonce they all share, and one an injected script could reuse — which is the whole of what
 * a nonce defends against. There is no per-response value a replayed header can carry.
 *
 * Report-only alone, and deliberately so. Taking a nonce out of an enforcing policy blocks whatever
 * the document relied on it for; under a report-only policy the same document reports and still
 * renders, which is what makes leaving it out conservative rather than a quiet weakening. A route
 * whose *enforcing* policy carries a nonce stays unstable until the edge can mint one per response.
 *
 * Removing a source can only produce more reports, never fewer — which is the other half of what
 * `allowRecoveryScript` below refuses to do to this header: suppress one the app put there.
 */
export function withoutCspNonces(value: string): string {
  const stripped = value.split(',').map((policy) => {
    const directives = parseCsp(policy);
    return serializeCsp(directives.map((directive) => withoutNonceSources(directive)));
  });
  return stripped.join(', ');
}

/**
 * What a proved policy carries where the origin put a nonce.
 *
 * A placeholder rather than nothing, because its position is the only record of which directives the
 * origin gave a nonce to — and `withoutCspNonces` above, which does remove them, cannot tell the
 * edge where to put one back. Two samples of a route agree on this the way they never agree on the
 * value it stands in for.
 */
const NONCE_PLACEHOLDER = "'nonce-{ppr}'";

/** The policy as it is stored for a project whose edge mints the nonce itself. */
export function withCspNoncePlaceholder(value: string): string {
  const placed = value.split(',').map((policy) => {
    const directives = parseCsp(policy).map((directive) => {
      // Deduplicated: a directive naming two different nonces would otherwise name the placeholder
      // twice, and the stored policy would differ from one the origin wrote with a single nonce.
      const sources = directive.sources.map((source) =>
        isNonce(source) ? NONCE_PLACEHOLDER : source,
      );
      return { name: directive.name, sources: [...new Set(sources)] };
    });
    return serializeCsp(directives);
  });
  return placed.join(', ');
}

/** Whether a policy still names the placeholder — a value no browser should ever be shown. */
export function hasCspNoncePlaceholder(value: string): boolean {
  return value.includes(NONCE_PLACEHOLDER);
}

/**
 * The policy a response actually carries: the placeholder replaced by a nonce minted for it.
 *
 * A string replacement rather than a re-parse, because this runs before the shell's headers are
 * committed and the stored value was written by `withCspNoncePlaceholder` — the placeholder is
 * there verbatim or not at all.
 *
 * When it is not there, the policy was set at request time or named no nonce: any nonce it names
 * is replaced by this one, and this one is added to the directive that governs scripts.
 * `'unsafe-inline'` is not consulted: this is the opt-in whose whole content is that the edge
 * takes nonces over, and a rule that quietly declined on some policies would make what is in
 * force differ per project with nothing saying so. A policy that constrains scripts
 * nowhere is still left alone — there is no directive to add a source to, and inventing one would
 * newly forbid every script the document loads.
 */
export function applyCspNonce(value: string, nonce: string): string {
  const source = `'nonce-${nonce}'`;
  if (hasCspNoncePlaceholder(value)) {
    // A function, so `$&` and friends in a base64 nonce could never be read as replacement syntax.
    return value.replaceAll(NONCE_PLACEHOLDER, () => source);
  }
  return value
    .split(',')
    .map((policy) => addToScriptDirective(withNonceReplaced(policy, source), source))
    .join(', ');
}

/**
 * A policy that names nonces of its own — one set at request time, by a middleware that mints them
 * — with each replaced by the one minted here. The edge stamps its nonce on every element that
 * carried one, a `<style>` as much as a `<script>`, so a directive still naming the middleware's
 * would refuse exactly what the edge stamped. A policy that names none is returned as it came.
 */
function withNonceReplaced(policy: string, source: string): string {
  const directives = parseCsp(policy);
  if (directives.every((directive) => directive.sources.every((named) => !isNonce(named)))) {
    return policy;
  }
  return serializeCsp(
    directives.map((directive) => {
      const sources = directive.sources.map((named) => (isNonce(named) ? source : named));
      return { name: directive.name, sources: [...new Set(sources)] };
    }),
  );
}

/**
 * Whether the source list already lets an arbitrary inline script run.
 *
 * `'unsafe-inline'` is ignored by CSP level 3 as soon as a nonce or a hash is present, so it only
 * counts on its own.
 */
function allowsAnyInlineScript(sources: readonly string[]): boolean {
  return sources.includes(UNSAFE_INLINE) && sources.every((source) => !isNonceOrHash(source));
}

/**
 * Whether a minted nonce has anywhere to go in this policy.
 *
 * Either the origin already put one here — the placeholder marks the spot — or there is a directive
 * governing scripts to add one to. A policy with neither is left alone: `frame-ancestors 'none'` is
 * a whole CSP for a great many applications, and giving it a `script-src` would newly forbid every
 * script the document loads. Stamping such a document would then put a nonce on the wire that no
 * policy names, which is exactly the state shadow validation refuses.
 */
export function acceptsCspNonce(value: string): boolean {
  return value
    .split(',')
    .some(
      (policy) => hasCspNoncePlaceholder(policy) || scriptDirective(parseCsp(policy)) !== undefined,
    );
}

const SANDBOX_DIRECTIVE = 'sandbox';
const ALLOW_SCRIPTS = 'allow-scripts';
const ALLOW_SAME_ORIGIN = 'allow-same-origin';

/**
 * Why the recovery script could not run under this policy, or `undefined` when it can.
 *
 * `sandbox` puts the document under the iframe sandbox rules whatever it was loaded into. Without
 * `allow-scripts` no script runs at all, so the one piece of code that gets a visitor off a
 * truncated document never executes. Without `allow-same-origin` the document has an opaque
 * origin: `document.cookie` and `sessionStorage` both throw, so the bypass cookie is never set
 * and the loop guard never records anything — the reload would come straight back to the same
 * broken document, and again, for as long as the visitor watched.
 *
 * Neither is something the edge can work around from inside the document, so a route whose policy
 * says either is delegated: its documents are the Function's, where nothing has to be recovered.
 */
export function sandboxBlocksRecovery(value: string): string | undefined {
  for (const policy of value.split(',')) {
    const sandbox = parseCsp(policy).find((directive) => directive.name === SANDBOX_DIRECTIVE);
    if (sandbox === undefined) {
      continue;
    }
    // Sandbox tokens are keywords, matched without regard to case — unlike the source
    // expressions elsewhere in a policy, where a nonce and a hash mean their exact bytes.
    const tokens = new Set(sandbox.sources.map((token) => token.toLowerCase()));
    // A `sandbox` with no token at all is the most restrictive of them: every flag is off.
    const missing = [ALLOW_SCRIPTS, ALLOW_SAME_ORIGIN].filter((token) => !tokens.has(token));
    if (missing.length > 0) {
      return `sandbox without ${missing.join(' and ')}`;
    }
  }
  return undefined;
}

/** Whether a policy leaves inline scripts wide open, which a minted nonce is about to change. */
export function permitsAnyInlineScript(value: string): boolean {
  return value.split(',').some((policy) => {
    const governing = scriptDirective(parseCsp(policy));
    return governing !== undefined && allowsAnyInlineScript(governing.sources);
  });
}

/** The directive that governs inline `<script>` elements, following the CSP fallback chain. */
function scriptDirective(directives: readonly Directive[]): Directive | undefined {
  return (
    directives.find((directive) => directive.name === SCRIPT_ELEM_DIRECTIVE) ??
    directives.find((directive) => directive.name === SCRIPT_DIRECTIVE) ??
    directives.find((directive) => directive.name === DEFAULT_DIRECTIVE)
  );
}

/**
 * Add a source to the directive that governs script elements, leaving everything else alone.
 *
 * When only `default-src` constrains scripts, an explicit `script-src` is added with the same
 * sources plus the new one: widening `default-src` would relax every other fetch type as well.
 */
function addToScriptDirective(value: string, source: string): string {
  const directives = parseCsp(value);
  const governing = scriptDirective(directives);
  if (governing === undefined || governing.sources.includes(source)) {
    return value;
  }
  const sources = [...governing.sources, source];
  if (governing.name === DEFAULT_DIRECTIVE) {
    return serializeCsp([...directives, { name: SCRIPT_DIRECTIVE, sources }]);
  }
  return serializeCsp(
    directives.map((directive) =>
      directive.name === governing.name ? { name: directive.name, sources } : directive,
    ),
  );
}

/**
 * Permit the recovery script's hash, unless the policy already lets any inline script run.
 *
 * Unlike a minted nonce, a hash is worth nothing to a policy that has already given up on inline
 * scripts, and adding one there would newly forbid everything it was permitting.
 */
export function allowInlineScriptHash(value: string, hashSource: string): string {
  const governing = scriptDirective(parseCsp(value));
  if (governing === undefined || allowsAnyInlineScript(governing.sources)) {
    return value;
  }
  return addToScriptDirective(value, hashSource);
}

/**
 * Record a route's replayed headers with the recovery script permitted.
 *
 * Only the enforcing header is touched. A report-only policy blocks nothing, and quietly editing it
 * would suppress a report the app put there on purpose.
 *
 * The name is found without regard to case, and keeps the case it came with: a route's recorded
 * headers are lowercase already, but the rules of `next.config` are published as the application
 * wrote them, and the edge replays those over the route's own.
 */
export function allowRecoveryScript(
  headers: Readonly<Record<string, string>>,
  hashSource: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (name.toLowerCase() !== CSP_HEADER) {
        return [name, value];
      }
      // An origin may send the header more than once, and `Headers` joins those fields with a
      // comma. A browser enforces each policy on its own, so the strictest one decides: widening
      // only the first would leave the recovery script blocked by whichever was left alone.
      const widened = value
        .split(',')
        .map((policy) => allowInlineScriptHash(policy, hashSource))
        .join(', ');
      return [name, widened];
    }),
  );
}

/** What a fetch this judges a policy for is made as; the two a proved route's hints ever name. */
export type PolicyDestination = 'font' | 'style';

/** The directives that govern one of those, in the order a policy falls back through them. */
function governingDirectives(destination: PolicyDestination): readonly string[] {
  return destination === 'font'
    ? [FONT_DIRECTIVE, DEFAULT_DIRECTIVE]
    : [STYLE_ELEM_DIRECTIVE, STYLE_DIRECTIVE, DEFAULT_DIRECTIVE];
}

/**
 * Whether a source permits a file of the document's own origin.
 *
 * `'self'` says so outright, `*` covers every network URL, and a bare scheme covers every URL
 * under it. A host source names a host this cannot check: the document is served under whichever
 * hostname the project has — a preview label, a custom hostname — and which one that is is not
 * known where a route's headers are recorded. So a policy that lists hosts and never `'self'` is
 * one this sends nothing for, which is also what a policy naming somebody else's origin deserves.
 */
function permitsTheDocumentsOrigin(source: string): boolean {
  const lower = source.toLowerCase();
  return lower === SELF || lower === ANY_SOURCE || NETWORK_SCHEMES.has(lower);
}

/**
 * Whether every policy in this header lets the document fetch a file of its own origin as this.
 *
 * A header may carry more than one policy, and a browser enforces each of them, so the strictest
 * decides. A directive that names no source this can read as the document's own origin — `'none'`,
 * a nonce, a hash, `'unsafe-inline'`, somebody else's host — is one a preload would be refused
 * under, and a hint for it is a request the document is not allowed to make. Where no directive
 * governs the destination, nothing is forbidden.
 */
export function permitsSameOriginFetch(value: string, destination: PolicyDestination): boolean {
  const names = governingDirectives(destination);
  return value.split(',').every((policy) => {
    const directives = parseCsp(policy);
    const governing = names
      .map((name) => directives.find((directive) => directive.name === name))
      .find((directive) => directive !== undefined);
    return (
      governing === undefined ||
      governing.sources.some((source) => permitsTheDocumentsOrigin(source))
    );
  });
}
