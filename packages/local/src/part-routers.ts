import type { CheckedStack } from './answers.ts';
import { ROUTER_BROWSER, ROUTER_BROWSERS, ROUTER_NAVIGATION } from './browser-samples.ts';
import { NO_COOKIE_CHANGES } from './cookie-jar.ts';
import type { Scoped } from './cookie-scopes.ts';
import { visitsOf } from './origin-visits.ts';
import { type AnsweredAsks, flowFailure, flowsOf, type Held, seedsOf } from './part-flows.ts';
import {
  type Navigated,
  type Origin,
  originAt,
  originsOf,
  type PartsAsked,
  partsOf,
} from './parts.ts';
import { COOKIE, stepsApplied } from './redirects.ts';

/**
 * A route's parts asked for as each browser's router asks for them (`partsFailure`): the browser the
 * page was asked as and each a page is asked as (`routersOf`), on each page it may be on as it asks
 * (`originsOf`) — the page itself after each navigation of it that stayed there, another once the
 * browser visited that one — holding each jar it may (`part-flows.ts`).
 */

/** The header a browser names its agent by. */
const USER_AGENT = 'user-agent';
/** What a browser names itself by on every request its page's script makes, its router's among them. */
const BROWSER_IDENTITY = new Set(['accept-language', USER_AGENT]);
/** Where client hints begin, which a Chromium browser sends with each of those too. */
const CLIENT_HINT_PREFIX = 'sec-ch-';
/** What every browser's agent begins with, and no agent of a host's or of the check's own. */
const BROWSER_AGENT_PREFIX = 'Mozilla/';

/** Whether `navigation` names the agent of a browser's, in any case of its header's name. */
function browsers(navigation: Readonly<Record<string, string>>): boolean {
  const agent = Object.entries(navigation).find(([name]) => name.toLowerCase() === USER_AGENT);
  return agent?.[1].startsWith(BROWSER_AGENT_PREFIX) === true;
}

/**
 * The browser a page's router runs in, as its requests name it: the one the page's navigation was
 * asked as, where it was a browser's (`navigationFor` may take Safari or Firefox where a rule claims
 * the others) — its agent, its language and its hints — or Chrome, where the page was asked as an
 * agent no browser is (`ROUTER_BROWSER`).
 */
function routerBrowserOf(navigation: Readonly<Record<string, string>>): Record<string, string> {
  if (!browsers(navigation)) {
    return { ...ROUTER_BROWSER };
  }
  return Object.fromEntries(
    Object.entries(navigation).filter(([name]) => {
      const lower = name.toLowerCase();
      return BROWSER_IDENTITY.has(lower) || lower.startsWith(CLIENT_HINT_PREFIX);
    }),
  );
}

/** The agent a page's router names itself by, asked as `navigation` (`routerBrowserOf`). */
export function routerAgentOf(navigation: Readonly<Record<string, string>>): string {
  return routerBrowserOf(navigation)[USER_AGENT] ?? '';
}

/** A browser a page's router runs in: as its requests name it, how it navigates, in a verdict's words. */
interface Router {
  readonly browser: Readonly<Record<string, string>>;
  readonly navigation: Readonly<Record<string, string>>;
  readonly as: string;
}

/**
 * The browsers the client router asks for a page's parts in: the one the page was asked as, and
 * each browser a page is asked as (`ROUTER_BROWSERS`) where it is another — as a rule written for
 * some browsers' requests passes over the others' — each navigating as it does, the first as the
 * page was asked where that was a browser's, and as Chrome where it was not (`ROUTER_NAVIGATION`).
 */
function routersOf(navigation: Readonly<Record<string, string>>): Router[] {
  const routers = [
    {
      browser: routerBrowserOf(navigation),
      navigation: browsers(navigation) ? navigation : ROUTER_NAVIGATION,
      as: '',
    },
  ];
  const besides = ROUTER_BROWSERS.map(({ navigation: navigated, as }) => {
    return {
      browser: routerBrowserOf(navigated),
      navigation: navigated,
      as,
    };
  });
  for (const other of besides) {
    if (routers.every(({ browser }) => JSON.stringify(browser) !== JSON.stringify(other.browser))) {
      routers.push(other);
    }
  }
  return routers;
}

/**
 * Why a route's parts are not answered as the edge answers each from what the build wrote
 * (`partFailure`), asked for as each browser's router asks for them, one after another
 * (`flowFailure`): the first that is not, in a verdict's words.
 */
export async function partsFailure(
  stack: CheckedStack,
  asked: PartsAsked,
): Promise<string | undefined> {
  const every = routersOf(asked.headers);
  const routers = asked.onlyOwn === true ? every.slice(0, 1) : every;
  const page = new URL(asked.requested, stack.site);
  const cookie = Object.entries(asked.headers).find(([name]) => name.toLowerCase() === COOKIE)?.[1];
  const sent = { cookie, to: asked.sentTo ?? page, scoped: asked.scoped };
  // Each request asked once, whichever flow asks it again.
  const answered: AnsweredAsks = { judged: new Map(), followed: new Map() };
  for (const router of routers) {
    for (const origin of originsOf(stack, page)) {
      const failure = await originFailure(stack, asked, { router, origin, sent, answered });
      if (failure !== undefined) {
        return failure;
      }
    }
  }
  return undefined;
}

/** How a browser's router on a page asks for a page's parts (`originFailure`). */
interface Asking {
  readonly router: Router;
  readonly origin: Origin;
  /**
   * The cookies the page's navigation was sent with, the URL they were sent to, and the one way they
   * are kept in, where one alone is followed (`seedsOf`).
   */
  readonly sent: {
    readonly cookie: string | undefined;
    readonly to: URL;
    readonly scoped?: Scoped | undefined;
  };
  readonly answered: AnsweredAsks;
}

