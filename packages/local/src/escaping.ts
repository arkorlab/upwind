import type { RouteHas } from '@stayingupwind/core/bundle';
import { isReserved, type ProjectManifest, type ReservedRoute } from '@stayingupwind/core/manifest';
import {
  BYPASS_COOKIE_NAMES,
  BYPASS_QUERY_KEYS,
  BYPASS_QUERY_PREFIXES,
  DEPLOYMENT_ID_QUERY,
  INTERNAL_REQUEST_HEADER_PREFIXES,
  ROUTER_REQUEST_HEADERS,
  RSC_CACHE_BUSTING_QUERY,
} from '@stayingupwind/core/request';
import { compareCodeUnits } from '@stayingupwind/core/util';

import { edgeReads } from './answers.ts';

/**
 * A request past the rules of `next.config` that claim every request the check makes of something
 * for what it lacks (`browsers.ts`): one carrying what they say is missing — a cookie, a header, a
 * query parameter — as a visitor's browser may carry it, and be served what the check would not
 * otherwise have asked for.
 */

const UNPROVED_UNWITNESSED =
  'a rule of next.config claims every request the check makes for what it lacks, and only a value its pattern names, of which the check finds none it matches, would pass it over: no request proves it';
const UNPROVED_EXHAUSTED =
  'rules of next.config claim every request the check makes for what it lacks, and passing each over brings on another past every request the check tries: no request proves it';

/** Something of the build at a URL, as a sample is judged for it. */
export interface Target {
  readonly manifest: ProjectManifest;
  readonly url: URL;
  /** The agent the check asks as first, as validation asks as its prover (`DEFAULT_PROVER_AGENT`). */
  readonly prover: string;
  /**
   * Whether `url` is a pathname the build holds as it is — a route's own, or a file's — which only
   * the rules ahead of the filesystem claim.
   */
  readonly exact: boolean;
}

/** Whether the rules `keep` keeps alone claim the target asked with `headers`, at `url`. */
export function claimedBy(
  target: Target,
  headers: Readonly<Record<string, string>>,
  keep: (rule: ReservedRoute) => boolean,
  url = target.url,
): boolean {
  const reservedRoutes = (target.manifest.reservedRoutes ?? []).filter((rule) => keep(rule));
  return isReserved({ ...target.manifest, reservedRoutes }, url, edgeReads(headers), target.exact);
}

/**
 * Each manifest with each of its rules as its only one, kept per manifest and rule: a rule's pattern
 * is compiled once for each list it is read in (`compiledRules`), and the search below reads each
 * rule alone on every try.
 */
const ruledAlone = new WeakMap<ProjectManifest, WeakMap<ReservedRoute, ProjectManifest>>();

/** Whether `rule` alone claims the target asked with `headers`, at `url`. */
function claimedByRule(target: Target, headers: Headers, rule: ReservedRoute, url: URL): boolean {
  let kept = ruledAlone.get(target.manifest);
  if (kept === undefined) {
    kept = new WeakMap();
    ruledAlone.set(target.manifest, kept);
  }
  let manifest = kept.get(rule);
  if (manifest === undefined) {
    manifest = { ...target.manifest, reservedRoutes: [rule] };
    kept.set(rule, manifest);
  }
  return isReserved(manifest, url, headers, target.exact);
}

/** What a request carries to escape a rule that claims it for what it lacks. */
interface Carried {
  readonly headers: Record<string, string>;
  readonly search: URLSearchParams;
  /**
   * What each slot carried in — a header, a cookie or a query parameter, by its name — has been
   * carried to match: the pattern of every condition it passed over, all of which the value it
   * carries matches, so that one rule's way past does not undo another's.
   */
  readonly patterns: Map<string, readonly (string | undefined)[]>;
  /** The cookies carried, by name, sent after the sample's own (`sampled`). */
  readonly cookies: Map<string, string>;
  readonly sampled: string | undefined;
}

