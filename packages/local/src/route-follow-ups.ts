import { decodesLayeredBrotli } from '@stayingupwind/edge/handlers/layered-clients';

import { answerTo, answeredBy, type CheckedStack } from './answers.ts';
import { BROWSERS } from './browser-samples.ts';
import { CONTEXT_HEADERS, sentBlockingMetadata, visitedNavigations } from './browsers.ts';
import { type Accepted, acceptedInWords, browserCodingsOf } from './codings.ts';
import { type CookieChanges, type CookieJar, jarKeyOf, jarOf, strictly } from './cookie-jar.ts';
import { type Scoped, scopesOf } from './cookie-scopes.ts';
import { documentAnswerAt } from './document-adoption.ts';
import { documentRuleFailure } from './document-rule-witnesses.ts';
import { type Asked, routeVerdict } from './documents.ts';
import { documentRouteAt, exactRouteAt, landedRouteOf, servedOtherThan } from './landings.ts';
import { withheldSets, withheldWords } from './origin-visits.ts';
import { partsFailure, routerAgentOf } from './part-routers.ts';
import { type Navigated, originsOf } from './parts.ts';
import type { Reading } from './reading.ts';
import {
  type Answered,
  askKey,
  COOKIE,
  documentRedirects,
  redirects,
  type Sent,
  type Step,
  stepsApplied,
} from './redirects.ts';

/**
 * A route asked for again once its document, asked for as it is, did not fail — answered as the
 * edge answers it, or taken by the application (`checkStack`): the document in each coding a
 * browser asks one in, read undone of it, and the route's parts as the client router asks for them
 * (`parts.ts`), each judged as it was answered. The first that fails fails the route, as a file's
 * follow-ups fail the file.
 */

/** Where client hints begin, which Chromium browsers alone send. */
const ANY_CLIENT_HINT_PREFIX = 'sec-ch-';

/**
 * `headers` as `navigation` sends them in its place: its own over theirs, and none of the client
 * hints a browser that sends none of its own — Safari's, Firefox's — never sends.
 */
function asNavigatedBy(
  headers: Readonly<Record<string, string>>,
  navigation: Readonly<Record<string, string>>,
): Record<string, string> {
  const hinted = Object.keys(navigation).some((name) => name.startsWith(ANY_CLIENT_HINT_PREFIX));
  const kept = Object.entries(headers).filter(
    ([name]) => hinted || !name.toLowerCase().startsWith(ANY_CLIENT_HINT_PREFIX),
  );
  return { ...Object.fromEntries(kept), ...navigation };
}

/** A navigation's headers but those that say where it came from (`CONTEXT_HEADERS`). */
function placelessOf(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CONTEXT_HEADERS.includes(name.toLowerCase())),
  );
}

/** The codings the edge sends every document it composes in, each asked for alone. */
const CODINGS: readonly Accepted[] = ['br', 'gzip'];

/**
 * The cookies a browser holds as it navigates, where it sends fewer: all of them, as the
 * navigation's `Cookie` would name them, and the places of those it keeps from a navigation another
 * site began (`SameSite=Strict`), which it sends every request of the page's own all the same.
 */
interface Held {
  readonly cookie: string;
  readonly kept: readonly number[];
}

/** A request for a route's document in a coding, as an agent asks it. */
interface CodedAsk {
  readonly coding: Accepted;
  readonly headers: Readonly<Record<string, string>>;
  /** Who asked, in a verdict's words, where not the agent the document was asked as. */
  readonly as?: string;
  /** Where its navigation came from, in a verdict's words (`visitedNavigations`), where that is said. */
  readonly from?: string;
  /** The cookies its browser holds, where it sends fewer (`withheldAsks`). */
  readonly held?: Held | undefined;
  /** Those it kept from the navigation, in a verdict's words (`withheldWords`): none, nothing. */
  readonly withheld?: string | undefined;
  /** Why no request proves it, where none does (`withheldAsks`). */
  readonly unproved?: string | undefined;
}

/** Where a navigation says it came from (Fetch Metadata), and what it says of another site. */
const FETCH_SITE = 'sec-fetch-site';
const CROSS_SITE = 'cross-site';

/**
 * `ask` as a browser makes it: where another site began the navigation, with each set of the
 * cookies it carries kept from it (`SameSite=Strict`), which no header says of any (`withheldSets`)
 * — the browser holding them all the same (`Held`) — and as it is else.
 */
