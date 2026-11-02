import type {
  ResolveRoutesParams,
  ResolveRoutesResult,
  Route as RoutingRoute,
} from '@next/routing';
import { PLATFORM_HEADER_PREFIX } from '@stayingupwind/core/request';

import {
  AFTER_FILES,
  BEFORE_FILES,
  BEFORE_MIDDLEWARE,
  FALLBACK,
  redirects,
} from './rewritten-path.ts';

/**
 * Another origin a rule of `next.config` sends a request to — a rewrite's, which the runtime fetches
 * (`externalRewrite`), or a redirect's, which the client follows — held to the host the rule names,
 * where the rule puts something of the request in that host.
 *
 * `@next/routing` fills a destination in with each value its rule captured just as the value is
 * (`replaceDestination`), and reads one that names another origin as a URL as it then stands. A
 * value put in the host — `https://:region.api.example.com/:path*`, the region taken off the query,
 * a header or a cookie by a `has` condition, or off the path — may hold what ends a host (`/`, `?`,
 * `#`, `\`, `@`, `:`), and so move the rest of what was written out of the host, and the request
 * with it to a host the rule never named. Next.js encodes each value it puts in a destination's
 * hostname (`encodeURIComponent`, in `prepareDestination`), and a host holding one of those then
 * does not parse: the request fails there rather than going elsewhere (GHSA-p9j2-gv94-2wf4).
 * `@next/routing` has no such step, and nothing here runs `prepareDestination`.
 *
 * So the URL such a rule comes to is held to what was written: each of its parts — scheme, user,
 * password, host, port, path, query and fragment — has to read as the same part of the destination,
 * with anything at all where the destination takes a value, and a request whose URL does not is
 * answered `400` (`refused`) rather than sent on. A value that stays in its host passes as before —
 * `eu` makes `eu.api.example.com`, and a dot or a capital makes what it makes in Next.js, as does a
 * value past ASCII in a label of its own — and one that moves something out of the host does not,
 * since the host's own text, or the path's, is then in the wrong part. A rule with nothing of the
 * request in its host is not looked at, and what a value does to a path is the path's, as it is in
 * Next.js.
 *
 * Two things that worked before are refused now, where the rule takes a value into its host, on
 * purpose rather than for want of a reading. A label that holds text the rule wrote beside a value,
 * where any of the label is past ASCII, the rule's text or the value
 * (`https://pré-:region.example`, or `https://api-:region.example` with a region of `é`): a URL spells
 * such a label in Punycode whole, and what was written can no longer be found in it. And a path that
 * climbs back over a value
 * (`/base/:folder/../file`): read as a URL, what was written loses the value along with the segment
 * it climbs over, so a value of more than one segment leaves some behind that the reading has no
 * room for, while a value of one still passes. In both there is nothing to hold the URL to, and
 * refusing is the side to be wrong on.
 */

/**
 * Where routing leaves word of a rule that put something of the request in the host it sends a
 * request to, named for the table and the rule: the platform's, never sent (`keptToTheirHosts`).
 * Routing hands back the URL a rule with a destination came to (`externalRewrite`, `redirect`), so
 * such a rule's mark says nothing more. A redirect by its `Location` alone comes back as that header,
 * which a middleware run after the rule may set over, so its mark carries the `Location` as written:
 * `@next/routing` fills the mark in as it fills the header in, and the mark is the rule's own.
 */
const DESTINATION_MARK = `${PLATFORM_HEADER_PREFIX}destination-`;
const MARKED_RULE = /^(?<table>\d+)-(?<rule>\d+)$/u;
/** Another origin, as `@next/routing` tells one in a destination (`isExternalDestination`). */
const EXTERNAL = /^https?:\/\//u;
/**
 * What a `Location` names ahead of its path: a scheme, perhaps, and then the authority after two
 * slashes, either of which a browser reads a backslash as.
 */
