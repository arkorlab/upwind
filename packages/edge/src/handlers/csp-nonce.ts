import { acceptsCspNonce, applyCspNonce } from '@stayingupwind/core/request';
import { releaseStream, toBase64 } from '@stayingupwind/core/util';
import { type CspNonceMode, SCRIPT_PRELOAD_LINKS } from '@stayingupwind/host/delivery';

/**
 * A CSP nonce the edge mints, for a project that has handed nonces over.
 *
 * The opt-in says that Cloudflare is part of this application's server rather than something in
 * front of it. A nonce can only ever tell a browser whether *the server* wrote the markup — there
 * is no half of a server to trust — so once the edge composes the document, the edge is what has to
 * mint the value. Replaying the one the origin minted at proof time would hand every visitor the
 * same nonce, which is the one thing a nonce may never be.
 *
 * And what wrote a script is what names it with the nonce: the edge the shell's, whose bytes it
 * serves (`noncedBody`), and Next.js those of the render that completes the shell for the request,
 * told the nonce with the request it renders (`handNonceToRender`). Nothing names a script that
 * reached the render from anywhere else — a visitor's input reflected into it among them.
 */

/** 128 bits, which is what the CSP specification asks of a nonce. */
const NONCE_BYTES = 16;
const NONCE_ATTRIBUTE = 'nonce';
const CSP_HEADER = 'content-security-policy';
const REPORT_ONLY_HEADER = 'content-security-policy-report-only';
const CSP_HEADERS: readonly string[] = [CSP_HEADER, REPORT_ONLY_HEADER];
// One registration calls the stamp once even when a script or preload already has a nonce.
const NONCE_ELEMENTS = ['script', '[nonce]', ...SCRIPT_PRELOAD_LINKS].join(',');

/**
 * The response without a policy at all: what a browser keeps of a response it refreshes with one
 * that carries none is the policy it kept with the body.
 */
export function withoutPolicies(headers: Headers): void {
  for (const name of CSP_HEADERS) {
    headers.delete(name);
  }
}

export function mintCspNonce(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/**
 * What the debug header says of a document's nonce, for shadow validation to check a run's against:
 * that one was minted, and the setting it was minted under — the mode (`mode`, none where the
 * project did not hand nonces over) and `'strict-dynamic'` beside it.
 */
export function cspMarkers(
  nonce: string | undefined,
  mode: CspNonceMode | undefined,
  strictDynamic: boolean,
): string {
  const minted = nonce === undefined ? '' : ';csp=nonce';
  const reportOnly = mode === 'report-only' ? ';csp-mode=report-only' : '';
  return `${minted}${reportOnly}${mode !== undefined && strictDynamic ? ';csp-strict-dynamic' : ''}`;
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

/** The ordered policy identities, without whitespace beside their comma boundaries. */
function policySequence(value: string): string {
  return value
    .split(',')
    .map((policy) => policy.trim())
    .join(',');
}

/**
 * The report-only policies with the trial of the enforcing one beside them — once: a document the
 * edge answered before, kept whole and answered again (a gate's), carries the trial already, its
 * nonce now this response's, and a second would have every violation reported twice.
 */
function withTrial(reporting: string | undefined, trial: string): string {
  if (reporting === undefined) {
    return trial;
  }
  const tried = `,${policySequence(reporting)},`.includes(`,${policySequence(trial)},`);
  return tried ? reporting : `${reporting}, ${trial}`;
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
    headers.set(REPORT_ONLY_HEADER, withTrial(replaced, clone));
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
 * Hand the render that completes a document the nonce its response carries, where Next.js reads the
 * one it renders with: off the request's `content-security-policy` — its `-report-only` where that
 * is absent — as the first nonce `script-src` names (`getScriptNonceFromHeader`, in every release
 * the adapter supports). It gives that nonce to the scripts it writes itself — the framework's, the
 * page's bundles, the data it inlines, React's own — and to nothing else, which is the whole of what
 * a nonce is for.
 *
 * Whatever the visitor or the middleware sent under either name is replaced: the render names this
 * response's nonce, or none. Under the enforcing name whatever the mode, as Next.js reads that one
 * first, and without `'strict-dynamic'`, which says nothing to a render: the response's policies are
 * as `applyNonceToHeaders` makes them, and this is no policy of the response's.
 */
export function handNonceToRender(headers: Headers, nonce: string): void {
  headers.set(CSP_HEADER, `script-src 'nonce-${nonce}'`);
  headers.delete(REPORT_ONLY_HEADER);
}

/**
 * Give a document's scripts the nonce its headers now carry: a document whole, which nothing
 * resumes — a build's or a generation's complete in itself, a gate's own answer — or a shell, as
 * far as its last byte and no further (`noncedBody`).
 *
 * Every `<script>` is stamped, whether or not it had one, and so is every link that preloads one
 * (`SCRIPT_PRELOAD_LINKS`); any other element that did have one is rewritten. One that names this
 * nonce already is left as it is, to the byte: stamping a document a second time then changes it
 * only where it does not name the nonce, which is how `@stayingupwind/local` holds a whole document
 * — the shell the edge stamped, and the render past it Next.js named — to leaving no script out.
 * Nothing the edge stamps names it beforehand, the nonce being minted for the response.
 *
 * Time-to-first-byte survives it. The nonce is the edge's own, decided before the response was
 * constructed, so nothing here waits on the origin, and `HTMLRewriter` emits each chunk as soon as
 * it is known not to be interesting.
 */
export function rewriteDocumentNonces(response: Response, nonce: string): Response {
  const stamp = {
    element(element: Element): void {
      if (element.getAttribute(NONCE_ATTRIBUTE) !== nonce) {
        element.setAttribute(NONCE_ATTRIBUTE, nonce);
      }
    },
  };
  return new HTMLRewriter().on(NONCE_ELEMENTS, stamp).transform(response);
}

function ignore(): void {
  // A chunk read ahead that failed is met where it is read, or let go with a reader that left.
}

/**
 * `first`, then `rest`, as one body: `rest` handed on only once `first` has ended, a chunk at a time
 * as whoever reads the body asks for one, and let go of with a reader that leaves — `rest` is the
 * splice, whose cancel lets the resume go — or with a `first` that fails before it.
 *
 * But read a chunk ahead from the start, as it would be at the head of the body. The splice reads
 * the resume only as fast as its own stream is read, and until the resume's first byte its budget is
 * the first byte's: held until a client had taken the whole shell, that byte would be read — and
 * reported — as late as the client was slow, and a client slow enough would have the resume given
 * up on. The chunk read ahead is the empty one the splice opens with where the shell goes ahead of
 * it, and once it is out of the way the splice reads the resume as it always did.
 */
function followedBy(
  first: ReadableStream<Uint8Array>,
  rest: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const head = first.getReader();
  const tail = rest.getReader();
  let ahead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined = tail.read();
  void ahead.catch(ignore);
  let headEnded = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let read: ReadableStreamReadResult<Uint8Array>;
        if (headEnded) {
          read = await (ahead ?? tail.read());
          ahead = undefined;
        } else {
          try {
            read = await head.read();
          } catch (error) {
            releaseStream(tail, 'the shell failed before its continuation');
            throw error;
          }
        }
        if (!read.done) {
          // An empty chunk is nothing to hand on: read again, rather than hand the reader nothing.
          if (read.value.byteLength > 0) {
            controller.enqueue(read.value);
            return;
          }
        } else if (headEnded) {
          controller.close();
          return;
        } else {
          headEnded = true;
        }
      }
    },
    cancel(reason: unknown) {
      const why = reason instanceof Error ? reason.message : String(reason);
      releaseStream(head, why);
      releaseStream(tail, why);
    },
  });
}

