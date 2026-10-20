import { type RouteEntry, staticFileKey } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';

import {
  answeredBy,
  answerTo,
  type CheckedStack,
  EDGE_HEADER,
  failed,
  FROM_STORAGE,
  type Kept,
  keptFailure,
  keptOf,
  withGenerationEvidence,
  middlewareCovers,
  middlewareAnswered,
  middlewareHeadersOnly,
  middlewareRan,
  policyFailure,
  SHELL_ANSWER,
  skipped,
  stampedOf,
  traced,
  unrunFailure,
  type Verdict,
} from './answers.ts';
import { sharedCacheFailure } from './cache-control.ts';
import { type Accepted, codingFailure, codedOf } from './codings.ts';
import { finishedFailure, incompleteness } from './completeness.ts';
import { readDocument } from './document-reading.ts';
import {
  HEAD_HANDED_ON,
  headLandingHandoffFailure,
  headRecordHandoffFailure,
  regeneratedFailure,
  wholeHeadFailure,
} from './document-records.ts';
import { rewrittenOnto } from './files.ts';
import {
  bypassedVerdict,
  landingOf,
  movedAway,
  movedFailure,
  moveOf,
  namedRoutes,
  rewriteOf,
  sentOf,
  servedAs,
  shellBypassFailure,
  whereLanded,
} from './landings.ts';
import { noncedOf, unstampedFailure } from './nonces.ts';
import { DOCUMENT_HANDOFFS, documentHandedOnVerdict } from './part-handoffs.ts';
import type { Reading } from './reading.ts';
import {
  type Application,
  applicationOf,
  laidFailure,
  recordedOf,
  regeneratedLaidFailure,
  regenerationFailure,
  renderedSince,
  servedGeneration,
  servedWhole,
} from './recorded.ts';
import { shellOf } from './shells.ts';

/**
 * A prerendered route, as the check asks for it (`check.ts`): a browser's navigation, answered with
 * a document that begins with the bytes the build wrote for the route's shell and is completed by
 * the Function rather than by the edge's recovery — or regenerated in the foreground, where the
 * route's record in the runtime cache is past its expiry, as a deployment of an older build is. The
 * shell is served as it was written — with the nonce the edge minted for the document stamped in
 * it, for a site that has the edge mint one (`nonces.ts`).
 *
 * The edge names the route a document is (`route=`, its manifest key). Where the application's
 * middleware ran and moved the request onto another route of the build, the document is judged as
 * that route's, and onto a file, by that file's bytes: what the middleware chose is skipped where
 * it is what the build holds, and fails where it is not.
 */

/** What it says of a page it regenerated in the foreground, its record past its expiry. */
const REGENERATED = /^passthrough;reason=regenerate(?:;|$)/u;
/** What the edge says of a page Next.js renders for the request itself (`bypassFor`). */
const BYPASSED = /^passthrough;reason=bypass-for(?:;|$)/u;

export interface Asked {
  /** The manifest's key for the route: its pathname, or its class's template. */
  readonly key: string;
  /**
   * Where it is asked: a pathname of its own (`validationPathnameFor`), with the query it carries
   * where a rule claims a request without it (`escaping`).
   */
  readonly requested: string;
  readonly route: RouteEntry;
  /** The navigation it is asked with: a browser the edge serves the shell to (`browsers.ts`). */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The coding it is asked for in, where it is asked in one in place of identity — as a browser asks
   * a page (`accept-encoding`), the coding named in `headers` — and its body read undone of it.
   */
  readonly coding?: Accepted | undefined;
  /** Whether `requested` is one only the rules ahead of the filesystem claim. */
  readonly exact?: boolean | undefined;
  /** Handed the answer it is asked for with, once it came: what a browser keeps of it. */
  readonly answered?: ((answer: Reading) => void) | undefined;
}