function withheldAsks(ask: CodedAsk): CodedAsk[] {
  const cookie = ask.headers[COOKIE];
  if (cookie === undefined || ask.headers[FETCH_SITE] !== CROSS_SITE) {
    return [ask];
  }
  const pairs = cookie.split(';').map((pair) => pair.trim());
  const { sets, unproved } = withheldSets(pairs.map((_, at) => at));
  if (unproved !== undefined) {
    return [{ ...ask, unproved }];
  }
  return sets.map((kept) => {
    const sent = pairs.filter((_, at) => !kept.includes(at));
    const names = kept.map((at) => pairs[at]?.split('=', 1)[0] ?? '');
    const headers = Object.fromEntries(
      Object.entries(ask.headers).filter(([name]) => name !== COOKIE),
    );
    const withheld = withheldWords(names);
    return {
      ...ask,
      headers: sent.length === 0 ? headers : { ...headers, [COOKIE]: sent.join('; ') },
      as: `${ask.as ?? ''}${withheld}`,
      ...(kept.length > 0 && { held: { cookie, kept }, withheld }),
    };
  });
}

/**
 * The codings a route's document is asked for in: each a browser asks a page in, alone and all at
 * once, as the agent the document was asked as; and as each browser a page is asked as
 * (`BROWSERS`), whole and in every coding it undoes — whatever agent the page itself was asked as:
 * a rule written for one browser's requests passes over the others', and the edge sends Chrome two
 * layers of brotli where it sends the others one — a page a resume completes whose shell the
 * deployment holds in brotli (`decodesLayeredBrotli`): so that a layered answer, a shell's own
 * brotli and the continuation's after it (`document.ts` in the edge), is read as each browser reads
 * it. A request asked twice over is asked once, as the later of the two.
 */
function codedAsks(stack: CheckedStack, asked: Asked): CodedAsk[] {
  // Each alone, and what the browser the page was asked as accepts at once, which the edge answers
  // each its own way (`Accepted`).
  const own = browserCodingsOf(asked.headers['user-agent']);
  const coded: CodedAsk[] = [...CODINGS, own].map((coding) => {
    return {
      coding,
      headers: { ...asked.headers, 'accept-encoding': coding },
    };
  });
  const layered =
    asked.route.cache?.delivery !== 'complete' && asked.route.shellEncodings?.br !== undefined;
  // Each from each place a visitor's navigation comes from, which the page as it was asked says
  // nothing of: a rule or a middleware may tell those apart — from each page of the site's own the
  // check asks the page's parts from (`originsOf`).
  const page = new URL(asked.requested, stack.site);
  const placeless = placelessOf(asked.headers);
  const pages = originsOf(stack, page).map(({ url }) => url);
  const browsers = BROWSERS.flatMap(({ name, navigation }): CodedAsk[] => {
    const agent = navigation['user-agent'];
    const coding = browserCodingsOf(agent);
    const layers = decodesLayeredBrotli(agent ?? null)
      ? ', which the edge layers brotli for'
      : ', which the edge sends one layer of brotli';
    return visitedNavigations(navigation, page, pages).flatMap(({ headers, as: from }) => {
      const withheld = withheldAsks({
        coding,
        headers: { ...asNavigatedBy(placeless, headers), 'accept-encoding': coding },
        as: `by ${name}${from}`,
        from,
      });
      return withheld.map((ask) => ({ ...ask, as: `${ask.as ?? ''}${layered ? layers : ''}` }));
    });
  });
  return onceEach([...coded, ...browsers]);
}

/** `asks`, each request in it once: the later of two alike, which names who asked. */
function onceEach(asks: readonly CodedAsk[]): CodedAsk[] {
  const keyOf = (ask: CodedAsk): string => {
    const headers = Object.entries(ask.headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .toSorted(([a], [b]) => (a < b ? -1 : Number(a > b)));
    return JSON.stringify([ask.coding, headers]);
  };
  const later = new Set<string>();
  const kept: CodedAsk[] = [];
  for (const ask of asks.toReversed()) {
    const key = keyOf(ask);
    if (!later.has(key)) {
      later.add(key);
      kept.push(ask);
    }
  }
  return kept.toReversed();
}

/**
 * A route's document, asked as `headers` — read for its headers alone, and judged no further — or
 * why it could not be read.
 */
async function documentHeadersOn(
  stack: CheckedStack,
  asked: Asked,
  headers: Readonly<Record<string, string>>,
): Promise<Reading | string> {
  const url = new URL(asked.requested, stack.site);
  return answerTo(url, { via: stack.url, headers, headersOnly: true });
}

/**
 * A browser's own navigation of a page, as it was answered: in its agent's words, where another;
 * where it came from, where that is said; and in what it accepts at once.
 */
interface OwnNavigation {
  readonly answer: Reading;
  readonly headers: Readonly<Record<string, string>>;
  readonly as: string | undefined;
  readonly from: string | undefined;
  readonly coding: Accepted;
  /** The cookies its browser holds, where it sent fewer (`withheldAsks`). */
  readonly held?: Held | undefined;
  /** Those it kept from the navigation, in a verdict's words: none, nothing. */
  readonly withheld?: string | undefined;
}

/** A request as asked once of all who ask it, whatever order its headers came in. */
function requestKeyOf(headers: Readonly<Record<string, string>>): string {
  const sorted = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : Number(a > b)));
  return JSON.stringify(sorted);
}