/**
 * A document's body with the nonce its headers now carry on its shell and on nothing after it: the
 * shell stamped as a document is (`rewriteDocumentNonces`), and then `rest` — what the splice puts
 * behind the shell, where a resume completes it — as it came.
 *
 * The shell alone. A nonce is a server's word that it wrote a script, and of a document a resume
 * completes the edge wrote the shell and nothing more: what follows is the application's render
 * for this one request, carrying whatever a visitor got into it, and Next.js has named its
 * own scripts in it already, with the nonce it was handed (`handNonceToRender`). Stamped here as
 * well, a `<script>` that reached the render from a visitor would run, and one whose `src` the
 * policy's hosts refuse would be fetched all the same: a nonce that matches answers for an element
 * before any host is looked at (CSP3 §6.7.3.3). The one script of the edge's own past the shell is
 * named where it is written (`RecoveryHtmlOptions.nonce`).
 *
 * From the shell's first byte to its last, and neither falls inside a tag. A shell is a prelude of
 * React's — what it flushed of its completed segments, with the closing `</body></html>` taken off
 * by Next.js (`createStripDocumentClosingTagsTransform`) — so every tag that begins in it ends in it,
 * and it is stamped alone as it would be at the head of the whole document. One that ended inside a
 * start tag would leave that one element unnamed: refused by the policy, never trusted by it.
 *
 * Time-to-first-byte is what it was, and the rewriter does less. The shell is in hand and its nonce
 * was minted before the resume was sent; the rewriter reads nothing of the resume, which is handed
 * on once the shell has gone out, as it comes, through no parser at all.
 */
export function noncedBody(
  shell: Uint8Array,
  contentType: string,
  nonce: string,
  rest?: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const document = new Response(shell, { headers: { 'content-type': contentType } });
  // A response made of bytes has a body, and so does what a rewriter makes of one; the Workers
  // declaration leaves both open.
  const stamped = rewriteDocumentNonces(document, nonce).body as ReadableStream<Uint8Array>;
  return rest === undefined ? stamped : followedBy(stamped, rest);
}
