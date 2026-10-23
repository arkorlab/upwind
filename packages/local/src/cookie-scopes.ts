import { parseCookieHeader } from '@stayingupwind/core/request';

import {
  domainsAbove,
  scopePathsAbove,
  type SentScope,
  sentScopeKey,
  trustworthy,
} from './cookie-jar.ts';

/**
 * Where a browser may keep the cookies a page's navigation was sent with, which no header says
 * (`SentScope`): each apart from the others', a name sent twice as two cookies, in a verdict's words
 * (`scopesOf`) — and those a request carries past a rule that claims it without them
 * (`carriedScopesOf`).
 */

/** A cookie a navigation was sent with: its name, and which of those of its name it is. */
interface Occurrence {
  readonly name: string;
  readonly index: number;
  readonly count: number;
}

/** The cookies `sent` names, each as it is sent: a name sent twice, twice. */
function occurrencesOf(sent: string): Occurrence[] {
  const pairs = parseCookieHeader(sent);
  const counts = new Map<string, number>();
  for (const { name } of pairs) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return pairs.map(({ name }) => {
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    return { name, index, count: counts.get(name) ?? 1 };
  });
}

/** A scope a cookie of a navigation may be kept in, in a verdict's words: none for the site's own. */
interface Option {
  readonly scope: SentScope;
  readonly where: string;
}

/**
 * The most ways the check keeps a navigation's cookies in, each name's scope apart from the others'
 * — past which it proves none of them (`scopesOf`).
 */
const COMBINATIONS = 256;

/** How the ways some cookies may be kept in are said: a navigation's, or a request's. */
interface Said {
  /** The path of the URL they were sent to, where it is said otherwise than by its name. */
  readonly ownPath?: string;
  /** Whose cookies they are, before what is said of them. */
  readonly whose: string;
  /** Why the check proves none, where they are more than it follows, by how many, in how many scopes. */
  readonly tooMany: (cookies: number, scopes: number) => string;
  /** Who keeps them, where a browser keeps them in no way at all: more of a name than scopes. */
  readonly kept: (cookies: number) => string;
}

/** As the cookies a page's navigation was sent with are said. */
const NAVIGATION_SAID: Said = {
  ownPath: "to its page's path",
  whose: "its navigation's",
  tooMany: (cookies, scopes) =>
    `its navigation's ${cookies} cookies may be kept in more ways than the check follows (${COMBINATIONS}), each in any of ${scopes} scopes: no request proves them`,
  kept: (cookies) => `its navigation's ${cookies} cookies`,
};

/** As the cookies a request carries past a rule that claims it without them are said. */
const CARRIED_SAID: Said = {
  whose: 'the carried',
  tooMany: (cookies, scopes) =>
    `the ${cookies} cookies it carries may be kept in more ways than the check follows (${COMBINATIONS}), each in any of ${scopes} scopes: no request proves them`,
  kept: (cookies) => `the ${cookies} cookies it carries`,
};

/** What a cookie kept apart by the site it was set under is, in a verdict's words. */
const PARTITIONED = 'partitioned';

/** `option` with its cookie kept apart by the site it was set under (`SentScope.partitioned`). */
function partitionedOf({ scope, where }: Option): Option {
  return {
    scope: { ...scope, partitioned: true },
    where: where === '' ? PARTITIONED : `${where}, ${PARTITIONED}`,
  };
}

/**
 * The scopes a cookie sent to `url` may be kept in: under the site's root path, the URL's own, or
 * each path between, each with a slash after it too (`scopePathsAbove`); for its host alone, or for
 * every host of each domain it is of, up to the site's registrable domain (`domainsAbove`) — the
 * site's root path, for its host alone, first — and each of those again kept apart by the site it
 * was set under (`partitionedOf`), where `url` is an origin a browser counts as secure, as it keeps
 * a partitioned cookie secure alone (`trustworthy`).
 */
function optionsOf(url: URL, said: Said): Option[] {
  const paths = scopePathsAbove(url.pathname).toReversed();
  const domains = [undefined, ...domainsAbove(url)];
  const options = domains.flatMap((domain) => {
    return paths.map((path) => {
      const own = path === url.pathname ? said.ownPath : undefined;
      const where = [
        ...(path === '/' ? [] : [own ?? `to ${path}`]),
        ...(domain === undefined ? [] : [`for every host of ${domain}`]),
      ].join(', ');
      return { scope: domain === undefined ? { path } : { path, domain }, where };
    });
  });
  return trustworthy(url)
    ? [...options, ...options.map((option) => partitionedOf(option))]
    : options;
}