/** What a document is judged by beside its route: who set what it carries, and what it says. */
interface Judged {
  readonly answer: Reading;
  /** Whether the application set a header itself — its route, its rules, its middleware. */
  readonly setByApplication: (header: string) => boolean;
  /**
   * The bytes the build wrote for the route's shell, as the edge serves them: with the nonce it
   * minted for the document stamped in them, where it minted one. None where the build holds none.
   */
  readonly shell: Buffer | undefined;
  /** Whether it was asked for its headers alone (`HEAD`), which no body follows. */
  readonly head: boolean;
  /** The coding it was asked for in, where it was asked in one (`Asked.coding`). */
  readonly coding?: Accepted | undefined;
  /** The agent it was asked by (`User-Agent`), where the request named one. */
  readonly agent?: string | undefined;
}

/** Why a document the edge composed is not a route's shell, completed, and kept to its visitor. */
function shellFailure(route: RouteEntry, judged: Judged): string | undefined {
  const { answer, shell } = judged;
  if (answer.status !== route.status) {
    return `answered ${answer.status}`;
  }
  // The edge serves a document as the type its shell was written as, which nothing else it does
  // changes, and which a middleware's response headers are not merged over
  // (`mergeMiddlewareResponseHeaders` leaves `Content-Type` as it is): a browser shows HTML of
  // another type as text.
  const type = answer.headers['content-type'];
  if (type !== route.shell.contentType) {
    return `answered as ${type ?? 'no type'}, not ${route.shell.contentType}`;
  }
  const coded = codingFailure(answer, { coding: judged.coding, agent: judged.agent });
  if (coded !== undefined) {
    return coded;
  }
  // A `HEAD` is answered with the headers the `GET` would carry, and no body (`handleDocument`).
  if (judged.head) {
    return answer.length > 0
      ? 'answered with a body'
      : sharedCacheFailure(answer, judged.setByApplication);
  }
  if (shell === undefined) {
    return 'its shell is missing from the build, or is not the blob its digest names';
  }
  const rendered = renderedSince(answer, route);
  if (!rendered && !answer.head.subarray(0, shell.byteLength).equals(shell)) {
    return 'does not begin with the shell the build wrote for it';
  }
  // A document the edge composes is one visitor's, finished or not (`documentCacheControl`): kept
  // from shared caches, but for what the application set itself, which goes out as it set it.
  return (
    finishedFailure(route, answer, { rendered, shell }) ??
    incompleteness(answer) ??
    sharedCacheFailure(answer, judged.setByApplication)
  );
}

/**
 * Why a document of `route` the edge composed is not that route's shell, completed, and kept to its
 * visitor (`shellFailure`), nor carries every header the application set on it (`laidFailure`) —
 * its headers judged by what was recorded with what was served.
 */
async function servedFailure(
  stack: CheckedStack,
  served: { readonly route: RouteEntry; readonly pathname: string },
  read: {
    readonly answer: Reading;
    readonly application: Application;
    readonly head?: boolean;
    readonly coding?: Accepted | undefined;
    readonly agent?: string | undefined;
  },
): Promise<string | undefined> {
  const generation = servedGeneration(read.answer, served.route);
  const recorded = await recordedOf(stack, { ...served, generation });
  if ('failure' in recorded) {
    return recorded.failure;
  }
  const { headers } = recorded;
  const { answer, application } = read;
  const setByApplication = (header: string): boolean => application.sets(header, headers);
  const laid = application.laid(headers);
  // What the edge did of a nonce, which its shell and its policies carry where it minted one.
  const nonced = await noncedOf(stack, answer, laid);
  if (nonced.kind === 'failed') {
    return nonced.reason;
  }
  const head = read.head === true;
  const built = head ? undefined : shellOf(stack, served.route);
  const shell =
    built === undefined || nonced.kind === 'none'
      ? built
      : await stampedOf(stack, built, nonced.nonce);
  // The rest of it as the shell: its every script named by the nonce, and the preloads of them.
  return (
    shellFailure(served.route, { answer, setByApplication, shell, head, ...codedOf(read) }) ??
    (nonced.kind === 'minted' ? unstampedFailure(answer) : undefined) ??
    laidFailure(answer, nonced.kind === 'minted' ? nonced.laid : laid)
  );
}