/** What a cookie's value cannot hold without saying something else of the header. */
const NOT_IN_A_COOKIE = /[\s",;\\]/u;
/**
 * Query parameters that make a request another class of request than the one it would carry them
 * past a rule as (`classifyRequest`): a payload's, a deployment's, Next.js's own.
 */
const PROTOCOL_QUERY_KEYS: ReadonlySet<string> = new Set([
  ...BYPASS_QUERY_KEYS,
  DEPLOYMENT_ID_QUERY,
  RSC_CACHE_BUSTING_QUERY,
]);

/**
 * Whether carrying `condition` would make the request another class, or one the edge strips — or
 * is what no request can carry to the edge: its `Accept-Encoding`, which Cloudflare's front line
 * sets on every request in the visitor's place (`edgeReads`).
 */
function protocolCondition(condition: RouteHas & { readonly key: string }): boolean {
  const { key } = condition;
  const name = key.toLowerCase();
  switch (condition.type) {
    case 'header': {
      return (
        name === 'host' ||
        name === 'accept-encoding' ||
        ROUTER_REQUEST_HEADERS.includes(name) ||
        INTERNAL_REQUEST_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
      );
    }
    case 'cookie': {
      return BYPASS_COOKIE_NAMES.includes(key);
    }
    case 'query': {
      return (
        PROTOCOL_QUERY_KEYS.has(key) ||
        BYPASS_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix))
      );
    }
    case 'host': {
      return true;
    }
  }
}

/** What no header's value holds. */
const NOT_IN_A_HEADER = /[\r\n]/u;
/** Plain values a condition's pattern is tried with, before the literals it spells. */
const PLAIN_WITNESSES: readonly string[] = ['1', 'true', 'a'];

/** Whether Next.js matches `value` against a condition's `pattern` (`matchHas`): whole. */
function nextMatches(pattern: string, value: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- the application's own pattern from its build, tried on a value the check makes up, as Next.js tries it.
    return new RegExp(`^${pattern}$`, 'u').test(value);
  } catch {
    return false;
  }
}

/** The literals a pattern spells: whole, its anchors taken off, or each of its alternatives. */
function literalsOf(pattern: string): string[] {
  const bare = pattern.replace(/^\^/u, '').replace(/\$$/u, '');
  const ungrouped = /^\((?:\?:)?([^()]*)\)$/u.exec(bare)?.[1] ?? bare;
  return [bare, ...ungrouped.split('|')].map((each) => each.replaceAll(/\\(.)/gu, '$1'));
}

/**
 * A value a request can carry that each of `patterns` matches as Next.js matches it: any, where
 * they name none; else the first of a few plain values, or of the literals they spell
 * (`literalsOf`), that every one of them matches. None where none does: a pattern copied into a
 * request matches nothing Next.js judges by it, and two patterns no literal of either both match
 * leave no value the check knows to pass both over.
 */
function witnessOf(patterns: readonly (string | undefined)[]): string | undefined {
  const named = patterns.filter((pattern) => pattern !== undefined);
  if (named.length === 0) {
    return '1';
  }
  const tried = [...PLAIN_WITNESSES, ...named.flatMap((pattern) => literalsOf(pattern))];
  const matchesEach = (value: string): boolean => named.every((each) => nextMatches(each, value));
  return tried.find((candidate) => candidate !== '' && matchesEach(candidate));
}

/** The slot a condition is carried in: a header (in any case), a cookie or a query parameter. */
function slotOf(condition: RouteHas & { readonly key: string }): string {
  const { key } = condition;
  return `${condition.type}:${condition.type === 'header' ? key.toLowerCase() : key}`;
}

/** The `Cookie` a request carrying `carried` sends: its sample's own, then each carried. */
function cookieOf(carried: Carried): string {
  const pairs = [...carried.cookies].map(([name, value]) => `${name}=${value}`);
  return [...(carried.sampled === undefined ? [] : [carried.sampled]), ...pairs].join('; ');
}

/**
 * What `carry` made of a condition: carried; one no request of the site's can carry — a host, which
 * is the site's own; or one whose pattern the check finds no value of.
 */
const CARRIED = 'carried';
const NOT_CARRIED = 'not-carried';
const UNWITNESSED = 'unwitnessed';
type Carrying = typeof CARRIED | typeof NOT_CARRIED | typeof UNWITNESSED;

/**
 * `condition` made to hold by what `carried` carries, where a request can carry it: a header, a
 * cookie or a query parameter, with a value its pattern matches — and every pattern the slot was
 * carried to match before (`witnessOf`). Not a host, nor what would make the request another class
 * of request (`protocolCondition`), which the rule is then the application's to answer for.
 */