/**
 * Whether a browser may keep `next` of `occurrences` in `option` beside those `assigned` before it:
 * as no cookie of its name it keeps already — by its path and domain (RFC 6265bis §5.7, step 23),
 * and whether it is partitioned (CHIPS) — whatever order it sent them in, which RFC 6265 has it
 * only *should* keep by their paths (§5.4).
 */
function keptBeside(
  sent: { readonly occurrences: readonly Occurrence[]; readonly next: Occurrence },
  assigned: readonly Option[],
  option: Option,
): boolean {
  return assigned.every((earlier, at) => {
    return (
      sent.occurrences[at]?.name !== sent.next.name ||
      earlier.scope.path !== option.scope.path ||
      earlier.scope.domain !== option.scope.domain ||
      (earlier.scope.partitioned === true) !== (option.scope.partitioned === true)
    );
  });
}

/**
 * Every way of keeping `occurrences` in `options` a browser may (`keptBeside`) — none, where they are
 * more than the check follows (`COMBINATIONS`).
 */
function assignmentsOf(
  occurrences: readonly Occurrence[],
  options: readonly Option[],
): Option[][] | undefined {
  let ways: Option[][] = [[]];
  for (const next of occurrences) {
    ways = ways.flatMap((assigned) => {
      return options
        .filter((option) => keptBeside({ occurrences, next }, assigned, option))
        .map((option) => [...assigned, option]);
    });
    if (ways.length > COMBINATIONS) {
      return undefined;
    }
  }
  return ways;
}

/** A cookie of a navigation, in a verdict's words: its name, and which of its name it is. */
function cookieWords({ name, index, count }: Occurrence): string {
  return count === 1 ? `cookie ${name}` : `cookie ${name} #${String(index + 1)}`;
}

/**
 * Where `assigned` keeps `occurrences`, in a verdict's words: nothing where each is the site's own;
 * all of them alike, where they are; or each that is not the site's own, apart.
 */
function wordsOf(
  occurrences: readonly Occurrence[],
  assigned: readonly Option[],
  said: Said,
): string {
  const apart = occurrences.flatMap((occurrence, at) => {
    const where = assigned[at]?.where ?? '';
    return where === '' ? [] : [`${cookieWords(occurrence)} kept ${where}`];
  });
  if (apart.length === 0) {
    return '';
  }
  const [first] = assigned;
  return first !== undefined && assigned.every((option) => option === first)
    ? `, ${said.whose} cookies kept ${first.where}`
    : `, ${said.whose} ${apart.join(', ')}`;
}

/** A way a browser may keep a navigation's cookies: by each name, and in a verdict's words. */
export interface Scoped {
  readonly scopes: ReadonlyMap<string, SentScope>;
  readonly as: string;
}

/**
 * Each way a browser may keep the cookies `sent` to `url`, each apart from the others'
 * (`assignmentsOf`) — one where it sent none — or, where they are more than the check follows
 * (`COMBINATIONS`), none, and why it proves none of them: each as `said` says it.
 */
function waysOf(
  url: URL,
  sent: string,
  said: Said,
): { readonly ways: readonly Scoped[]; readonly unproved?: string } {
  const occurrences = occurrencesOf(sent);
  const options = optionsOf(url, said);
  const ways = assignmentsOf(occurrences, options);
  if (ways === undefined) {
    return { ways: [], unproved: said.tooMany(occurrences.length, options.length) };
  }
  // More of a name than scopes to keep them apart in: no browser holds them all.
  if (ways.length === 0) {
    return {
      ways: [],
      unproved: `${said.kept(occurrences.length)} are kept in no way a browser keeps them, more of a name than scopes to keep them apart in (${options.length}): no request proves them`,
    };
  }
  return {
    ways: ways.map((assigned) => {
      const scopes = new Map(
        occurrences.map(
          ({ name, index, count }, at) =>
            [sentScopeKey(name, index, count), assigned[at]?.scope ?? {}] as const,
        ),
      );
      return { scopes, as: wordsOf(occurrences, assigned, said) };
    }),
  };
}

/**
 * Each way a browser may keep the cookies `sent` with `page`'s navigation (`waysOf`), or why the
 * check proves none of them.
 */
export function scopesOf(
  page: URL,
  sent = '',
): { readonly ways: readonly Scoped[]; readonly unproved?: string } {
  return waysOf(page, sent, NAVIGATION_SAID);
}

/**
 * Each way a browser may keep the cookies `carried` that a request to `url` carries past a rule
 * that claims it without them — each in a scope that sends it there (`waysOf`) — or why the check
 * proves none of them.
 */
export function carriedScopesOf(
  url: URL,
  carried: string,
): { readonly ways: readonly Scoped[]; readonly unproved?: string } {
  return waysOf(url, carried, CARRIED_SAID);
}