/**
 * Why a page, asked for its headers alone (`HEAD`) as a link checker asks, is not answered as the
 * edge answers this request (`handleDocument`): one whole — the
 * build's finished shell, or a generation complete in itself — from what it holds, under the
 * stack's policy, with the headers the `GET` would carry and no body; one a resume completes
 * handed on to the Function behind the middleware (`headToApplication`), as its headers are the
 * resume's to decide. A request of its own to the application's routing: one the middleware
 * answers, or moves, is the middleware's.
 */
async function headFailure(stack: CheckedStack, asked: Asked): Promise<string | undefined> {
  const url = new URL(asked.requested, stack.site);
  await using tracing = await traced(stack, asked.headers);
  const { headers, trace } = tracing;
  const answer = await answerTo(url, { via: stack.url, method: 'HEAD', headers });
  if (typeof answer === 'string') {
    return `asked for with HEAD, ${answer}`;
  }
  if (middlewareAnswered(answer) !== undefined) {
    return undefined;
  }
  // Read whether or not the edge says the middleware ran, which is what is checked (`keptFailure`).
  const kept = await keptOf(stack, trace, url, asked.headers);
  const { decided } = kept;
  const captured = withGenerationEvidence(stack, kept);
  const answered = answeredBy(answer);
  const complete = answered.startsWith(SHELL_ANSWER)
    ? servedWhole(answered)
    : !HEAD_HANDED_ON.test(answered) && asked.route.cache?.delivery === 'complete';
  const covered = middlewareCovers(stack, url, asked.headers);
  const unkept =
    keptFailure(answer, decided, covered) ??
    (complete ? undefined : unrunFailure(decided, covered, 'handed it on'));
  if (unkept !== undefined) {
    return `asked for with HEAD, ${unkept}`;
  }
  const failure = complete
    ? await headAnswerFailure(captured, asked, { answer, url, decided })
    : await handedOnHeadFailure(captured, asked, { answer, decided });
  return failure === undefined ? undefined : `asked for with HEAD, ${failure}`;
}

/**
 * Why a `HEAD` of a page a resume completes is not handed on to the Function as the edge hands one
 * (`headToApplication`): what the Function answers is the application's. Where the middleware moved
 * it, held to where it landed (`movedHeadFailure`); where it has the page bypass its prerender, the
 * application's as well.
 */
async function handedOnHeadFailure(
  stack: CheckedStack,
  asked: Asked,
  read: { readonly answer: Reading; readonly decided: MiddlewareResult | undefined },
): Promise<string | undefined> {
  const { answer, decided } = read;
  if (decided?.kind === 'continue' && movedAway(stack, asked.route, decided)) {
    return movedHeadFailure(stack, asked, { answer, decided });
  }
  const answered = answeredBy(answer);
  const bypassed = BYPASSED.test(answered)
    ? bypassedVerdict(stack, decided, sentOf(stack, asked))
    : undefined;
  if (bypassed !== undefined) {
    return bypassed.kind === 'failed' ? bypassed.reason : undefined;
  }
  if (!HEAD_HANDED_ON.test(answered)) {
    return `not handed on to the Function, as a page a resume completes is (${EDGE_HEADER}: ${answered})`;
  }
  const pathname = decided?.kind === 'continue' ? decided.url.pathname : asked.requested;
  return headRecordHandoffFailure(
    stack,
    asked.route,
    new URL(pathname, stack.site).pathname,
    answered,
  );
}

/**
 * Why a `HEAD` of a page the build finished is not answered as the edge answers it (`headFailure`):
 * from its own route's shell, under the stack's policy, with the headers the `GET` would carry — but
 * where the middleware has it bypass its prerender, which is the application's, or moved it.
 */