/**
 * Why a route's document asked as `ask` has it is not answered as the edge answers it
 * (`routeVerdict`) — keeping a browser's own navigation, in what its agent accepts at once, as it
 * was answered, by the request, each place it came from apart (`navigations`). Whether a rule claims it, or
 * the route's bypassFor holds, is judged on the request as the middleware leaves it
 * (`routeVerdict`), which may not be the one sent; whether its agent is sent blocking metadata,
 * before the middleware, as the edge judges it (`classifyRequest`) — the Function's to answer, and
 * judged no further, but what a browser keeps of it all the same, which fails where it cannot be
 * read.
 */
async function codedFailure(
  stack: CheckedStack,
  headBytes: number,
  asking: { readonly asked: Asked; readonly ask: CodedAsk },
  navigations: Map<string, OwnNavigation>,
): Promise<string | undefined> {
  const { asked, ask } = asking;
  const { coding, headers, as, from, held, withheld } = ask;
  const agent = headers['user-agent'] ?? '';
  const key = requestKeyOf(headers);
  const own = coding === browserCodingsOf(agent) && !navigations.has(key);
  const how = as === undefined ? acceptedInWords(coding) : `${acceptedInWords(coding)} ${as}`;
  if (ask.unproved !== undefined) {
    return `asked for in ${how}, ${ask.unproved}`;
  }
  if (sentBlockingMetadata(stack.manifest, asked.route, new Headers(headers))) {
    if (!own) {
      return undefined;
    }
    // What the browser keeps of it all the same — failing where it could not be read.
    const answer = await documentHeadersOn(stack, asked, headers);
    if (typeof answer === 'string') {
      return `asked for in ${how}, ${answer}`;
    }
    navigations.set(key, { answer, headers, as, from, coding, held, withheld });
    return undefined;
  }
  const answered = own
    ? (answer: Reading) => {
        navigations.set(key, { answer, headers, as, from, coding, held, withheld });
      }
    : undefined;
  const verdict = await routeVerdict(stack, headBytes, { ...asked, headers, coding, answered });
  return verdict.kind === 'failed' ? `asked for in ${how}, ${verdict.reason}` : undefined;
}

/**
 * Where a browser's navigation that redirected landed: the request it asked for the page with last,
 * the route that asks for (`key`) and the one the edge says it was served as, where another
 * (`served`), and what each answer on the way did to its cookies — from the page it was asked for,
 * which it sent its cookies to, kept in one way a browser may keep them in.
 */
interface Landing {
  readonly navigation: OwnNavigation;
  readonly steps: readonly Step[];
  readonly landed: Sent;
  readonly key: string;
  readonly served?: string | undefined;
  readonly from: URL;
  readonly scoped: Scoped;
  /** Whether what it landed on is a page a client router runs on (`Answered.page`). */
  readonly page: boolean;
  readonly documentFailure?: (() => Promise<string | undefined>) | undefined;
}

/**
 * Why the page a browser's navigation of a route redirected to is not answered as the edge answers
 * it: its document, asked as the browser asked it last (`routeVerdict`), and its parts, as that
 * browser's router on it asks for them, with the cookies each answer on the way set
 * (`partsFailure`) — in a verdict's words, of the route asked for.
 */