function carry(condition: RouteHas, carried: Carried): Carrying {
  const { key } = condition;
  // Nor what would make it another request — a payload's, a draft's — than the one it is to be.
  if (key === undefined || condition.type === 'host' || protocolCondition({ ...condition, key })) {
    return NOT_CARRIED;
  }
  const slot = slotOf({ ...condition, key });
  const patterns = [...(carried.patterns.get(slot) ?? []), condition.value];
  const value = witnessOf(patterns);
  if (value === undefined || NOT_IN_A_HEADER.test(value)) {
    return UNWITNESSED;
  }
  if (condition.type === 'cookie') {
    if (NOT_IN_A_COOKIE.test(key) || NOT_IN_A_COOKIE.test(value)) {
      return UNWITNESSED;
    }
    carried.cookies.set(key, value);
    carried.headers['cookie'] = cookieOf(carried);
  } else if (condition.type === 'query') {
    carried.search.set(key, value);
  } else {
    carried.headers[key.toLowerCase()] = value;
  }
  carried.patterns.set(slot, patterns);
  return CARRIED;
}

/**
 * A request like `sample` at `url` that carries each of `conditions` a request can carry (`carry`),
 * as a rule of `next.config` asks a request for what it holds for — a header, a cookie or a query
 * parameter, with a value its pattern matches — and what it came to carry, in a verdict's words.
 * A host is the site's own, which nothing carries. None where one of them is what no request of the
 * site's can carry — what would make it another class of request — or a pattern the check finds no
 * value of.
 */
export function carryingEach(
  sample: Readonly<Record<string, string>>,
  url: URL,
  conditions: readonly RouteHas[],
):
  | { readonly headers: Record<string, string>; readonly url: URL; readonly carried: string }
  | undefined {
  const carried: Carried = {
    headers: { ...sample },
    search: new URLSearchParams(url.search),
    patterns: new Map(),
    cookies: new Map(),
    sampled: sample['cookie'],
  };
  const said: string[] = [];
  for (const condition of conditions) {
    if (condition.type === 'host') {
      continue;
    }
    if (carry(condition, carried) !== CARRIED) {
      return undefined;
    }
    said.push(saidOf(condition.type, condition.key ?? '', carried));
  }
  const at = new URL(url);
  at.search = carried.search.toString();
  return { headers: carried.headers, url: at, carried: said.join(', ') };
}

/** A slot a request carries a condition's key in: a header, a cookie or a query parameter. */
type Slot = 'header' | 'cookie' | 'query';

/** A request as a rule's conditions are made to hold for it: its headers and its URL. */
interface Made {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: URL;
}

/**
 * A request like `made` that lacks what each of `conditions` says is missing, as a rule of
 * `next.config` asks a request for what it holds for — a header, a cookie or a query parameter,
 * taken off where it carries one — and what it came to lack, in a verdict's words. A host is the
 * site's own, which no request lacks. None where one of them is what a request cannot go without
 * and stay the request it is (`protocolCondition`).
 */
export function lackingEach(
  made: Made,
  conditions: readonly RouteHas[],
): (Made & { readonly lacked: string }) | undefined {
  let request: Made = made;
  const said: string[] = [];
  for (const condition of conditions) {
    const { key } = condition;
    if (key === undefined || condition.type === 'host') {
      continue;
    }
    if (protocolCondition({ ...condition, key })) {
      return undefined;
    }
    const without = lacking(condition.type, key, request);
    if (without !== request) {
      said.push(`without ${lackedOf(condition.type, key)}`);
      request = without;
    }
  }
  return { ...request, lacked: said.join(', ') };
}