async function headAnswerFailure(
  stack: CheckedStack,
  asked: Asked,
  read: {
    readonly answer: Reading;
    readonly url: URL;
    readonly decided: MiddlewareResult | undefined;
  },
): Promise<string | undefined> {
  const { answer, decided } = read;
  const answered = answeredBy(answer);
  // Handed to the Function for Next.js to render itself, where the middleware changed the `HEAD`
  // so that a route's `bypassFor` holds for it, as it may the `GET` (`bypassedVerdict`).
  const bypassed = BYPASSED.test(answered)
    ? bypassedVerdict(stack, decided, sentOf(stack, asked))
    : undefined;
  if (bypassed !== undefined) {
    return bypassed.kind === 'failed' ? bypassed.reason : undefined;
  }
  // Moved elsewhere by the middleware, as it may move a `HEAD` alone: held to where it landed.
  if (decided?.kind === 'continue' && movedAway(stack, asked.route, decided)) {
    return movedHeadFailure(stack, asked, { answer, decided });
  }
  if (!namedRoutes(answered).includes(asked.key) || !answered.startsWith(SHELL_ANSWER)) {
    return `not answered from the shell of its own route (${EDGE_HEADER}: ${answered})`;
  }
  const pathname = decided?.kind === 'continue' ? decided.url.pathname : read.url.pathname;
  // Whole: the edge answers a `HEAD` itself only of a document complete in itself.
  const application = applicationOf(stack, asked, decided, 'whole');
  return (
    heldPolicyFailure(stack, answer, answered) ??
    (await wholeHeadFailure(stack, asked.route, pathname, answer)) ??
    (await servedFailure(
      stack,
      { route: asked.route, pathname },
      { answer, application, head: true },
    ))
  );
}

/**
 * Why a `HEAD` the middleware moved off the route asked for — rewrote, or routed again by the
 * headers it left it with — is not answered as the edge answers one where it landed (`landingOf`):
 * from storage, as the file of the build a rewrite onto one names, its headers alone; from the shell
 * of a route the build finished, held to that route as the `GET` would be (`servedFailure`); and
 * handed on to the Function otherwise — a route a resume completes, or none of the build's — as the
 * edge hands those on (`headToApplication`), which is the application's to answer.
 */
async function movedHeadFailure(
  stack: CheckedStack,
  asked: Asked,
  read: {
    readonly answer: Reading;
    readonly decided: Extract<MiddlewareResult, { kind: 'continue' }>;
  },
): Promise<string | undefined> {
  const { answer, decided } = read;
  const answered = answeredBy(answer);
  const onto = rewriteOf(decided);
  if (answered.startsWith(FROM_STORAGE)) {
    const file = onto === undefined ? undefined : staticFileKey(stack.manifest, onto.pathname);
    if (file === undefined) {
      return `answered as a file, though the application's middleware rewrote it onto none of the build's (${EDGE_HEADER}: ${answered})`;
    }
    const url = new URL(asked.requested, stack.site);
    const verdict = rewrittenOnto(stack, file, {
      url,
      headers: asked.headers,
      answer,
      middleware: decided,
      head: true,
    });
    return verdict.kind === 'failed' ? verdict.reason : undefined;
  }
  const landed = landingOf(stack, decided.url, decided);
  const { done } = moveOf(decided);
  if (!answered.startsWith(SHELL_ANSWER)) {
    return headLandingHandoffFailure(stack, landed, {
      pathname: decided.url.pathname,
      answered,
      done,
    });
  }
  const route = servedAs(stack.manifest, answered, landed);
  if (landed === undefined || route?.pathname !== landed.pathname) {
    return `${done} ${whereLanded(landed)}, and answered from the shell of ${whereLanded(route)} (${EDGE_HEADER}: ${answered})`;
  }
  const policy = heldPolicyFailure(stack, answer, answered);
  if (policy !== undefined) {
    return policy;
  }
  const application = applicationOf(stack, asked, decided, 'whole');
  const served = { route: landed, pathname: decided.url.pathname };
  const failure =
    (await wholeHeadFailure(stack, landed, decided.url.pathname, answer)) ??
    (await servedFailure(stack, served, { answer, application, head: true }));
  return failure === undefined ? undefined : `${done} the route ${landed.pathname}, and ${failure}`;
}