async function landedFailure(stack: CheckedStack, landing: Landing): Promise<string | undefined> {
  const { navigation, steps, landed, key } = landing;
  const { url } = landed;
  const route = Object.hasOwn(stack.manifest.routes, key) ? stack.manifest.routes[key] : undefined;
  if (route === undefined) {
    return undefined;
  }
  const requested = `${url.pathname}${url.search}`;
  const exact = exactRouteAt(stack.manifest, url.pathname, key);
  const by = navigation.as === undefined ? '' : ` ${navigation.as}`;
  const asked = { key, route, requested, exact };
  const documentFailure =
    landing.documentFailure === undefined
      ? 'the original redirected document response was not retained'
      : await landing.documentFailure();
  if (documentFailure !== undefined) {
    return `redirected${by} to ${url.pathname}${landing.scoped.as}, ${documentFailure}`;
  }
  // No router asks for the parts of a page it does not run on.
  if (!landing.page) {
    return undefined;
  }
  // With the cookies the navigation was sent with, kept for the page it asked for as they were — and
  // those the browser kept from it, which it sends every request of the page's own.
  const { held } = navigation;
  const failure = await partsFailure(stack, {
    ...asked,
    headers:
      held === undefined ? navigation.headers : { ...navigation.headers, [COOKIE]: held.cookie },
    navigatedBy: new Map([
      [routerAgentOf(navigation.headers), [{ steps, served: landing.served }]],
    ]),
    onlyOwn: true,
    sentTo: landing.from,
    scoped: landing.scoped,
  });
  return failure === undefined ? undefined : `redirected${by} to ${url.pathname}, ${failure}`;
}

/** Where a navigation came from, as a part asked after it says it (`Navigated.as`). */
function navigatedFrom(from: string | undefined): string {
  return from === undefined || from === '' ? '' : `, navigated${from.slice(1)}`;
}

/**
 * The jar a browser holds once its navigation of `page` was sent `sent`, kept as `scoped` keeps
 * them — those it kept from the navigation (`held`) kept from other sites' navigations, as stored.
 */
function sentJar(
  sent: string | undefined,
  at: { readonly page: URL; readonly scoped: Scoped; readonly held: Held | undefined },
): CookieJar {
  const { page, scoped, held } = at;
  const kept = jarOf(sent, { document: page, scopes: scoped.scopes });
  return held === undefined ? kept : strictly(kept, new Set(held.kept));
}

/**
 * Where a browser's navigation of `page` that redirected lands (`Landing`), followed from each way
 * the browser may keep the cookies it was sent with (`scopesOf`) — which decides those each
 * redirect is asked with — but once where two land alike, holding alike (`seen`); or why the check
 * proves nothing past its redirects: one it could not read, more than a browser follows, or more
 * ways of keeping its cookies than it follows.
 */
async function landingsOf(
  stack: CheckedStack,
  headBytes: number,
  from: { readonly page: URL; readonly navigation: OwnNavigation },
  seen: Set<string>,
): Promise<Landing[] | string> {
  const { page, navigation } = from;
  const { answer, headers, held } = navigation;
  const by = navigation.as === undefined ? '' : ` ${navigation.as}`;
  // Every cookie the browser holds, those it kept from the navigation among them.
  const sent = held?.cookie ?? headers[COOKIE];
  const { ways, unproved } = scopesOf(page, sent);
  if (unproved !== undefined) {
    return `its navigation${by}, ${unproved}`;
  }
  // Each redirect asked once, whichever way asks it again.
  const known = new Map<string, Answered>();
  const landings: Landing[] = [];
  for (const scoped of ways) {
    const jar = sentJar(sent, { page, scoped, held });
    const followed = {
      answer,
      url: page,
      headers,
      jar,
      documentAnswer: (request: Sent) =>
        documentAnswerAt(stack, headBytes, request, navigation.coding),
    };
    const redirected = await documentRedirects(stack, followed, known);
    const { steps, landed, failure } = redirected;
    if (failure !== undefined) {
      return `its navigation${by}${scoped.as}, ${failure}`;
    }
    if (landed === undefined) {
      continue;
    }
    const landedPage = redirected.page === true;
    // The route its URL asks for — whatever the edge says of the answer, which may be what fails —
    // else the one the edge says it served it as; and that one beside, where another.
    const named = landedRouteOf(stack.manifest, steps.at(-1)?.account ?? '');
    const key = documentRouteAt(stack.manifest, landed.url, landed.headers) ?? named;
    const served = named === key ? undefined : named;
    const after = stepsApplied(jar, steps);
    if (after.unproved !== undefined) {
      return `its navigation${by}${scoped.as}, ${after.unproved}`;
    }
    const holding = `${askKey(landed.url, landed.headers)}|${jarKeyOf(after.jar)}`;
    if (key !== undefined && !seen.has(holding)) {
      seen.add(holding);
      landings.push({
        navigation,
        steps,
        landed,
        key,
        served,
        from: page,
        scoped,
        page: landedPage,
        documentFailure: redirected.last?.documentFailure,
      });
    }
  }
  return landings;
}