/** `request` without the header, cookie or query parameter `key`; itself where it carries none. */
function lacking(type: Slot, key: string, request: Made): Made {
  const { headers, url } = request;
  switch (type) {
    case 'header': {
      const kept = Object.entries(headers).filter(
        ([name]) => name.toLowerCase() !== key.toLowerCase(),
      );
      return kept.length === Object.keys(headers).length
        ? request
        : { headers: Object.fromEntries(kept), url };
    }
    case 'cookie': {
      const pairs = (headers['cookie'] ?? '').split(/;\s*/u).filter((pair) => pair !== '');
      const kept = pairs.filter((pair) => !pair.startsWith(`${key}=`));
      if (kept.length === pairs.length) {
        return request;
      }
      const others: Record<string, string> = Object.fromEntries(
        Object.entries(headers).filter(([name]) => name !== 'cookie'),
      );
      return { headers: kept.length === 0 ? others : { ...others, cookie: kept.join('; ') }, url };
    }
    case 'query': {
      if (!url.searchParams.has(key)) {
        return request;
      }
      const at = new URL(url);
      at.searchParams.delete(key);
      return { headers, url: at };
    }
  }
}

/** What a request came to lack in the slot `type` names `key` (`lacking`), in a verdict's words. */
function lackedOf(type: Slot, key: string): string {
  switch (type) {
    case 'header': {
      return key.toLowerCase();
    }
    case 'cookie': {
      return `the cookie ${key}`;
    }
    case 'query': {
      return `?${key}`;
    }
  }
}

/** What a request came to carry in the slot `type` names `key` (`carry`), in a verdict's words. */
function saidOf(type: Slot, key: string, carried: Carried): string {
  switch (type) {
    case 'header': {
      return `${key.toLowerCase()}: ${carried.headers[key.toLowerCase()] ?? ''}`;
    }
    case 'cookie': {
      return `the cookie ${key}=${carried.cookies.get(key) ?? ''}`;
    }
    case 'query': {
      return `?${key}=${carried.search.get(key) ?? ''}`;
    }
  }
}

/**
 * What `carried` came to carry beside what `sample` at `url` carries, in a verdict's words
 * (`saidOf`): each cookie, each header it sends otherwise, each query parameter.
 */
function carriedOf(carried: Carried, sample: Readonly<Record<string, string>>, url: URL): string {
  const cookies = [...carried.cookies.keys()].map((name) => saidOf('cookie', name, carried));
  const headers = Object.keys(carried.headers)
    .filter((name) => name !== 'cookie' && carried.headers[name] !== sample[name])
    .map((name) => saidOf('header', name, carried));
  const query = [...new Set(carried.search.keys())]
    .filter((key) => carried.search.get(key) !== url.searchParams.get(key))
    .map((key) => saidOf('query', key, carried));
  return [...cookies, ...headers, ...query].join(', ');
}

/** A copy of `carried`, carrying each of `conditions` besides (`carry`). */
function carrying(carried: Carried, conditions: readonly RouteHas[]): Carried {
  const way: Carried = {
    headers: { ...carried.headers },
    search: new URLSearchParams(carried.search),
    patterns: new Map(carried.patterns),
    cookies: new Map(carried.cookies),
    sampled: carried.sampled,
  };
  for (const condition of conditions) {
    carry(condition, way);
  }
  return way;
}

/**
 * The ways past a rule that claims a request like `carried` for what it lacks: each of what it
 * says is missing that the request can carry (`carry`) — one is enough to pass it over — and
 * whether only a value the check finds none of would be another.
 */
function waysPast(
  rule: ReservedRoute,
  carried: Carried,
): { readonly ways: readonly RouteHas[]; readonly unwitnessed: boolean } {
  const { missing } = rule;
  if (missing === undefined) {
    return { ways: [], unwitnessed: false };
  }
  const ways: RouteHas[] = [];
  let unwitnessed = false;
  for (const condition of missing) {
    const tried = carry(condition, carrying(carried, []));
    if (tried === CARRIED) {
      ways.push(condition);
    }
    unwitnessed ||= tried === UNWITNESSED;
  }
  return { ways, unwitnessed };
}

/**
 * How many requests `escaping` tries before it gives up on finding one past the rules — which then
 * proves nothing, rather than leave a target a request may reach to the application unasked.
 */
const ESCAPE_TRIES = 64;

/**
 * A request `escaping` tries, as one key whatever order it came to carry what it carries in — and
 * the patterns each value it carries has to keep matching (`Carried.patterns`): two requests that
 * carry the same now may be led apart by those, which decide what each can carry next.
 */