/** What the check read of a document answered as another route than the one asked for. */
interface Swapped {
  readonly answer: Reading;
  readonly decided: MiddlewareResult | undefined;
  readonly application: Application;
  readonly coding: Accepted | undefined;
  readonly agent: string | undefined;
}

/**
 * A document answered as another route where the application's middleware rewrote nothing: the
 * edge's doing — but where the headers the middleware changed, which the edge routes the request
 * again by (`hostedEntry`), lead it to the route it was answered as. That is the middleware's to
 * choose, so skipped where the document is that route's.
 */
async function rerouted(stack: CheckedStack, read: Swapped): Promise<Verdict> {
  const { answer, decided, application } = read;
  const answered = answeredBy(answer);
  const landed = decided?.kind === 'continue' ? landingOf(stack, decided.url, decided) : undefined;
  const route = servedAs(stack.manifest, answered, landed);
  if (route === undefined || decided?.kind !== 'continue' || landed?.pathname !== route.pathname) {
    return failed(
      `served from another route, where the application's middleware rewrote nothing (${EDGE_HEADER}: ${answered})`,
    );
  }
  const { did, done } = moveOf(decided);
  const served = { route, pathname: decided.url.pathname };
  const failure = await servedFailure(stack, served, { answer, application, ...codedOf(read) });
  return failure === undefined
    ? skipped(`the application's middleware ${did} the route ${route.pathname}`)
    : failed(`${done} the route ${route.pathname}, and ${failure}`);
}

/**
 * A document the application's middleware rewrote onto another route of the build, or onto a file:
 * the middleware's to choose, so skipped — where it is that route's document, or that file. Only
 * where the middleware says it rewrote the request, or changed the headers it is routed by
 * (`rerouted`): one it let through as it came, answered as another route, is the edge's doing.
 */
async function rewritten(stack: CheckedStack, asked: Asked, read: Swapped): Promise<Verdict> {
  const { answer, decided, application } = read;
  const answered = answeredBy(answer);
  const onto = rewriteOf(decided);
  if (onto === undefined) {
    return rerouted(stack, read);
  }
  if (answered.startsWith(FROM_STORAGE)) {
    // Served as the file of the build the rewrite lands on (`staticFileKey`), or as none.
    const file = staticFileKey(stack.manifest, onto.pathname);
    return file === undefined
      ? failed(
          `answered as a file, though the rewrite to ${onto.pathname} names none of the build's`,
        )
      : rewrittenOnto(stack, file, {
          url: new URL(asked.requested, stack.site),
          headers: asked.headers,
          answer,
          middleware: decided,
        });
  }
  // The route the rewrite lands on, as the edge finds it: a pathname of the build's, or a class's
  // member. Another route composed in its place is the edge's doing, however sound its shell.
  const landed = decided === undefined ? undefined : landingOf(stack, onto, decided);
  const route = servedAs(stack.manifest, answered, landed);
  if (route === undefined) {
    return failed(`not answered as a route of the build (${EDGE_HEADER}: ${answered})`);
  }
  if (landed?.pathname !== route.pathname) {
    return failed(
      `rewritten to ${onto.pathname}, which is ${whereLanded(landed)}, and served as the route ${route.pathname}`,
    );
  }
  const served = { route, pathname: onto.pathname };
  const failure = await servedFailure(stack, served, { answer, application, ...codedOf(read) });
  return failure === undefined
    ? skipped(
        `the application's middleware rewrote it to ${onto.pathname}, the route ${route.pathname}`,
      )
    : failed(`rewritten to ${onto.pathname}, the route ${route.pathname}, and ${failure}`);
}

/** A seeded or derivable completion entry; its trace must still name the record regenerated. */
function canRegenerate(route: RouteEntry | undefined): route is RouteEntry {
  return route !== undefined && (route.cache !== undefined || route.partialFallback !== undefined);
}

/**
 * A page the edge regenerated in the foreground — the Function's render, which says nothing of the
 * route it is — judged as the route whose record the edge had the Function regenerate (`keptOf`):
 * the one the edge finds for the request as the middleware left it (`landingOf`) where it moved
 * the request, which is the middleware's to choose and skipped; otherwise the route asked for,
 * whose record is the one the edge regenerates — and fails where it has none, which the edge
 * regenerates nothing of.
 */
