import { pageOfPagesData } from '@stayingupwind/core/bundle';
import {
  findRouteEntry,
  isExactPathname,
  matchDynamicRoute,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import { RSC_CACHE_BUSTING_QUERY } from '@stayingupwind/core/request';

import {
  answerTo,
  type CheckedStack,
  edgeReads,
  keptOf,
  middlewareAnswered,
  middlewareCovers,
  traced,
  undoneUnlessStored,
} from './answers.ts';
import { BROWSER_CODINGS } from './codings.ts';
import {
  cookieFor,
  type CookieJar,
  jarKeyOf,
  jarOf,
  keptWith,
  NO_COOKIE_CHANGES,
  unprovedHolding,
} from './cookie-jar.ts';
import { carriedScopesOf, type Scoped, scopesOf } from './cookie-scopes.ts';
import { claimedBy, escaping } from './escaping.ts';
import type { Part, PartKind } from './part-marks.ts';
import {
  ACCEPT_ENCODING,
  partAnswerVerdict,
  partFailure,
  propsHeadVerdict,
} from './part-verdicts.ts';
import type { Reading } from './reading.ts';
import {
  type Answered,
  answeredOf,
  askKey,
  COOKIE,
  cookieOn,
  redirectsFrom,
  type Sent,
  type Step,
  stepsApplied,
} from './redirects.ts';
import { stateTreeUnproved } from './router-state.ts';

/**
 * A page's parts asked for as a browser's router asks for them, one after another (`partsFailure`):
 * each with the cookies the browser holds of its navigation, of the answer to the page's document,
 * and of the answers to the parts it asked for before (`cookie-jar.ts`) — in each way a browser may
 * ask: its navigation's cookies kept at the site's root path or at the page's own, and saying the
 * page it asks from or not. Each part is judged as well where a redirect leads its browser's fetch
 * (`landedPartFailure`), and as a browser asks it that holds what a rule claims it without
 * (`escapedMoves`), the jars that leaves the browser holding followed too.
 */

export const REFERER = 'referer';

/**
 * What a browser's router says of the page it asks from (`Referer`), as the page's
 * `Referrer-Policy` has it say of a request of its own site: the page's URL, as most do; its origin
 * alone (`origin`, `strict-origin`); or nothing (`no-referrer`).
 */
type Referred = 'page' | 'origin' | 'none';

/** A way a browser's router asks for a page's parts. */
interface Flow {
  /** The cookies the browser holds once the page's document was answered. */
  readonly jar: CookieJar;
  /** What its requests say of the page they are asked from (`Referer`). */
  readonly referred: Referred;
  /** How it asks, in a verdict's words: by whom, kept how, with no referrer. */
  readonly as: string;
}

/**
 * What the answer to each request asked in any flow did (`Answered`), by the request: what a flow
 * that asks the same request again takes of it, asking it no more — kept apart for a part asked and
 * judged (`judged`), and a redirect a fetch followed, read for its headers alone (`followed`),
 * which judges nothing of a part asked by the same request.
 */
export interface AnsweredAsks {
  readonly judged: Map<string, Answered>;
  readonly followed: Map<string, Answered>;
}

/**
 * `headers` saying of the page they were asked from (`Referer`) what `referred` has them say: as
 * they are, its origin alone, or nothing.
 */
function referredAs(
  headers: Readonly<Record<string, string>>,
  referred: Referred,
): Readonly<Record<string, string>> {
  const said = headers[REFERER];
  if (referred === 'page' || said === undefined) {
    return headers;
  }
  const others = Object.entries(headers).filter(([name]) => name !== REFERER);
  return referred === 'none'
    ? Object.fromEntries(others)
    : { ...Object.fromEntries(others), [REFERER]: `${new URL(said).origin}/` };
}

/** A jar a browser may hold as its router asks for a page's parts, and how, in a verdict's words. */
export interface Held {
  readonly jar: CookieJar;
  readonly as: string;
}

/** The jar a browser holds once its navigation of `page` sent `sent`, kept as `way` keeps them. */
function seedOf(page: URL, sent: string | undefined, way: Scoped): Held {
  return { jar: jarOf(sent, { document: page, scopes: way.scopes }), as: way.as };
}

/**
 * The jars a browser holds once its navigation of `page` was asked with `sent`: its cookies kept in
 * each scope a browser may keep them in (`scopesOf`) — or in `scoped` alone, where the navigation is
 * followed in that one — or why the check proves none, where they are more than it follows.
 */
export function seedsOf(navigated: {
  readonly page: URL;
  readonly sent: string | undefined;
  readonly scoped?: Scoped | undefined;
}): { readonly seeds: readonly Held[]; readonly unproved?: string } {
  const { page, sent, scoped } = navigated;
  const { ways, unproved } = scoped === undefined ? scopesOf(page, sent) : { ways: [scoped] };
  if (unproved !== undefined) {
    return { seeds: [], unproved };
  }
  const seeds = ways.map((way) => seedOf(page, sent, way));
  // None the check would not follow a browser holding.
  const held = seeds.map(({ jar }) => unprovedHolding(jar)).find((each) => each !== undefined);
  return held === undefined ? { seeds } : { seeds: [], unproved: `its navigation, ${held}` };
}

/**
 * The flows a browser's router asks for a page's parts in, holding each of `held` — but once where
 * two hold alike — each saying the page it asks from, its origin alone, and nothing, as a page the
 * router runs on says under its `Referrer-Policy` (`Referred`), which no answer the check reads says
 * of the page it is on. A flow that asks what another asked asks none of it again (`AnsweredAsks`).
 */
export function flowsOf(held: readonly Held[]): readonly Flow[] {
  const seen = new Set<string>();
  const kept = held.filter(({ jar }) => {
    const key = jarKeyOf(jar);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return kept.flatMap((flow) => {
    return [
      { ...flow, referred: 'page' as const },
      {
        ...flow,
        referred: 'origin' as const,
        as: `${flow.as}, with its origin alone as the referrer`,
      },
      { ...flow, referred: 'none' as const, as: `${flow.as}, with no referrer` },
    ];
  });
}

/** A jar a flow's browser may hold, and how it came to, in a verdict's words. */
interface State {
  readonly jar: CookieJar;
  /** Whose answers set its cookies, in the order the browser asked for them: none but the page's. */
  readonly by: string;
}

/** A part of a page's, asked for in a flow with the cookies of one of the jars its browser holds. */
interface Asking {
  readonly part: Part;
  readonly flow: Flow;
  readonly state: State;
}

/**
 * What the answer to `part`, asked as it is, did that a browser's fetch goes on from (`Answered`) —
 * its answer in what the browser accepts at once (`Part.answered`) — or why it is not answered as
 * the edge answers it (`partFailure`), or why no request proves it (`Part.unproved`), in a verdict's
 * words. One asked and judged before, in this flow or another, is not asked again
 * (`AnsweredAsks.judged`).
 */
async function judgedAnswer(
  stack: CheckedStack,
  part: Part,
  answered: AnsweredAsks,
): Promise<Answered | string> {
  // Every flow and redirect supplies its own cookies and URL before a known answer is reused.
  const unproved = part.unproved ?? stateTreeUnproved(stack, part.url, part.headers);
  if (unproved !== undefined) {
    return `${part.what}, ${unproved}`;
  }
  const key = askKey(part.url, part.headers);
  const known = answered.judged.get(key);
  if (known !== undefined) {
    return known;
  }
  let got: Reading | undefined;
  const failure = await partFailure(stack, {
    ...part,
    answered: (answer) => {
      got = answer;
    },
  });
  if (failure !== undefined) {
    return `${part.what}, ${failure}`;
  }
  const own =
    got === undefined ? { changes: NO_COOKIE_CHANGES, account: '', page: false } : answeredOf(got);
  answered.judged.set(key, own);
  return own;
}

/**
 * The route of the build a router's request at `sent` asks a part of, as the edge finds it
 * (`classifyRequest`): props by their URL (`pageOfPagesData`), where the page has props; a segment
 * or the whole payload by the page's pathname — or, but for one Next.js resolves exactly, a class's
 * member — and whether that is the route's own.
 */
function routeAskedAt(
  stack: CheckedStack,
  kind: PartKind,
  sent: Sent,
): { readonly route: RouteEntry; readonly exact: boolean } | undefined {
  const { manifest } = stack;
  const { pathname } = sent.url;
  if (kind === 'data') {
    const prefix = manifest.pagesDataPrefix;
    const basePath = manifest.pagesDataBasePath ?? '';
    const trailingSlash = manifest.trailingSlash === true;
    const page =
      prefix === undefined ? undefined : pageOfPagesData(prefix, basePath, pathname, trailingSlash);
    const route =
      page !== undefined && Object.hasOwn(manifest.routes, page)
        ? manifest.routes[page]
        : undefined;
    return route?.pagesData === undefined ? undefined : { route, exact: true };
  }
  const own = findRouteEntry(manifest, pathname);
  if (own !== undefined) {
    return { route: own, exact: true };
  }
  const member = isExactPathname(manifest, pathname)
    ? undefined
    : matchDynamicRoute(manifest, sent.url, edgeReads(sent.headers));
  return member === undefined ? undefined : { route: member, exact: false };
}

/** A part at the URL a browser fetch actually reached, with that request's headers. */
function partLandedAt(stack: CheckedStack, part: Part, sent: Sent): Part | undefined {
  const at = routeAskedAt(stack, part.kind, sent);
  return at === undefined
    ? undefined
    : {
        ...part,
        what: `${part.what}, redirected to ${sent.url.pathname}`,
        url: sent.url,
        headers: sent.headers,
        route: at.route,
        built: part.builtOn(at.route),
        exact: at.exact,
      };
}

/** Read a real redirect hop, retaining its own facts until the router adopts the final response. */
async function partHopAnswer(
  stack: CheckedStack,
  part: Part,
  sent: Sent,
): Promise<Answered | string | undefined> {
  const landed = partLandedAt(stack, part, sent);
  if (landed === undefined) {
    return undefined;
  }
  await using tracing = await traced(stack, sent.headers);
  const from = Date.now();
  const answer = await answerTo(sent.url, {
    via: stack.url,
    headers: tracing.headers,
    decode: undoneUnlessStored(true),
  });
  if (typeof answer === 'string') {
    return answer;
  }
  const within = { from, to: Date.now() };
  const own = answeredOf(answer);
  if (middlewareAnswered(answer) !== undefined) {
    return own;
  }
  const { decided } = await keptOf(stack, tracing.trace, sent.url, sent.headers);
  const covered = middlewareCovers(stack, sent.url, sent.headers);
  return {
    ...own,
    partFailure: async () => {
      const verdict = await partAnswerVerdict(stack, landed, {
        answer,
        decided,
        covered,
        coding: part.browserCodings ?? BROWSER_CODINGS,
        asked: sent.headers,
        within,
      });
      return verdict.kind === 'failed' ? `${landed.what}, ${verdict.reason}` : undefined;
    },
  };
}

/**
 * Why what a part's redirects lead its browser's fetch to — the answer it hands the page's router
 * as the part (`Followed.landed`) — is not answered as the edge answers that part of the page it is
 * at (`routeAskedAt`), first judged by the response the fetch actually adopted, then asked as the
 * fetch asked it last in each coding (`judgedAnswer`). None where it is at no page of the build's,
 * which the edge answers no part of.
 */
async function landedPartFailure(
  stack: CheckedStack,
  part: Part,
  landing: {
    readonly landed: Sent;
    /** What the request the fetch landed on was answered with as it followed. */
    readonly last: Answered | undefined;
    readonly answered: AnsweredAsks;
  },
): Promise<string | undefined> {
  const original = await landing.last?.partFailure?.();
  if (original !== undefined) {
    return original;
  }
  const { landed } = landing;
  const coding = part.headers[ACCEPT_ENCODING];
  const headers =
    coding === undefined ? landed.headers : { ...landed.headers, [ACCEPT_ENCODING]: coding };
  const asLanded = partLandedAt(stack, part, { ...landed, headers });
  if (asLanded === undefined) {
    return undefined;
  }
  const judged = await judgedAnswer(stack, asLanded, landing.answered);
  return typeof judged === 'string' ? judged : undefined;
}

/**
 * A jar a part's answer leaves a flow's browser holding (`flowFailure`): from the jar it held as it
 * asked — the state's, or that with what it carried past a rule besides (`escapedMoves`) — once its
 * answer, and each redirect its fetch followed, did what it did to the cookies, in order; and how it
 * asked, in a verdict's words, where otherwise than as the part is asked.
 */
interface Move {
  readonly held: CookieJar;
  readonly steps: readonly Step[];
  readonly as: string;
}

/**
 * Where the redirects a browser's fetch follows from `own`, the answer to `part` asked with the
 * cookies of `held`, lead — asked in what the browser accepts at once, and, for a router's request,
 * asked again as Next.js's router asks it (`redirectsFrom`) — judged as the part it is there
 * (`landedPartFailure`); and what its answer, and each of those redirects, did to the cookies the
 * browser keeps. Why the check proves nothing past them, in a verdict's words, where it does not.
 */
async function followedFailure(
  stack: CheckedStack,
  from: { readonly part: Part; readonly own: Answered; readonly held: CookieJar },
  answered: AnsweredAsks,
): Promise<{ readonly failure?: string; readonly steps: readonly Step[] }> {
  const { part, own, held } = from;
  // A router's request asked again where Next.js's router asks it again (`createFetch`) — not a
  // page's props, which the Pages Router fetches as it is.
  const followedAs = { ...part.headers, [ACCEPT_ENCODING]: part.browserCodings ?? BROWSER_CODINGS };
  // Next appends the computed hash last, retaining earlier bare or encoded `_rsc` keys.
  const replay =
    part.kind === 'data'
      ? undefined
      : (part.url.searchParams.getAll(RSC_CACHE_BUSTING_QUERY).at(-1) ?? '');
  // Read whole, retaining each response's own generation facts; only the final adopted response
  // is judged as the landing, never by requiring a later request to repeat its bytes.
  const followed = await redirectsFrom(
    stack,
    {
      answered: own,
      url: part.url,
      headers: followedAs,
      jar: held,
      replay,
      whole: true,
      partAnswer: (sent) => partHopAnswer(stack, part, sent),
    },
    answered.followed,
  );
  if (followed.failure !== undefined) {
    return { failure: `${part.what}, ${followed.failure}`, steps: [] };
  }
  const landed =
    followed.landed === undefined
      ? undefined
      : await landedPartFailure(stack, part, {
          landed: followed.landed,
          last: followed.last,
          answered,
        });
  if (landed !== undefined) {
    return { failure: landed, steps: [] };
  }
  return { steps: [{ url: part.url, changes: own.changes }, ...followed.steps] };
}

/**
 * The jars `part`, asked with the cookies of `held`, leaves a browser holding that holds what a rule
 * of `next.config` claims it without (`escaping`) — a cookie kept for the part's URL alone, say,
 * which its page's navigation never sent: carrying it, judged as the edge answers it
 * (`judgedAnswer`) and where its redirects lead (`followedFailure`), from the jar with each cookie it
 * carries kept in each scope that sends it there (`carriedScopesOf`). None where no rule claims it,
 * or one claims it for what it has; why it is not answered as the edge answers it, or why no request
 * proves it — where only a value the check finds none of would pass the rule over — in a verdict's
 * words.
 */
async function escapedMoves(
  stack: CheckedStack,
  from: { readonly part: Part; readonly held: CookieJar },
  answered: AnsweredAsks,
): Promise<{ readonly failure?: string; readonly moves: readonly Move[] }> {
  const { part, held } = from;
  const target = {
    manifest: stack.manifest,
    url: part.url,
    prover: part.headers['user-agent'] ?? '',
    exact: part.exact,
  };
  if (!claimedBy(target, part.headers, () => true)) {
    return { moves: [] };
  }
  const escape = escaping(target, part.headers, () => true);
  if (escape.kind === 'unproved') {
    return { failure: `${part.what}, ${escape.reason}`, moves: [] };
  }
  if (escape.kind === 'claimed') {
    return { moves: [] };
  }
  const carrying = {
    ...part,
    what: `${part.what}, carrying ${escape.carried}`,
    url: escape.url,
    headers: escape.headers,
  };
  const own = await judgedAnswer(stack, carrying, answered);
  if (typeof own === 'string') {
    return { failure: own, moves: [] };
  }
  const { ways, unproved } = carriedScopesOf(escape.url, escape.cookies);
  if (unproved !== undefined) {
    return { failure: `${carrying.what}, ${unproved}`, moves: [] };
  }
  const moves: Move[] = [];
  for (const { scopes, as } of ways) {
    const kept = jarOf(escape.cookies, { document: escape.url, scopes });
    const holding = keptWith(held, kept);
    const unfollowed = unprovedHolding(holding);
    if (unfollowed !== undefined) {
      return { failure: `${carrying.what}${as}, ${unfollowed}`, moves: [] };
    }
    const followed = await followedWithHead(
      stack,
      { part: carrying, own, held: holding },
      answered,
    );
    if (followed.failure !== undefined) {
      return { failure: followed.failure, moves: [] };
    }
    moves.push({ held: holding, steps: followed.steps, as: `, carrying ${escape.carried}${as}` });
  }
  return { moves };
}

/** What a link's prefetch of a page's props says of the request (`fetchNextData`'s `isPrefetch`). */
const PURPOSE = 'purpose';

/**
 * What the answer to a navigation's request for a page's props asked again for their headers alone
 * did (`propsHeadVerdict`) — as the Pages Router asks once it has them, signalling a revalidation
 * (`fetchNextData`'s background `HEAD`), in what the browser accepts at once — or why it is not
 * answered as the edge answers it; none of another part, or of a prefetch, which no `HEAD` follows.
 * One asked before is not asked again (`AnsweredAsks.judged`).
 */
async function backgroundHeadOf(
  stack: CheckedStack,
  part: Part,
  after: { readonly jar: CookieJar; readonly answered: AnsweredAsks },
): Promise<string | { readonly steps: readonly Step[] } | undefined> {
  const { answered } = after;
  if (part.kind !== 'data' || Object.hasOwn(part.headers, PURPOSE)) {
    return undefined;
  }
  // With the cookies the browser holds once its request for them, and their redirects, answered.
  const uncookied = Object.fromEntries(
    Object.entries(part.headers).filter(([name]) => name.toLowerCase() !== COOKIE),
  );
  const coded = { ...uncookied, [ACCEPT_ENCODING]: part.browserCodings ?? BROWSER_CODINGS };
  const headed = { ...part, headers: cookieOn(coded, cookieFor(after.jar, part.url)) };
  const what = `${part.what}, asked again for its headers alone as the Pages Router signals a revalidation`;
  const own = await headJudged(stack, headed, answered);
  if (typeof own === 'string') {
    return `${what}, ${own}`;
  }
  // Where a redirect leads it, followed as a fetch follows a `HEAD` — as one — and the props it
  // lands on held to the same.
  const from = { answered: own, url: headed.url, headers: headed.headers, jar: after.jar };
  const followed = await redirectsFrom(stack, { ...from, method: 'HEAD' }, answered.followed);
  if (followed.failure !== undefined) {
    return `${what}, ${followed.failure}`;
  }
  const { landed } = followed;
  const at = landed === undefined ? undefined : routeAskedAt(stack, 'data', landed);
  if (landed !== undefined && at !== undefined) {
    const route = { route: at.route, built: part.builtOn(at.route), exact: at.exact };
    const lands = await headJudged(stack, { ...headed, ...landed, ...route }, answered);
    if (typeof lands === 'string') {
      return `${what}, redirected to ${landed.url.pathname}, ${lands}`;
    }
  }
  return { steps: [{ url: part.url, changes: own.changes }, ...followed.steps] };
}

/** A GET and its redirects, then the Pages Router's background HEAD with their resulting cookies. */
async function followedWithHead(
  stack: CheckedStack,
  from: { readonly part: Part; readonly own: Answered; readonly held: CookieJar },
  answered: AnsweredAsks,
): Promise<{ readonly failure?: string; readonly steps: readonly Step[] }> {
  const followed = await followedFailure(stack, from, answered);
  if (followed.failure !== undefined) {
    return followed;
  }
  const afterGet = stepsApplied(from.held, followed.steps);
  if (afterGet.unproved !== undefined) {
    return { failure: `${from.part.what}, ${afterGet.unproved}`, steps: [] };
  }
  const head = await backgroundHeadOf(stack, from.part, { jar: afterGet.jar, answered });
  return typeof head === 'string'
    ? { failure: head, steps: [] }
    : { steps: [...followed.steps, ...(head?.steps ?? [])] };
}

/**
 * What the answer to `part`, asked for its headers alone, did that a fetch goes on from — or why it
 * is not answered as the edge answers one (`propsHeadVerdict`). One asked before is not asked again.
 */
async function headJudged(
  stack: CheckedStack,
  part: Part,
  answered: AnsweredAsks,
): Promise<Answered | string> {
  const key = `HEAD ${askKey(part.url, part.headers)}`;
  const known = answered.judged.get(key);
  if (known !== undefined) {
    return known;
  }
  const { verdict, answer } = await propsHeadVerdict(stack, part);
  if (verdict.kind === 'failed') {
    return verdict.reason;
  }
  const own =
    answer === undefined
      ? { changes: NO_COOKIE_CHANGES, account: '', page: false }
      : answeredOf(answer);
  answered.judged.set(key, own);
  return own;
}

/**
 * Why a part asked for as `asking` has it is not answered as the edge answers it, in a verdict's
 * words: as it is asked (`judgedAnswer`), asked again for its headers alone where the Pages Router
 * asks so (`backgroundHeadOf`), where the redirects its browser's fetch follows from its
 * answer lead (`followedFailure`), and as a browser asks it that holds what a rule claims it
 * without (`escapedMoves`) — else the jars each leaves the browser holding (`Move`). A request asked
 * before, in this flow or another, is not asked again, but what its answer did kept (`answered`).
 */
async function askedFailure(
  stack: CheckedStack,
  asking: Asking,
  answered: AnsweredAsks,
): Promise<{ readonly failure?: string; readonly moves: readonly Move[] }> {
  const { part, flow, state } = asking;
  const headers = cookieOn(referredAs(part.headers, flow.referred), cookieFor(state.jar, part.url));
  const asked = { ...part, what: `${part.what}${flow.as}${state.by}`, headers };
  const own = await judgedAnswer(stack, asked, answered);
  if (typeof own === 'string') {
    return { failure: own, moves: [] };
  }
  const followed = await followedWithHead(stack, { part: asked, own, held: state.jar }, answered);
  if (followed.failure !== undefined) {
    return { failure: followed.failure, moves: [] };
  }
  const escaped = await escapedMoves(stack, { part: asked, held: state.jar }, answered);
  if (escaped.failure !== undefined) {
    return { failure: escaped.failure, moves: [] };
  }
  return { moves: [{ held: state.jar, steps: followed.steps, as: '' }, ...escaped.moves] };
}

/** The most jars the check follows a flow's browser into, past which it proves none (`flowFailure`). */
const MAX_JARS = 32;

/**
 * `states` with each jar `moves` leave a browser holding that none of them holds yet (`held`), after
 * `state`, once asking `part` from it — how, in a verdict's words — or why the check proves none of
 * the rest: they are more than it follows (`MAX_JARS`).
 */
function admitted(
  walk: { readonly states: State[]; readonly held: Set<string>; readonly as: string },
  from: { readonly state: State; readonly part: Part },
  moves: readonly Move[],
): string | undefined {
  const { states, held } = walk;
  const { state, part } = from;
  for (const move of moves) {
    const applied = stepsApplied(move.held, move.steps);
    if (applied.unproved !== undefined) {
      return `${part.what}${walk.as}${state.by}${move.as}, ${applied.unproved}`;
    }
    const { jar } = applied;
    const key = jarKeyOf(jar);
    if (held.has(key)) {
      continue;
    }
    // Past as many as it follows, the check proves none of the rest, and says so.
    if (states.length >= MAX_JARS) {
      return `its parts' answers leave a browser${walk.as} holding more than ${MAX_JARS} sets of cookies, more than the check follows: no request proves the others`;
    }
    held.add(key);
    const asked = `${part.what}${move.as}`;
    const by =
      state.by === '' ? `, with the cookies set by ${asked}` : `${state.by}, then ${asked}`;
    states.push({ jar, by });
  }
  return undefined;
}

/**
 * Why one of a page's `parts` is not answered as the edge answers it, asked for as `flow` has a
 * browser's router ask for them in whatever order it does: each part asked with each jar the
 * browser may hold — the one it holds once the page's document was answered, and each its answer to
 * a part asked from one it held leaves it (`Move`) — failing where they are more than `MAX_JARS`,
 * past which the check proves none. The first failure, in a verdict's words.
 */
export async function flowFailure(
  stack: CheckedStack,
  parts: readonly Part[],
  flow: Flow,
  answered: AnsweredAsks,
): Promise<string | undefined> {
  const states: State[] = [{ jar: flow.jar, by: '' }];
  const walk = { states, held: new Set([jarKeyOf(flow.jar)]), as: flow.as };
  // Each jar in the order it was first held in, those its answers leave it added as it goes: an
  // array's iterator reaches what is pushed onto it while it runs.
  for (const state of states) {
    for (const part of parts) {
      const asked = await askedFailure(stack, { part, flow, state }, answered);
      const failure = asked.failure ?? admitted(walk, { state, part }, asked.moves);
      if (failure !== undefined) {
        return failure;
      }
    }
  }
  return undefined;
}
