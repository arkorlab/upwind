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
 * letter past ASCII in a label of its own — and one that moves something out of the host does not,
 * since the host's own text, or the path's, is then in the wrong part. A rule with nothing of the
 * request in its host is not looked at, and what a value does to a path is the path's, as it is in
 * Next.js.
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
/** A reference a destination makes to what its rule captured: `$1`, `$region`. */
const REFERENCE = /\$\w+/gu;
const TAKES_A_VALUE = /\$\w/u;
/**
 * What stands for each reference while what was written is read as a URL: lower-case letters, which
 * every part of a URL keeps as they are, the host included.
 */
const STAND_IN = 'upwindvalue';
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

/**
 * Where a rule sends a request to another origin, as written, where it puts a value it captured in
 * the host, or anywhere else ahead of the path.
 */
function intoItsHost(route: RoutingRoute): Written | undefined {
  const written = writtenOf(route);
  const authority =
    written === undefined ? undefined : AUTHORITY.exec(written.destination)?.groups?.['authority'];
  return authority !== undefined && TAKES_A_VALUE.test(authority) ? written : undefined;
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
 * Whether `sent` is a URL `destination` names, some value or other put in for each reference it
 * makes: each part of it what that part of the destination says, read as a URL with a stand-in for
 * each reference, with anything at all where the stand-in is. A destination that does not read as a
 * URL so — a reference in its port, which Next.js does not fill in either — names none.
 */
function namedBy(destination: string, sent: URL, base: URL): boolean {
  const written = parsed(
    destination.replaceAll(REFERENCE, () => STAND_IN),
    base,
  );
  return (
    written !== undefined && PARTS.every((part) => spans(written[part].split(STAND_IN), sent[part]))
  );
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
  const written = route === undefined ? undefined : writtenOf(route);
  if (written === undefined) {
    return false;
  }
  if (!written.byLocation) {
    // A rule with a destination ends routing where it holds, so what routing hands back is its own.
    return handedBack === undefined || namedBy(written.destination, handedBack, base);
  }
  const sent = parsed(location, base);
  return sent !== undefined && namedBy(written.destination, sent, base);
}

/**
 * What routing came to for a request a rule would have sent to a host it does not name: the
 * request answered by routing itself, with a `400` — the request brought a value the rule cannot be
 * filled in with, as it does a parameter that does not decode (`undecodedResponse`) — and with what
 * else routing collected, but not the `Location`.
 */
function refused(routed: ResolveRoutesResult): ResolveRoutesResult {
  const headers = new Headers(routed.resolvedHeaders);
  headers.delete('location');
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