async function regeneratedVerdict(
  stack: CheckedStack,
  asked: Asked,
  read: { readonly kept: () => Promise<Kept>; readonly answer: Reading },
): Promise<Verdict> {
  const url = new URL(asked.requested, stack.site);
  const kept = await read.kept();
  const { decided, regenerated } = kept;
  const captured = withGenerationEvidence(stack, kept);
  // Which says nothing of the middleware where it did not run: the edge regenerates a page only
  // behind it, so one the build's matchers cover is regenerated with a decision kept, or not at all.
  const covered = middlewareCovers(stack, url, asked.headers);
  const unkept =
    keptFailure(read.answer, decided) ?? unrunFailure(decided, covered, 'regenerated it');
  if (unkept !== undefined) {
    return failed(unkept);
  }
  // Under the stack's policy, as anything the edge answers in front of its Function — asked once
  // what was kept of the middleware is, which a policy's failure would say nothing of.
  const policy = heldPolicyFailure(stack, read.answer, answeredBy(read.answer));
  if (policy !== undefined) {
    return failed(policy);
  }
  // What a document carries of what its rules and its middleware set: the render, as the shell —
  // by the rules as a Function lays them, which the edge appends no recovery script to.
  const application = applicationOf(stack, asked, decided, 'handed-on');
  const laid = regeneratedLaidFailure(read.answer, application.laid({}));
  const landed =
    decided?.kind === 'continue' ? landingOf(stack, decided.url, decided) : asked.route;
  // The pathname the edge served the route at: where the middleware left the request.
  const pathname = decided?.kind === 'continue' ? decided.url.pathname : url.pathname;
  if (rewriteOf(decided) === undefined && landed?.pathname === asked.route.pathname) {
    return failed(
      canRegenerate(asked.route)
        ? ((await regenerationFailure(captured, asked.route, { regenerated, pathname })) ??
            regeneratedFailure(asked.route, read.answer, asked.coding) ??
            laid)
        : 'regenerated in the foreground, though the route has no record to regenerate',
    );
  }
  const { did, done } = moveOf(decided);
  if (!canRegenerate(landed)) {
    return failed(`${done} ${whereLanded(landed)}, which has no record, and regenerated`);
  }
  const failure =
    (await regenerationFailure(captured, landed, { regenerated, pathname })) ??
    regeneratedFailure(landed, read.answer, asked.coding) ??
    laid;
  return failure === undefined
    ? skipped(`the application's middleware ${did} the route ${landed.pathname}, regenerated`)
    : failed(`${done} the route ${landed.pathname}, and ${failure}`);
}

/**
 * Why an answer the edge gave from what the deployment holds — a shell, a file — or regenerated in
 * front of it does not say it did so under the stack's policy, as validation holds a candidate's
 * (`policyFailure`). None for any other answer, which names no policy.
 */
function heldPolicyFailure(
  stack: CheckedStack,
  answer: Reading,
  answered: string,
): string | undefined {
  const held =
    REGENERATED.test(answered) ||
    answered.startsWith(SHELL_ANSWER) ||
    answered.startsWith(FROM_STORAGE);
  return held ? policyFailure(stack, answer) : undefined;
}

/** A route, asked for as validation asks for it, and judged. */
export async function routeVerdict(
  stack: CheckedStack,
  headBytes: number,
  asked: Asked,
): Promise<Verdict> {
  const url = new URL(asked.requested, stack.site);
  await using tracing = await traced(stack, asked.headers);
  const { headers, trace } = tracing;
  const request = { ...asked, headersOnly: middlewareHeadersOnly };
  const answer = await readDocument(stack, headBytes, request, headers);
  if (typeof answer === 'string') {
    return failed(answer);
  }
  asked.answered?.(answer);
  // What was kept of the request, read once — the stack lets it go then — and only where needed:
  // where not, let go of unread once the route is judged (`Traced`).
  const record: { read?: Promise<Kept> } = {};
  const kept = (): Promise<Kept> => (record.read ??= keptOf(stack, trace, url, asked.headers));
  return await documentVerdict(stack, asked, { answer, kept });
}

