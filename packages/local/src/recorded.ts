import { deriveEntry } from '@stayingupwind/core/cache';
import {
  documentHeaderRulesFor,
  foldedHeadersFor,
  headerRulesFor,
  type ProjectManifest,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import { EDGE_VALIDATED_HEADER, filterShellResponseHeaders } from '@stayingupwind/core/request';
import { mergeScopedMiddlewareHeaders } from '@stayingupwind/edge/handlers/responses';
import { runtimeCacheOf } from '@stayingupwind/host/delivery';

import {
  answeredBy,
  type CheckedStack,
  cookieFailure,
  cookieScopeOf,
  cookiesSetFailure,
  EDGE_HEADER,
  recordedHeadersOf,
  edgeReads,
} from './answers.ts';
import { ROUTE_MARKER } from './landings.ts';
import type { Reading } from './reading.ts';
import type { Regeneration } from './workers/protocol.ts';

/**
 * What a document the edge served was recorded with, and what its application set on it
 * (`documents.ts`): the headers recorded with the route or the generation of its record that served
 * it, those the rules of `next.config` and the middleware laid over them, and the record the edge
 * had a Function regenerate in front of it.
 */

/** The generation of a route's record the edge says it served a document from (`seq=`, `member=1`). */
export interface ServedGeneration {
  readonly seq: number;
  /** Whether it is a member's own record beside its class shell's. */
  readonly member: boolean;
  /**
   * Whether the edge served the document whole from it (`cont=none`): a generation complete in
   * itself, with no resume behind it, over which the rules go as the application set them.
   */
  readonly whole: boolean;
}

/** What the edge's account says after a route's name of the generation it served it from. */
const GENERATION_SUFFIX = /^;cache=[^;]*;seq=(\d+)(;member=1)?$/u;
/** What the edge says of a document it composed whole, with nothing for a resume to complete. */
const WHOLE = 'cont=none';

/** The first generation of a route's record: the build's, as a deploy seeds it. */
const BUILD_SEQ = 1;

/**
 * Whether the edge served a generation of the route's record the runtime rendered since the
 * build's (`seq=` past the build's own), or a member's own record beside its class shell's
 * (`member=1`), every generation of which — its first too — the runtime rendered for the member:
 * its bytes are that render's, not the build's shell, which the edge lets them differ from — as on
 * a stack checked after it has served for a while.
 */
export function renderedSince(answer: Reading, route: RouteEntry): boolean {
  const served = servedGeneration(answer, route);
  return served !== undefined && (served.member || served.seq > BUILD_SEQ);
}

/**
 * Whether the edge says it composed the document whole (`cont=none`), read from the fields of its
 * account ahead of the route's name alone: a route's pathname may hold `;`, and with it what reads
 * like a marker, which says nothing of how the document was composed.
 */
export function servedWhole(answered: string): boolean {
  const at = answered.indexOf(ROUTE_MARKER);
  return (at === -1 ? answered : answered.slice(0, at)).split(';').includes(WHOLE);
}

/**
 * The generation of the route's record the edge says it served a document from, if one did: its
 * sequence, whether it is a member's own record beside its class shell's (`member=1`), and whether
 * the document went out whole from it (`cont=none`).
 */
export function servedGeneration(answer: Reading, route: RouteEntry): ServedGeneration | undefined {
  // Read only after the route's whole name, which may itself hold what reads like a marker.
  const answered = answeredBy(answer);
  const named = `${ROUTE_MARKER}${route.pathname}`;
  const at = answered.indexOf(named);
  const generation =
    at === -1 ? undefined : GENERATION_SUFFIX.exec(answered.slice(at + named.length));
  const seq = Number(generation?.[1]);
  const whole = servedWhole(answered);
  return Number.isSafeInteger(seq)
    ? { seq, member: generation?.[2] !== undefined, whole }
    : undefined;
}

/** Whether `names` holds `header`, in any case. */
function names(header: string, among: readonly string[]): boolean {
  return among.some((name) => name.toLowerCase() === header);
}

/**
 * What the application set on a document: by what was served — recorded with `recorded`
 * (`recordedOf`) — by the rules of `next.config` the request selected, and by its middleware.
 */
export interface Application {
  /** Whether it set `header` itself. */
  sets(header: string, recorded: Readonly<Record<string, string>>): boolean;
  /**
   * Every header it set, as the edge lays them on a document it composes: what was recorded and
   * the rules, of what a shell goes out with (`replayedDocumentHeaders`), then the middleware's as
   * the edge merges them (`mergeScopedMiddlewareHeaders`) — each cookie scoped as the edge scopes
   * it (`cookieScopeOf`), and none of the edge's own headers.
   */
  laid(recorded: Readonly<Record<string, string>>): Headers;
}

/**
 * What the application set on a document the edge served as `served` says: composed by the edge for
 * a resume to complete — the rules as it lays them on such a document, a policy among them
 * permitting the recovery script it may append (`documentHeaderRulesFor`) — or composed whole, or
 * handed on to a Function, either of which takes them as the application's router lays them
 * (`headerRulesFor`), on a document the edge appends nothing to.
 */
export function applicationOf(
  stack: CheckedStack,
  asked: { readonly requested: string; readonly headers: Readonly<Record<string, string>> },
  decided: MiddlewareResult | undefined,
  served: 'resumed' | 'whole' | 'handed-on',
): Application {
  const url = new URL(asked.requested, stack.site);
  const rulesFor = served === 'resumed' ? documentHeaderRulesFor : headerRulesFor;
  const rules = rulesFor(stack.manifest, url, edgeReads(asked.headers)).headers;
  const ruled = Object.keys(rules);
  // Of what a shell goes out with, as the edge lays a rule's on a document.
  const configured = Object.entries(filterShellResponseHeaders(Object.entries(rules)));
  const scope = cookieScopeOf(stack);
  return {
    sets: (header, recorded) => {
      return (
        names(header, Object.keys(recorded)) ||
        names(header, ruled) ||
        (decided?.kind === 'continue' && decided.responseHeaders.has(header))
      );
    },
    laid: (recorded) => {
      const headers = new Headers(filterShellResponseHeaders(Object.entries(recorded)));
      for (const [name, value] of configured) {
        headers.set(name, value);
      }
      if (decided?.kind === 'continue') {
        mergeScopedMiddlewareHeaders(headers, decided.responseHeaders, scope);
      }
      return headers;
    },
  };
}

/**
 * Headers of a document's answer judged on their own (`shellFailure`), or the edge's to write over
 * or beside what the application set (`documentHeaders` in the edge): the rest go out as set.
 */
const DOCUMENT_JUDGED_APART: ReadonlySet<string> = new Set([
  'cache-control',
  'content-encoding',
  'content-type',
  EDGE_HEADER,
  EDGE_VALIDATED_HEADER,
  'set-cookie',
  'x-nextjs-cache',
]);
/**
 * What the edge adds to after what the application set — the shell's preloads (`applyPreloads`),
 * its own timings (`joinServerTiming`), what its answer varies by (`varyOn`) — which goes out with
 * the application's still in it: first, for a list the edge appends to.
 */
const VARY = 'vary';
const APPENDED_TO: ReadonlySet<string> = new Set(['link', 'server-timing']);

/** Why a header the edge adds to does not carry what the application set in it (`APPENDED_TO`). */
function addedToFailure(
  name: string,
  answered: string | undefined,
  value: string,
): string | undefined {
  if (name === VARY) {
    const named = new Set((answered ?? '').split(',').map((token) => token.trim().toLowerCase()));
    const missing = value
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .find((token) => token !== '' && !named.has(token) && !named.has('*'));
    return missing === undefined
      ? undefined
      : `answered with vary ${answered ?? 'none'}, without the ${missing} the application set`;
  }
  const own = value.trim();
  return own === '' || answered === own || answered?.startsWith(`${own}, `) === true
    ? undefined
    : `answered with ${name} ${answered ?? 'none'}, not beginning with the ${own} the application set`;
}
/**
 * Why a document does not carry every header the application set on it as it set it (`laid`) — its
 * policies with the nonce the edge minted for it put in them, where it minted one (`nonces.ts`).
 */
export function laidFailure(answer: Reading, laid: Headers): string | undefined {
  // Each cookie apart, as it is set and sent.
  return laidHeadersFailure(answer, laid) ?? cookieFailure(answer, laid.getSetCookie());
}

/**
 * Why a page regenerated in the foreground — the Function's render, handed on with the middleware's
 * headers laid over its own (`mergeScopedMiddlewareHeaders`) — does not carry what a document of
 * the route carries of what the application's rules and middleware set (`laid`, of nothing
 * recorded): each header as they set it, and each of their cookies, which the render may have set
 * again beside the middleware's.
 */
export function regeneratedLaidFailure(answer: Reading, laid: Headers): string | undefined {
  return laidHeadersFailure(answer, laid) ?? cookiesSetFailure(answer, laid.getSetCookie());
}

/** Why an answer does not carry each header of `laid` but its cookies as `laid` has it. */
function laidHeadersFailure(answer: Reading, laid: Headers): string | undefined {
  for (const [name, value] of laid) {
    if (DOCUMENT_JUDGED_APART.has(name)) {
      continue;
    }
    const sent = answer.headers[name];
    const answered = Array.isArray(sent) ? sent.join(', ') : sent;
    if (name === VARY || APPENDED_TO.has(name)) {
      const failure = addedToFailure(name, answered, value);
      if (failure !== undefined) {
        return failure;
      }
    } else if (answered !== value) {
      return `answered with ${name} ${answered ?? 'none'}, not the ${value} the application set`;
    }
  }
  return undefined;
}

/**
 * `manifest` with its folded rules as the application set them, as the edge lays them over a
 * generation it serves whole (`foldedAsSet` in the edge): each its pattern and its headers, without
 * the form a deploy lays beside them for a document a resume completes (`documentHeaders`).
 */
function foldedAsSet(manifest: ProjectManifest): ProjectManifest {
  const rules = manifest.foldedHeaderRules;
  return rules === undefined
    ? manifest
    : {
        ...manifest,
        foldedHeaderRules: rules.map(({ sourceRegex, headers }) => ({ sourceRegex, headers })),
      };
}

/**
 * The headers the edge sent a document of `route` with as its application recorded them
 * (`recordedHeaders` in the edge): the route's own as the manifest has them — or, where a
 * generation of its record served the document, the ones that generation was recorded with, which
 * a render since the build's may have set otherwise, with the rules of `next.config` folded over
 * them as the edge folds them: as the application set them over a generation served whole
 * (`foldedAsSet`). A failure where the stack's edge never read the generation it says it served.
 * `pathname` is where the middleware left the request: a member's own record is kept under it.
 */
export async function recordedOf(
  stack: CheckedStack,
  served: {
    readonly route: RouteEntry;
    readonly pathname: string;
    /** The generation of its record the edge says it served the document from, if one. */
    readonly generation: ServedGeneration | undefined;
  },
): Promise<{ readonly headers: Readonly<Record<string, string>> } | { readonly failure: string }> {
  const { route } = served;
  const { manifest } = stack;
  const { generation } = served;
  const scopeId = manifest.cache?.scopeId;
  const entryId =
    generation === undefined
      ? undefined
      : await entryFor(stack, route, { pathname: served.pathname, own: generation.member });
  if (generation === undefined) {
    return { headers: route.headers };
  }
  if (scopeId === undefined || entryId === undefined) {
    return {
      failure: `said to be served from generation ${generation.seq} of a record, where the route has none`,
    };
  }
  const own = await recordedHeadersOf(stack, { scopeId, entryId, seq: generation.seq });
  if (own === undefined) {
    return {
      failure: `served from generation ${generation.seq} of its record, which the stack's edge never read`,
    };
  }
  if (manifest.foldedHeaderRules !== undefined) {
    const judged = generation.whole ? foldedAsSet(manifest) : manifest;
    return { headers: { ...own, ...foldedHeadersFor(judged, route.pathname) } };
  }
  // A manifest that publishes no dynamic routes has its rules only in its routes' headers.
  return { headers: manifest.dynamicRoutes === undefined ? { ...route.headers, ...own } : own };
}

/**
 * The entry a record of `route`'s kind is kept under, named by the route it is filed under and the
 * pathname it is of, as the runtime keys every entry (`deriveEntry`); none for a route of no record.
 */
async function derivedEntry(
  stack: CheckedStack,
  route: RouteEntry,
  named: { readonly route: string; readonly pathname: string },
): Promise<string | undefined> {
  const { cache } = route;
  const scope = stack.manifest.cache;
  if (cache === undefined || scope === undefined) {
    return undefined;
  }
  const derived = await deriveEntry(scope.scopeId, { kind: cache.kind, ...named });
  return derived.entryId;
}

/**
 * The entry a route's record is kept under for a request at `pathname`: the route's own — or, for a
 * member's own entry beside its class shell (`runtimeCache.concreteUpgrade`), whose id no manifest
 * names, the one derived from the member's pathname under the route the class is filed under, as
 * the edge derives it (`deriveMemberKey` in the edge), of the class's kind.
 */
async function entryFor(
  stack: CheckedStack,
  route: RouteEntry,
  member: { readonly pathname: string; readonly own: boolean },
): Promise<string | undefined> {
  const { cache } = route;
  if (cache === undefined || !member.own) {
    return cache?.entryId;
  }
  return derivedEntry(stack, route, {
    route: cache.route ?? route.pathname,
    pathname: member.pathname,
  });
}

/**
 * The entries a part of `route` asked at `pathname` may be answered from a record under: the route's
 * own, and — for a member of a class of pages, whose own record the edge reads in the class's place
 * where the stack's policy upgrades a member so (`upgradesMember` in the edge) — the member's
 * (`entryFor`). None for a route of no record.
 */
export async function recordEntriesOf(
  stack: CheckedStack,
  route: RouteEntry,
  pathname: string,
): Promise<readonly string[]> {
  const own = route.cache?.entryId;
  if (own === undefined) {
    return [];
  }
  const upgraded =
    runtimeCacheOf(stack.policy).concreteUpgrade &&
    route.cache?.kind === 'app-page' &&
    route.pathname.includes('[') &&
    route.pathname !== pathname;
  const member = upgraded ? await entryFor(stack, route, { pathname, own: true }) : undefined;
  return member === undefined || member === own ? [own] : [own, member];
}

/**
 * Why the record the edge had its Function regenerate in front of a request (`Regeneration`, kept
 * for the traced request) is not `route`'s for the request at `pathname`: its entry is not the one
 * the route's record is kept under for it (`entryFor`).
 */
export async function regenerationFailure(
  stack: CheckedStack,
  route: RouteEntry,
  read: { readonly regenerated: Regeneration | undefined; readonly pathname: string },
): Promise<string | undefined> {
  const { regenerated } = read;
  if (regenerated === undefined) {
    return 'said to be regenerated, where the edge had its Function regenerate nothing';
  }
  const own = regenerated.member;
  const expected = await entryFor(stack, route, { pathname: read.pathname, own });
  if (regenerated.entry !== expected) {
    const whose = own ? `the member ${read.pathname}'s` : 'its own';
    return `regenerated as the entry ${regenerated.entry}, not ${whose} ${expected ?? '(none)'}`;
  }
  // And as the route the entry is kept under, which the Function renders: one that, with the
  // pathname the entry is of, names the entry (`deriveEntry`), as no other route does.
  const pathname = own ? read.pathname : route.pathname;
  const named = await derivedEntry(stack, route, { route: regenerated.route, pathname });
  return named === regenerated.entry
    ? undefined
    : `regenerated as the route ${regenerated.route}, under which ${pathname} is kept as no such entry`;
}
