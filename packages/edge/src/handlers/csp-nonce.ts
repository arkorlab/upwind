import { acceptsCspNonce, applyCspNonce } from '@stayingupwind/core/request';
import { toBase64 } from '@stayingupwind/core/util';
import { type CspNonceMode, SCRIPT_PRELOAD_LINKS } from '@stayingupwind/host/delivery';

/**
 * A CSP nonce the edge mints, for a project that has handed nonces over.
 *
 * The opt-in says that Cloudflare is part of this application's server rather than something in
 * front of it. A nonce can only ever tell a browser whether *the server* wrote the markup — there
 * is no half of a server to trust — so once the edge composes the document, the edge is what has to
 * mint the value. Replaying the one the origin minted at proof time would hand every visitor the
 * same nonce, which is the one thing a nonce may never be.
 */

/** 128 bits, which is what the CSP specification asks of a nonce. */
const NONCE_BYTES = 16;
const NONCE_ATTRIBUTE = 'nonce';
const CSP_HEADER = 'content-security-policy';
const REPORT_ONLY_HEADER = 'content-security-policy-report-only';
const CSP_HEADERS: readonly string[] = [CSP_HEADER, REPORT_ONLY_HEADER];

export function mintCspNonce(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/**
 * Whether this route has somewhere for a minted nonce to go.
 *
 * The opt-in is per project; a policy is per route, and a route may send none at all or send one
 * with no directive governing scripts. Minting for either would move bytes and run a parser to put
 * a nonce on the wire that no policy names — which is the state shadow validation refuses.
 */
export function acceptsNonce(headers: Headers): boolean {
  return CSP_HEADERS.some((name) => {
    const policy = headers.get(name);
    return policy !== null && acceptsCspNonce(policy);
  });
}

const STRICT_DYNAMIC = "'strict-dynamic'";
/** The directives `'strict-dynamic'` means anything in: the ones a script is checked against. */
const SCRIPT_DIRECTIVES: ReadonlySet<string> = new Set([
  'default-src',
  'script-src',
  'script-src-elem',
]);

/**
 * `'strict-dynamic'` beside this nonce, in each directive governing scripts that names it.
 *
 * Only where the nonce is: the keyword hands trust on from a nonced script, and a directive without
 * one would trust nothing at all once it stopped counting `'self'` and hosts. A directive the
 * application already gave the keyword is left as it is, and so is every byte around the one added.
 * `style-src` and its kind can name the nonce too — every source naming one is replaced — but the
 * keyword governs scripts alone, so they are left without it.
 */
function withStrictDynamic(value: string, nonce: string): string {
  const source = `'nonce-${nonce}'`;
  return value
    .split(',')
    .map((policy) => {
      return policy
        .split(';')
        .map((directive) => {
          const tokens = directive.trim().split(/\s+/u);
          const name = tokens[0]?.toLowerCase() ?? '';
          if (
            !SCRIPT_DIRECTIVES.has(name) ||
            !tokens.includes(source) ||
            tokens.some((token) => token.toLowerCase() === STRICT_DYNAMIC)
          ) {
            return directive;
          }
          return directive.replace(
            /(\S)(\s*)$/u,
            (_match, last: string, trailing: string) => `${last} ${STRICT_DYNAMIC}${trailing}`,
          );
        })
        .join(';');
    })
    .join(',');
}

/** Replace only sources already naming a nonce, preserving every other byte of the policy. */
function withExistingNoncesReplaced(value: string, nonce: string): string {
  return value.replaceAll(
    /(^|[;,\s])('nonce-)[^'\s]*'(?=[;,\s]|$)/giu,
    (_match, leading: string, prefix: string) => `${leading}${prefix}${nonce}'`,
  );
}

/**
 * Put the minted nonce in the selected policy, with no placeholder reaching a browser.
 *
 * Report-only trials the enforcing policy with a nonce added, while its original sources keep
 * being enforced. Existing nonce values still have to follow the body the edge rewrites. An
 * application's own report-only policy remains a separate policy; its directives are never
 * merged with the clone's, and its reporting destinations remain its own.
 */
function applyReportOnlyNonce(headers: Headers, nonce: string, strictDynamic: boolean): void {
  const enforcing = headers.get(CSP_HEADER);
  const reporting = headers.get(REPORT_ONLY_HEADER);
  // The keyword goes on the trial alone, which is what is being tried: the enforcing policy keeps
  // every source it had, and an application's own report-only policy is its own.
  const trialled = (policy: string): string => {
    const nonced = applyCspNonce(policy, nonce);
    return strictDynamic ? withStrictDynamic(nonced, nonce) : nonced;
  };
  const clone =
    enforcing !== null && acceptsCspNonce(enforcing)
      ? trialled(withExistingNoncesReplaced(enforcing, nonce))
      : undefined;
  if (enforcing !== null) {
    headers.set(CSP_HEADER, withExistingNoncesReplaced(enforcing, nonce));
  }
  const replaced = reporting === null ? undefined : withExistingNoncesReplaced(reporting, nonce);
  if (clone !== undefined) {
    headers.set(REPORT_ONLY_HEADER, replaced === undefined ? clone : `${replaced}, ${clone}`);
  } else if (replaced !== undefined) {
    // A report-only policy can be the route's only policy. Without an enforcing clone to trial,
    // the application's existing report-only policy is where the nonce is enabled.
    headers.set(REPORT_ONLY_HEADER, trialled(replaced));
  }
}

/**
 * Put the minted nonce in the response's policies, as the mode says, and `'strict-dynamic'` beside
 * it where the project asked for it (`EdgePointer.cspStrictDynamic`). Never the keyword without
 * the nonce: it is added only here, after the nonce, and only where the nonce went.
 */
export function applyNonceToHeaders(
  headers: Headers,
  nonce: string,
  mode: CspNonceMode,
  strictDynamic = false,
): void {
  if (mode === 'report-only') {
    applyReportOnlyNonce(headers, nonce, strictDynamic);
    return;
  }
  for (const name of CSP_HEADERS) {
    const policy = headers.get(name);
    if (policy !== null) {
      const nonced = applyCspNonce(policy, nonce);
      headers.set(name, strictDynamic ? withStrictDynamic(nonced, nonce) : nonced);
    }
  }
}

/**
 * Give the document's scripts the nonce its headers now carry.
 *
 * Every `<script>` is stamped, whether or not it had one, and so is every link that preloads one
 * (`SCRIPT_PRELOAD_LINKS`); any other element that did have one is rewritten. The shell's own
 * scripts are included — the document a browser receives has to name one nonce throughout, and
 * half of it is the shell.
 *
 * Over the whole response, not only the continuation. The shell's boundary is a chunk arrival, so
 * it can fall inside a tag; a parser started there would misread the tag it landed in. From byte
 * zero every tag reaches the parser whole.
 *
 * Time-to-first-byte survives it. The nonce is the edge's own, decided before the response was
 * constructed, so nothing here waits on the origin, and `HTMLRewriter` emits each chunk as soon as
 * it is known not to be interesting — with the origin held open the document still reaches the
 * client as far as the first `<script>` the parser has to stop at.
 */
export function rewriteDocumentNonces(response: Response, nonce: string): Response {
  const stamp = {
    element(element: Element): void {
      element.setAttribute(NONCE_ATTRIBUTE, nonce);
    },
  };
  const rewriter = new HTMLRewriter().on('script', stamp).on('[nonce]', stamp);
  for (const selector of SCRIPT_PRELOAD_LINKS) {
    rewriter.on(selector, stamp);
  }
  return rewriter.transform(response);
}