function triedAs(carried: Carried): string {
  const headers = Object.entries(carried.headers).toSorted(([a], [b]) => compareCodeUnits(a, b));
  const patterns = [...carried.patterns].toSorted(([a], [b]) => compareCodeUnits(a, b));
  return JSON.stringify([headers, carried.search.toString(), patterns]);
}

/** What a request like a sample comes to where the rules that claim it do for what it lacks. */
export type Escape =
  | {
      readonly kind: 'escaped';
      readonly headers: Record<string, string>;
      readonly url: URL;
      /** What it came to carry beside the sample, in a verdict's words (`carriedOf`). */
      readonly carried: string;
      /** The cookies it came to carry, as a `Cookie` header sends them: none, where it carries none. */
      readonly cookies: string;
    }
  /** A rule claims it for what it has, or for what no request of the site's can carry. */
  | { readonly kind: 'claimed' }
  /**
   * Only a value the check finds none of would pass a rule over, or the rules bring each other on
   * past what the check tries.
   */
  | { readonly kind: 'unproved'; readonly reason: string };

/**
 * The requests a request like `carried` leads to past the rules that claim it: carrying the one way
 * past each rule that has one alone, all at once — a request has to carry it to pass that rule over
 * — or, where every rule has more, each way past the first in turn. None where a rule has no way
 * past it, and why: only a value the check finds none of would pass it over (`unwitnessed`), where
 * every such rule is one of those.
 */
function nextPast(
  claiming: readonly ReservedRoute[],
  carried: Carried,
): { readonly next: readonly Carried[]; readonly unwitnessed: boolean } {
  const past = claiming.map((rule) => waysPast(rule, carried));
  if (past.some((each) => each.ways.length === 0)) {
    return {
      next: [],
      unwitnessed: past.every((each) => each.ways.length > 0 || each.unwitnessed),
    };
  }
  const forced = past.flatMap((each) => (each.ways.length === 1 ? each.ways : []));
  if (forced.length > 0) {
    return { next: [carrying(carried, forced)], unwitnessed: false };
  }
  const [first] = past;
  return {
    next: (first?.ways ?? []).map((condition) => carrying(carried, [condition])),
    unwitnessed: false,
  };
}

/**
 * A request like `sample` that no rule of `next.config` claims, and that is `served` as the
 * target, where the rules that claim it do for what it lacks (`missing`: a cookie, a header, a query
 * parameter): it carries one of what each rule says is missing — one is enough to pass it over —
 * and where a rule has several, each is tried in turn (`nextPast`), since what passes one rule over
 * may bring on another that a request carrying another way past it would not. Proved by none where
 * the check runs out of tries before it runs out of ways.
 */
export function escaping(
  target: Target,
  sample: Readonly<Record<string, string>>,
  served: (headers: Readonly<Record<string, string>>, url: URL) => boolean,
): Escape {
  const rules = target.manifest.reservedRoutes ?? [];
  const pending: Carried[] = [
    {
      headers: { ...sample },
      search: new URLSearchParams(target.url.search),
      patterns: new Map(),
      cookies: new Map(),
      sampled: sample['cookie'],
    },
  ];
  const tried = new Set<string>();
  let unwitnessed = false;
  for (let carried = pending.pop(); carried !== undefined; carried = pending.pop()) {
    const key = triedAs(carried);
    if (tried.has(key)) {
      continue;
    }
    if (tried.size === ESCAPE_TRIES) {
      return { kind: 'unproved', reason: UNPROVED_EXHAUSTED };
    }
    tried.add(key);
    const url = new URL(target.url);
    url.search = carried.search.toString();
    const asked = edgeReads(carried.headers);
    const claiming = rules.filter((rule) => claimedByRule(target, asked, rule, url));
    if (claiming.length === 0) {
      if (served(carried.headers, url)) {
        const said = carriedOf(carried, sample, target.url);
        const cookies = [...carried.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        return { kind: 'escaped', headers: carried.headers, url, carried: said, cookies };
      }
      continue;
    }
    const past = nextPast(claiming, carried);
    // The first way past is tried first, and all that it leads to before the next.
    pending.push(...past.next.toReversed());
    unwitnessed ||= past.unwitnessed;
  }
  return unwitnessed ? { kind: 'unproved', reason: UNPROVED_UNWITNESSED } : { kind: 'claimed' };
}