/** A jar a browser's router asks for a page's parts with, and the page it asks from. */
interface HeldOn extends Held {
  readonly origin: Origin;
}

/**
 * The jars a browser's router on the page itself asks for its parts with, from each it held once
 * its navigation's cookies were kept (`seeds`), once `navigated` did what it did to them — or why
 * the check proves none (`stepsApplied`).
 */
function heldOnItself(
  asking: Asking & { readonly navigated: Navigated; readonly seeds: readonly Held[] },
): { readonly held: readonly HeldOn[]; readonly unproved?: string } {
  const { router, origin, navigated } = asking;
  const held: HeldOn[] = [];
  for (const { jar, as } of asking.seeds) {
    const how = `${router.as}${origin.as}${navigated.as ?? ''}${as}`;
    const applied = stepsApplied(jar, navigated.steps);
    if (applied.unproved !== undefined) {
      return { held: [], unproved: `its navigation${how}, ${applied.unproved}` };
    }
    held.push({ jar: applied.jar, as: how, origin });
  }
  return { held };
}

/**
 * The jars a browser's router on `origin` asks for a page's parts with, from each it held once its
 * navigation's cookies were kept (`seeds`): on the page itself, once `navigated` did what it did to
 * them (`heldOnItself`); on another page, once the browser visited that page (`visitsOf`) — from
 * the page a visit that redirected landed on, where it did (`originAt`) — or why the check proves
 * none.
 */
async function heldOf(
  stack: CheckedStack,
  asking: Asking & { readonly navigated: Navigated; readonly seeds: readonly Held[] },
): Promise<readonly HeldOn[] | string> {
  const { router, origin, seeds } = asking;
  if (origin.itself) {
    const itself = heldOnItself(asking);
    return itself.unproved ?? itself.held;
  }
  const by = `${router.as}${origin.as}`;
  const held: HeldOn[] = [];
  for (const { jar, as } of seeds) {
    const { visits, failure } = await visitsOf(stack, {
      url: origin.url,
      navigation: router.navigation,
      jar,
      by: router.as,
    });
    if (failure !== undefined) {
      return failure;
    }
    for (const visit of visits) {
      const applied = stepsApplied(jar, visit.steps);
      if (applied.unproved !== undefined) {
        return `its visit${router.as} to ${origin.url.pathname}${visit.as}${as}, ${applied.unproved}`;
      }
      held.push({
        jar: applied.jar,
        as: `${by}${visit.as}${as}`,
        origin: visit.at === undefined ? origin : originAt(stack, visit.at, origin.as),
      });
    }
  }
  return held;
}

/**
 * Why a route's parts are not answered as the edge answers them, asked for as a browser's router
 * on `origin` asks for them, after `navigated`, in each flow it may (`flowsOf`): with what that
 * navigation came to — the cookies its answers set, from the page itself, which the browser's
 * router on another page has fetched none of, and the route it was served as — and with the
 * cookies it was sent with, kept for the URL they were sent to.
 */
async function navigatedFailure(
  stack: CheckedStack,
  asked: PartsAsked,
  asking: Asking & { readonly navigated: Navigated },
): Promise<string | undefined> {
  const { router, sent, answered, navigated } = asking;
  const { browser } = router;
  const { seeds, unproved } = seedsOf({ page: sent.to, sent: sent.cookie, scoped: sent.scoped });
  if (unproved !== undefined) {
    return unproved;
  }
  const held = await heldOf(stack, { ...asking, seeds });
  if (typeof held === 'string') {
    return held;
  }
  // From each page the browser is on as it asks, the parts as its router there asks for them.
  const pages = new Map<string, HeldOn[]>();
  for (const each of held) {
    const key = each.origin.url.href;
    pages.set(key, [...(pages.get(key) ?? []), each]);
  }
  for (const on of pages.values()) {
    const origin = on[0]?.origin ?? asking.origin;
    const parts = await partsOf(stack, { ...asked, served: navigated.served }, { browser, origin });
    for (const flow of flowsOf(on)) {
      const failure = await flowFailure(stack, parts, flow, answered);
      if (failure !== undefined) {
        return failure;
      }
    }
  }
  return undefined;
}

/**
 * Why a route's parts are not answered as the edge answers them, asked for as a browser's router
 * on `origin` asks for them (`navigatedFailure`): from the page itself, after each navigation the
 * browser made of it that stayed on it — one from each place a navigation comes from, where it was
 * asked so, else the document as it was asked; from another page, once for each route those were
 * served as, or as the document was, where every one redirected elsewhere.
 */
async function originFailure(
  stack: CheckedStack,
  asked: PartsAsked,
  asking: Asking,
): Promise<string | undefined> {
  const page = new URL(asked.requested, stack.site);
  const own = { url: page, changes: asked.cookieChanges ?? NO_COOKIE_CHANGES };
  const navigations = asked.navigatedBy?.get(asking.router.browser[USER_AGENT] ?? '') ?? [
    { steps: [own], served: asked.served },
  ];
  const served = new Set(navigations.map((navigated) => navigated.served));
  const tried = asking.origin.itself
    ? navigations
    : [...(served.size === 0 ? [asked.served] : served)].map((each) => {
        return {
          steps: [],
          served: each,
        };
      });
  for (const navigated of tried) {
    const failure = await navigatedFailure(stack, asked, { ...asking, navigated });
    if (failure !== undefined) {
      return failure;
    }
  }
  return undefined;
}