/**
 * What each browser's own navigations of a page came to (`Navigated`), by its agent, one from each
 * place a navigation comes from that stayed on the page — the cookies its answer set, and the route
 * it was served as — and where each that redirected landed (`landingsOf`), which leaves the browser
 * on no page of this route's, and is followed there alone; or why the check proves nothing past
 * one's redirects.
 */
async function navigatedOf(
  stack: CheckedStack,
  headBytes: number,
  asked: Asked,
  navigations: ReadonlyMap<string, OwnNavigation>,
): Promise<
  | string
  | {
      readonly navigatedBy: Map<string, readonly Navigated[]>;
      readonly landings: readonly Landing[];
    }
> {
  const page = new URL(asked.requested, stack.site);
  const navigatedBy = new Map<string, Navigated[]>();
  const landings: Landing[] = [];
  const seen = new Set<string>();
  for (const navigation of navigations.values()) {
    const { answer, headers } = navigation;
    const agent = headers['user-agent'] ?? '';
    const listed = navigatedBy.get(agent) ?? [];
    navigatedBy.set(agent, listed);
    if (redirects(answer)) {
      const landed = await landingsOf(stack, headBytes, { page, navigation }, seen);
      if (typeof landed === 'string') {
        return landed;
      }
      landings.push(...landed);
      continue;
    }
    const { steps, page: routed } = await documentRedirects(stack, {
      answer,
      url: page,
      headers,
      jar: [],
    });
    // Where no client router runs on what it was answered with, none asks for the page's parts.
    if (routed !== true) {
      continue;
    }
    const served = servedOtherThan(stack.manifest, answeredBy(answer), asked.key);
    listed.push({
      steps,
      served,
      as: `${navigatedFrom(navigation.from)}${navigation.withheld ?? ''}`,
    });
  }
  return { navigatedBy, landings };
}

/**
 * Why a route's document asked for in a coding, or one of its parts, is not answered as the edge
 * answers it (`codedFailure`, `partsFailure`). Each browser's own navigations keep what they came
 * to, by its agent, one from each place a navigation comes from — the navigation the page was asked
 * as among them, where it is that agent's: the cookies a router running in that browser asks for
 * the page's parts with, and the route whose parts it asks for. One that redirected has the page it
 * landed on asked for instead — its document as the browser asked it last, and its parts as that
 * browser's router asks for them there (`landedFailure`), with the cookies each answer on the way
 * set (`documentRedirects`), from each way the browser may keep those it was sent with
 * (`landingsOf`) — and fails where the check proves nothing past its redirects: one it could not
 * read, or more than a browser follows.
 */
interface FollowedAsked extends Asked {
  /** Whether `requested` is one only the rules ahead of the filesystem claim. */
  readonly exact: boolean;
  /** What its document's answer did to the cookies its parts are asked with (`parts.ts`). */
  readonly cookieChanges?: CookieChanges | undefined;
  /** The route its document was served as, where another (`parts.ts`). */
  readonly served?: string | undefined;
}

/** Coded documents, redirects and router requests for one navigation, without new rule witnesses. */
async function sampleFailure(
  stack: CheckedStack,
  headBytes: number,
  asked: FollowedAsked,
  coded: readonly CodedAsk[],
): Promise<string | undefined> {
  const navigations = new Map<string, OwnNavigation>();
  for (const ask of coded) {
    const failure = await codedFailure(stack, headBytes, { asked, ask }, navigations);
    if (failure !== undefined) {
      return failure;
    }
  }
  const navigated = await navigatedOf(stack, headBytes, asked, navigations);
  if (typeof navigated === 'string') {
    return navigated;
  }
  const { navigatedBy, landings } = navigated;
  const failure = await partsFailure(stack, { ...asked, navigatedBy });
  if (failure !== undefined) {
    return failure;
  }
  for (const landing of landings) {
    const landed = await landedFailure(stack, landing);
    if (landed !== undefined) {
      return landed;
    }
  }
  return undefined;
}

/** Follow each navigation's own cookie changes through the same document and router checks. */
export async function routeFollowUpFailure(
  stack: CheckedStack,
  headBytes: number,
  asked: FollowedAsked,
): Promise<string | undefined> {
  const coded = codedAsks(stack, asked);
  const failure = await sampleFailure(stack, headBytes, asked, coded);
  if (failure !== undefined) return failure;
  return documentRuleFailure(stack, headBytes, asked, {
    sampled: coded.map((ask) => ask.headers),
    followUp: (witness) => {
      return sampleFailure(
        stack,
        headBytes,
        { ...witness, exact: asked.exact },
        codedAsks(stack, witness),
      );
    },
  });
}