const AUTHORITY = /^(?:[a-z][\d+.a-z-]*:)?[/\\]{2}(?<authority>[^/?#\\]*)/iu;
const PLACE = /^\d+$/u;
const STARTS_WITH_A_DIGIT = /^\d/u;
const NOT_A_LETTER = /[^A-Za-z]/gu;
/**
 * What stands for each reference while what was written is read as a URL: lower-case letters, which
 * every part of a URL keeps as they are, the host included. A destination may spell one of them as
 * text of its own, which would then be read as taking a value there (`standInsFor`).
 */
const STAND_INS = ['upwindvalue', 'upwindreference'] as const;
const PARTS = [
  'protocol',
  'username',
  'password',
  'hostname',
  'port',
  'pathname',
  'search',
  'hash',
] as const;
const HTTP_BAD_REQUEST = 400;

type RoutingTables = ResolveRoutesParams['routes'];

/** Where a rule sends a request, as written, and whether routing hands back only its `Location`. */
interface Written {
  readonly destination: string;
  readonly byLocation: boolean;
}

/** The same, with the names it is filled in by (`captureNamesOf`). */
interface Referring extends Written {
  readonly names: readonly string[];
}

/**
 * Where a rule sends a request to another origin, as written: its destination, as `@next/routing`
 * reads a redirect's too; or a redirect's `Location`, where it has no destination.
 */
function writtenOf(route: RoutingRoute): Written | undefined {
  const { destination } = route;
  if (destination !== undefined) {
    return EXTERNAL.test(destination) ? { destination, byLocation: false } : undefined;
  }
  if (!redirects(route)) {
    return undefined;
  }
  const location = Object.entries(route.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'location',
  )?.[1];
  return location === undefined ? undefined : { destination: location, byLocation: true };
}

/** The groups a pattern captures, by place and by name; none of a pattern that does not compile. */
function groupsOf(pattern: string): { readonly places: number; readonly names: string[] } {
  try {
    // With an empty alternative after it the pattern matches the empty string, and its match lists
    // every group, each unset. Compiled as `@next/routing` compiles it, without `u`.
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- a rule's own pattern, run against nothing
    const match = new RegExp(`(?:${pattern})|`).exec('');
    return { places: (match?.length ?? 1) - 1, names: Object.keys(match?.groups ?? {}) };
  } catch {
    return { places: 0, names: [] };
  }
}

/**
 * The names `@next/routing` fills a rule's destination in by (`replaceDestination`), longest first
 * as it tries them: each group of the rule's pattern by its place and by its name, and of each of
 * its conditions but a host's, the key with all but its letters taken out, and the named groups of
 * its value (`checkHasConditions`). A `$` before anything else is text, which it leaves as it is.
 */
function captureNamesOf(route: RoutingRoute): string[] {
  const own = groupsOf(route.sourceRegex);
  const names = Array.from({ length: own.places }, (_, place) => String(place + 1));
  names.push(...own.names);
  const conditions = route.has ?? [];
  for (const condition of conditions) {
    if (condition.type !== 'host') {
      names.push(condition.key.replaceAll(NOT_A_LETTER, ''));
    }
    if (condition.value !== undefined) {
      names.push(...groupsOf(condition.value).names);
    }
  }
  return [...new Set(names)]
    .filter((name) => name !== '')
    .toSorted((one, other) => other.length - one.length);
}

/**
 * `text` with `standIn` for each reference it makes, found where `@next/routing` finds them: at each
 * `$`, the longest of `names` the text goes on with, and a place only where no digit follows it.
 */
function withStandIns(text: string, names: readonly string[], standIn: string): string {
  let out = '';
  let from = 0;
  let dollar = text.indexOf('$');
  while (dollar !== -1) {
    const rest = text.slice(dollar + 1);
    const name = names.find((each) => {
      return (
        rest.startsWith(each) &&
        !(PLACE.test(each) && STARTS_WITH_A_DIGIT.test(rest.slice(each.length)))
      );
    });
    if (name === undefined) {
      dollar = text.indexOf('$', dollar + 1);
    } else {
      out += `${text.slice(from, dollar)}${standIn}`;
      from = dollar + 1 + name.length;
      dollar = text.indexOf('$', from);
    }
  }
  return `${out}${text.slice(from)}`;
}

/**
 * Where a rule sends a request to another origin, as written, where it puts a value it captured in
 * the host, or anywhere else ahead of the path: a reference there to one of the names it is filled
 * in by, and not only text that spells one after a `$`.
 */
function intoItsHost(route: RoutingRoute): Referring | undefined {
  const written = writtenOf(route);
  if (written === undefined) {
    return undefined;
  }
  const authority = AUTHORITY.exec(written.destination)?.groups?.['authority'];
  // A reference starts with `$`, and nothing else is a reason to read the rule's names: a group's
  // name may begin with any letter, not only one `\w` holds.
  if (authority?.includes('$') !== true) {
    return undefined;
  }
  const names = captureNamesOf(route);
  return withStandIns(authority, names, '') === authority ? undefined : { ...written, names };
}

/**
 * The rules of one table, each that puts something of the request in the host it sends a request
 * to carrying the platform's mark (`DESTINATION_MARK`), named for the table and the rule. A table
 * with none, which is nearly every table, is handed on as it came, without another list made of it.
 */
export function markedDestinations(routes: RoutingRoute[], table: number): RoutingRoute[] {
  if (routes.every((route) => intoItsHost(route) === undefined)) {
    return routes;
  }
  return routes.map((route, rule) => {
    const written = intoItsHost(route);
    if (written === undefined) {
      return route;
    }
    const name = `${DESTINATION_MARK}${String(table)}-${String(rule)}`;
    return {
      ...route,
      headers: { ...route.headers, [name]: written.byLocation ? written.destination : '' },
    };
  });
}

/** The rules of the table a mark names, as routing was handed them. */
function tableOf(tables: RoutingTables, table: number): readonly RoutingRoute[] {
  switch (table) {
    case BEFORE_MIDDLEWARE: {
      return tables.beforeMiddleware;
    }
    case BEFORE_FILES: {
      return tables.beforeFiles;
    }
    case AFTER_FILES: {
      return tables.afterFiles;
    }
    case FALLBACK: {
      return tables.fallback;
    }
    default: {
      return [];
    }
  }
}

function parsed(text: string, base: URL): URL | undefined {
  try {
    return new URL(text, base);
  } catch {
    return undefined;
  }
}

/**
 * Whether `text` reads as `pieces` with anything at all between each and the next: the first at
 * its start, the last at its end, and each between them after the one before. The first place each
 * of those can go is as good as any later one, so nothing is tried twice.
 */
function spans(pieces: readonly string[], text: string): boolean {
  const [first = '', ...rest] = pieces;
  const last = rest.pop();
  if (last === undefined) {
    return text === first;
  }
  if (first.length + last.length > text.length || !text.startsWith(first) || !text.endsWith(last)) {
    return false;
  }
  const end = text.length - last.length;
  let at = first.length;
  for (const piece of rest) {
    const found = text.indexOf(piece, at);
    if (found === -1 || found + piece.length > end) {
      return false;
    }
    at = found + piece.length;
  }
  return true;
}

/**
 * The stand-ins for `destination`: `STAND_INS`, lengthened until the destination spells neither in
 * any case, so that one that does is still read. Read twice all the same: a host may come to spell
 * one once it is read as a URL, decoded or mapped, which the two readings then disagree over.
 */
function standInsFor(destination: string): readonly string[] {
  const spelled = destination.toLowerCase();
  let standIns: readonly string[] = STAND_INS;
  while (standIns.some((standIn) => spelled.includes(standIn))) {
    standIns = standIns.map((standIn) => `${standIn}q`);
  }
  return standIns;
}

/** Each part of what was written, read as a URL, cut where `standIn` stands for a reference. */
function piecesOf(written: Referring, standIn: string, base: URL): string[][] | undefined {
  const read = parsed(withStandIns(written.destination, written.names, standIn), base);
  return read === undefined ? undefined : PARTS.map((part) => read[part].split(standIn));
}

/**
 * Whether `sent` is a URL `destination` names, some value or other put in for each reference it
 * makes: each part of it what that part of the destination says, read as a URL with a stand-in for
 * each reference, with anything at all where the stand-in is. A destination that does not read as a
 * URL so — a reference in its port, which Next.js does not fill in either — names none, nor does one
 * that reads otherwise with the other stand-in (`STAND_INS`).
 */
function namedBy(written: Referring, sent: URL, base: URL): boolean {
  const [one, other] = standInsFor(written.destination).map((standIn) =>
    piecesOf(written, standIn, base),
  );
  if (one === undefined || other === undefined || JSON.stringify(one) !== JSON.stringify(other)) {
    return false;
  }
  return PARTS.every((part, index) => spans(one[index] ?? [], sent[part]));
}

/**
 * Whether the rule a mark names, which held, sent the request to a host its destination names: by
 * the URL routing hands back for a rule with a destination, or by the `Location` its mark carries.
 */
function heldTo(
  tables: RoutingTables,
  [name, location]: readonly [string, string],
  handedBack: URL | undefined,
  base: URL,
): boolean {
  const mark = MARKED_RULE.exec(name.slice(DESTINATION_MARK.length))?.groups;
  const route =
    mark === undefined ? undefined : tableOf(tables, Number(mark['table']))[Number(mark['rule'])];
  const written = route === undefined ? undefined : intoItsHost(route);
  if (written === undefined) {
    return false;
  }
  if (!written.byLocation) {
    // A rule with a destination ends routing where it holds, so what routing hands back is its own.
    return handedBack === undefined || namedBy(written, handedBack, base);
  }
  const sent = parsed(location, base);
  return sent !== undefined && namedBy(written, sent, base);
}

/**
 * What routing came to for a request a rule would have sent to a host it does not name: the
 * request answered by routing itself, with a `400` — the request brought a value the rule cannot be
 * filled in with, as it does a parameter that does not decode (`undecodedResponse`) — and with what
 * else routing collected, but not the `Location`, nor a `Refresh` a rule set beside it, which a
 * browser follows too.
 */
function refused(routed: ResolveRoutesResult): ResolveRoutesResult {
  const headers = new Headers(routed.resolvedHeaders);
  headers.delete('location');
  headers.delete('refresh');
  return { resolvedHeaders: headers, status: HTTP_BAD_REQUEST };
}

/**
 * What routing came to, with the marks of the rules that put something of the request in a host
 * taken out (`markedDestinations`), and refused where one of those rules held and sent the request
 * to a host it does not name (`namedBy`). `tables` are the tables routing was handed, and `url` is
 * the URL it routed.
 */
export function keptToTheirHosts(
  routed: ResolveRoutesResult,
  tables: RoutingTables,
  url: URL,
): ResolveRoutesResult {
  const headers = routed.resolvedHeaders;
  if (headers === undefined) {
    return routed;
  }
  const marks: (readonly [string, string])[] = [];
  for (const [name, value] of headers) {
    if (name.startsWith(DESTINATION_MARK)) {
      marks.push([name, value]);
    }
  }
  if (marks.length === 0) {
    return routed;
  }
  for (const [name] of marks) {
    headers.delete(name);
  }
  const handedBack = routed.externalRewrite ?? routed.redirect?.url;
  const kept = marks.every((mark) => heldTo(tables, mark, handedBack, url));
  return kept ? routed : refused(routed);
}