/** A document judged against its own response and captured evidence, without repeating its GET. */
export async function documentVerdict(
  stack: CheckedStack,
  asked: Asked,
  read: { readonly answer: Reading; readonly kept: () => Promise<Kept> },
): Promise<Verdict> {
  const { answer, kept } = read;
  const url = new URL(asked.requested, stack.site);
  const middleware = middlewareAnswered(answer);
  if (middleware !== undefined) {
    return skipped(middleware);
  }
  const answered = answeredBy(answer);
  // A page regenerated in the foreground is the Function's render, not the build's shell: judged
  // first for what was kept of the middleware, then for its policy (`regeneratedVerdict`).
  if (REGENERATED.test(answered)) {
    return await regeneratedVerdict(stack, asked, { kept, answer });
  }
  const policy = heldPolicyFailure(stack, answer, answered);
  if (policy !== undefined) {
    return failed(policy);
  }
  // Said of a page handed on whether the middleware ran or not: what was kept of it says, where it
  // agrees with what the edge says (`keptFailure`).
  const sent = sentOf(stack, asked);
  if (DOCUMENT_HANDOFFS.test(answered)) {
    const { decided } = await kept();
    const handed = documentHandedOnVerdict(stack, sent, { answer, answered, decided });
    if (handed !== undefined) {
      return handed;
    }
  }
  // A file of the build the middleware rewrote the request onto is the one other answer it may be.
  const ontoFile = answered.startsWith(FROM_STORAGE) && middlewareRan(answer);
  if (!ontoFile && !answered.startsWith(SHELL_ANSWER)) {
    return failed(`not answered by the edge from its shell (${EDGE_HEADER}: ${answered})`);
  }
  // What the middleware decided, as the edge ran it: whether it rewrote the request, and what it set
  // on the answer — read whether or not the edge says it ran, which is what is checked.
  const evidence = await kept();
  const { decided } = evidence;
  const captured = withGenerationEvidence(stack, evidence);
  const unkept =
    keptFailure(answer, decided, middlewareCovers(stack, url, asked.headers)) ??
    shellBypassFailure(stack, sent, decided);
  if (unkept !== undefined) {
    return failed(unkept);
  }
  return await composedVerdict(captured, asked, { answer, url, decided });
}

/**
 * A document the edge composed, judged as the route it says it composed it as: the route asked for,
 * held to its shell — and, where the build finished it, to its headers alone (`headFailure`) — or
 * another, which only a rewrite of the middleware's may have led it to (`rewritten`).
 */
async function composedVerdict(
  stack: CheckedStack,
  asked: Asked,
  read: {
    readonly answer: Reading;
    readonly url: URL;
    readonly decided: MiddlewareResult | undefined;
  },
): Promise<Verdict> {
  const { answer, decided } = read;
  const answered = answeredBy(answer);
  const whole = servedWhole(answered);
  const application = applicationOf(stack, asked, decided, whole ? 'whole' : 'resumed');
  // The route the edge composed the document as, which for a member of a class is the class: one
  // that landed on another route would be compared with the wrong shell, and could pass.
  if (namedRoutes(answered).includes(asked.key)) {
    const pathname = decided?.kind === 'continue' ? decided.url.pathname : read.url.pathname;
    const served = { route: asked.route, pathname };
    // Its headers alone, as the edge composed the document — whole, or for a resume to complete —
    // asked of the document as it is, not again of each coding of it.
    return failed(
      movedFailure(stack, asked.route, decided) ??
        (await servedFailure(stack, served, { answer, application, ...codedOf(asked) })) ??
        (asked.coding === undefined ? await headFailure(stack, asked) : undefined),
    );
  }
  return middlewareRan(answer)
    ? rewritten(stack, asked, { answer, decided, application, ...codedOf(asked) })
    : failed(`served from another route (${EDGE_HEADER}: ${answered})`);
}
