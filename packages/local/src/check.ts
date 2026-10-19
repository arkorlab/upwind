import {
  edgeServedRewrites,
  PRIMARY_FUNCTION,
  staticFileAssetPrefixOf,
  staticFileLocalesOf,
} from '@stayingupwind/core/bundle';
import {
  escapedPathOf,
  fileRequestPathOf,
  type ProjectManifest,
  requestPathOf,
  type RouteEntry,
  routeRequestPathOf,
  type StaticFileEntry,
  staticFileKey,
  type StaticFileLocales,
  staticFileStatus,
  validationPathnameFor,
} from '@stayingupwind/core/manifest';
import { DEPLOYMENT_ID_QUERY } from '@stayingupwind/core/request';
import { staticFileRequestKeysOf } from '@stayingupwind/deploy/static-files';

import {
  answeredBy,
  type CheckedStack,
  CLAIMED,
  failed,
  forwarded,
  HTTP_OK,
  skipped,
  type Verdict,
} from './answers.ts';
import { DEFAULT_PROVER_AGENT } from './browser-samples.ts';
import { navigationFor, proverNavigation } from './browsers.ts';
import { type CookieChanges, cookieChangesOf, NO_COOKIE_CHANGES } from './cookie-jar.ts';
import { routeVerdict } from './documents.ts';
import { fileVerdict } from './files.ts';
import { unheldRoutes } from './held-routes.ts';
import { misheldRules } from './held-rules.ts';
import { exactRouteAt, servedOtherThan } from './landings.ts';
import { middlewareProbeVerdict } from './middleware-probe.ts';
import { missOf, probeVerdict } from './probe.ts';
import { routeFollowUpFailure } from './route-follow-ups.ts';
import { headBytesOf } from './shells.ts';
import type { LocalStack } from './stack.ts';

/**
 * Why a route or a file goes unasked for: no request reaches it, so the edge serves it to no one. A
 * member a page of its own shadows is one — Next.js, and the edge, find the page first for every
 * path that names the member — and so is a name no path names: a `.` or `..` segment, which a URL
 * resolves away, or a first segment that is empty, which a URL reads as another host's.
 */
const UNREACHED = 'no request reaches it';

/**
 * What every deployment's edge has to answer, read off the manifest it serves by and asked as a
 * deployment's validation asks it: each prerendered route at a pathname of its own
 * (`validationPathnameFor`) — a class shell at a member nothing else claims, which the edge has to
 * answer from that class — as `documents.ts` judges it; each file of the build, as `files.ts`
 * does; and each app Function, asked for a miss through the edge, answering something other than a
 * failure — an export's, its not-found document — as validation's probe of each asks
 * (`probe.ts`). Every answer is read as it streams, and held nowhere whole (`reading.ts`).
 *
 * A route or a file whose pathname a redirect or rewrite of `next.config` claims, and one the
 * application's middleware answers itself or moves elsewhere, are the application's to answer, and
 * are skipped: validation skips the first, and asks past the middleware, which a stack's edge
 * cannot. What an application answers beyond that is its own, and is not looked at.
 */

/** Why a page is skipped that the edge hands Next.js to render for every request the check makes. */
const BYPASSED_FOR_EVERY =
  "its route's bypassFor holds for every request the check could make, which Next.js renders itself";

export interface CheckFailure {
  readonly path: string;
  readonly reason: string;
}

export interface CheckResult {
  /** How many requests were asked and judged. */
  readonly checked: number;
  readonly failures: readonly CheckFailure[];
  /**
   * What was not judged, and why: what `next.config` or the middleware answers is the
   * application's.
   */
  readonly skipped: readonly CheckFailure[];
}

/** What a run of verdicts comes to, each under the path it was asked at. */
class Tally {
  checked = 0;
  readonly failures: CheckFailure[] = [];
  readonly skipped: CheckFailure[] = [];

  add(asked: string, verdict: Verdict): void {
    if (verdict.kind === 'skipped') {
      this.skipped.push({ path: asked, reason: verdict.reason });
      return;
    }
    this.checked += 1;
    if (verdict.kind === 'failed') {
      this.failures.push({ path: asked, reason: verdict.reason });
    }
  }
}

/** How a check asks. */
export interface CheckOptions {
  /**
   * The agent it asks as before any browser, and probes each Function as, as a deployment's
   * validation asks as its prover: where a host's validation proves a build as an agent of its own,
   * that one, so that a rule or `htmlLimitedBots` that tells agents apart is judged as it is there.
   * `upwind-local-check/1.0` by default.
   */
  readonly proverAgent?: string | undefined;
  /**
   * The hostname a host's validation asks a candidate under — its preview hostname, say — which every
   * request of the check's names (`Host`, `X-Forwarded-Host`) and every rule is judged on, in place
   * of the stack's own: so that a rule or a middleware that judges the host is judged as there. The
   * stack is still reached at its own socket. Register this hostname in `StackOptions.hostnames`
   * when starting the stack; a custom stack must include its origin in `LocalStack.siteOrigins`.
   */
  readonly hostname?: string | undefined;
}

/**
 * The origin the check names the site by, as a deployment's validation names it: over HTTPS, as
 * every request of the check says it came (`forwarded`) and the stack then addresses it, under the
 * stack's own host or `hostname`.
 */
function siteOf(stack: LocalStack, hostname: string | undefined): URL {
  const site = new URL(`https://${hostname ?? stack.url.host}/`);
  if (hostname !== undefined) {
    const registered = stack.siteOrigins ?? [new URL(`https://${stack.url.host}/`).origin];
    if (!registered.includes(site.origin)) {
      throw new TypeError(
        `the check's hostname ${hostname} was not registered with this stack; add it to StackOptions.hostnames`,
      );
    }
  }
  return site;
}

/** A route the check asks for, under its key in the manifest, at the pathname validation asks it at. */
interface RouteAsked {
  readonly key: string;
  readonly route: RouteEntry;
  /** The pathname validation asks the route at, as a request names it (`requestPathOf`). */
  readonly requested: string;
  /** That pathname as the check reports it: as the build names it, unescaped. */
  readonly shown: string;
  readonly headBytes: number;
  readonly prover: string;
}

/**
 * A route as validation asks for it (`navigationFor`), judged as the edge answers it, then asked for
 * again — in each coding, and for its parts — unless it failed as it is: what the application takes
 * of one request, as its middleware may, it may leave the edge of another. One whose every
 * navigation the application answers is the application's, but for those.
 */
async function routeOutcome(stack: CheckedStack, at: RouteAsked): Promise<[string, Verdict]> {
  const { key, route, requested, shown, headBytes } = at;
  const { manifest } = stack;
  // A pathname of the manifest is claimed only by the rules ahead of the filesystem; a member of
  // a class by every rule, which its matcher runs behind — as the edge finds which it is, the
  // escapes a request names it by undone (`/%E8%A8%98` for `/記`).
  const url = new URL(requested, stack.site);
  const exact = exactRouteAt(manifest, url.pathname, key);
  const page = { manifest, route, url, exact, prover: at.prover };
  const navigation = navigationFor(page);
  if (navigation.kind === 'unproved') {
    return [shown, failed(navigation.reason)];
  }
  if (navigation.kind === 'claimed' || navigation.kind === 'bypassed') {
    // The application's as it is asked — but asked again in each coding, which the rules or its
    // bypassFor may not take, and for its parts, which a rule that claims its documents may leave
    // to the edge (`missing: rsc`).
    const headers = forwarded(url, proverNavigation(at.prover));
    const asked = { key, requested, route, headers, exact };
    const followed = await routeFollowUpFailure(stack, headBytes, asked);
    const why = navigation.kind === 'claimed' ? CLAIMED : BYPASSED_FOR_EVERY;
    return [shown, followed === undefined ? skipped(why) : failed(followed)];
  }
  // With the query it carries where a rule claims a request without it (`escaping`).
  const { headers, search } = navigation;
  const asking = search === undefined ? requested : `${requested}${search}`;
  const asked = { key, requested: asking, route, headers, exact };
  // With what its answer did to the cookies a browser keeps for its parts' requests, and the route
  // it says it served it as.
  let cookieChanges: CookieChanges = NO_COOKIE_CHANGES;
  let served: string | undefined;
  const verdict = await routeVerdict(stack, headBytes, {
    ...asked,
    answered: (answer) => {
      cookieChanges = cookieChangesOf(answer.headers);
      served = servedOtherThan(manifest, answeredBy(answer), key);
    },
  });
  const followed =
    verdict.kind === 'failed'
      ? undefined
      : await routeFollowUpFailure(stack, headBytes, { ...asked, exact, cookieChanges, served });
  const reported = search === undefined ? shown : `${shown}${search}`;
  return [reported, followed === undefined ? verdict : failed(followed)];
}

/** Every prerendered route, asked for as validation asks for it (`routeOutcome`). */
async function checkRoutes(stack: CheckedStack, tally: Tally, prover: string): Promise<void> {
  const { manifest } = stack;
  await unheldRoutes(stack, tally);
  const headBytes = await headBytesOf(stack);
  for (const [key, route] of Object.entries(manifest.routes)) {
    const pathname = validationPathnameFor(key, manifest);
    if (pathname === undefined) {
      tally.add(key, failed('no pathname of its own: each is claimed elsewhere'));
      continue;
    }
    // As a request names it, as validation asks it: a parameter's `%` written in as it is starts no
    // escape, and asks for no page.
    const requested =
      pathname === key ? routeRequestPathOf(manifest, key) : requestPathOf(pathname);
    if (requested === undefined) {
      tally.add(pathname, skipped(UNREACHED));
      continue;
    }
    const asked = { key, route, requested, shown: pathname, headBytes, prover };
    const [at, verdict] = await routeOutcome(stack, asked);
    tally.add(at, verdict);
  }
}

/**
 * Where Next.js keeps a build's assets, each of which it names with the deployment's id in the
 * documents it writes where it has one (Skew Protection's `?dpl=`).
 */
const NEXT_STATIC = '/_next/static/';

/** A file of the build, as its bundle names one. */
type WrittenFile = CheckedStack['bundle']['staticFiles'][number];
/** Why a file the manifest serves fails, where the build wrote none there (`unheldFiles`). */
const UNWRITTEN_FILE =
  'held by the manifest the edge serves by, though the build wrote no file there and no rewrite of it names one';

/**
 * Why a file of the build is not held by the manifest as a deploy holds it at its pathname: as the
 * bytes the build wrote, described as the build described them — their type and length, whether
 * they are immutable — under the status it serves them with (`staticFileStatus`).
 */
function heldFailure(
  held: StaticFileEntry | undefined,
  file: WrittenFile,
  status: number,
): string | undefined {
  if (held === undefined) {
    return 'held by no entry of the manifest the edge serves by';
  }
  // Beside the build's own, the bytes a deployment before it served there: the stack deploys none
  // before this one, and `?dpl=` naming that one would be answered with whatever was put there.
  if (held.previous !== undefined) {
    return `held by the manifest the edge serves by with ${held.previous.deploymentId}'s bytes beside the build's, though the stack deploys no deployment before it`;
  }
  if (held.sha256 !== file.blob.sha256) {
    return 'held by the manifest the edge serves by as other bytes than the build wrote';
  }
  const described: readonly (readonly [string, unknown, unknown])[] = [
    ['type', held.contentType, file.blob.contentType],
    ['length', held.byteLength, file.blob.byteLength],
    ['immutable', held.immutable, file.immutable],
    ['status', held.status ?? HTTP_OK, status],
  ];
  const differing = described.find(([, heldAs, written]) => heldAs !== written);
  return differing === undefined
    ? undefined
    : `held by the manifest the edge serves by with ${differing[0]} ${String(differing[1])}, not the ${String(differing[2])} the build wrote`;
}

/**
 * The files a deploy holds of the build, by the pathname each is held at: every file the build wrote
 * — but no public file under its own asset prefix's `_next`, since the prefix's
 * rewrite takes every request there to the build's own `_next` first. Canonical build keys remain
 * available to that lookup when a nested base path puts them under the prefix too. At a pathname
 * an unconditional rewrite ahead of the filesystem names, the file it rewrites to is held as no
 * content hash.
 */
function expectedFiles(
  bundle: CheckedStack['bundle'],
): Map<string, { readonly file: WrittenFile; readonly rewritten: boolean }> {
  const expected = new Map<string, { readonly file: WrittenFile; readonly rewritten: boolean }>();
  const prefix = staticFileAssetPrefixOf(bundle);
  const rewrittenAway = prefix === undefined ? undefined : `${prefix.assetPrefix}/_next/`;
  const built = `${bundle.config.basePath}${NEXT_STATIC}`;
  const requestKeys = staticFileRequestKeysOf(bundle, undefined);
  for (const written of bundle.staticFiles) {
    if (requestKeys) {
      expectedRequestNames(expected, bundle, written);
      continue;
    }
    if (
      rewrittenAway === undefined ||
      !written.pathname.startsWith(rewrittenAway) ||
      written.pathname.startsWith(built)
    ) {
      expected.set(written.pathname, { file: written, rewritten: false });
    }
  }
  for (const served of edgeServedRewrites(bundle)) {
    expected.set(served.pathname, { file: served.file, rewritten: true });
  }
  return expected;
}

/** Actual request names in the new format, without interpreting an alias as a canonical key. */
function expectedRequestNames(
  expected: Map<string, { readonly file: WrittenFile; readonly rewritten: boolean }>,
  bundle: CheckedStack['bundle'],
  written: WrittenFile,
): void {
  const prefix = staticFileAssetPrefixOf(bundle);
  const source = prefix === undefined ? undefined : `${prefix.assetPrefix}/_next/`;
  const destination = `${bundle.config.basePath}/_next/`;
  if (source === undefined || source === destination || !written.pathname.startsWith(source)) {
    expected.set(written.pathname, { file: written, rewritten: false });
  }
  if (source !== undefined && written.pathname.startsWith(destination)) {
    expected.set(`${source}${written.pathname.slice(destination.length)}`, {
      file: written,
      rewritten: false,
    });
  }
}

/**
 * Every file the build wrote, held by the manifest the edge serves by as the build wrote it — or,
 * at a pathname an unconditional rewrite ahead of the filesystem names, as the file it rewrites to,
 * which a deploy serves there in its place (`edgeServedRewrites`), whether or not the build wrote a
 * file there itself: one a deploy left out, or held otherwise, would be asked for by nothing below,
 * or judged by what it holds. And no file besides: the stack deploys one build, with none before it
 * whose files a deploy keeps beside its own (`deploymentId`), so a file the manifest serves where
 * the build wrote none and no rewrite names one is a deploy's own, however soundly it is served.
 */
function unheldFiles(stack: CheckedStack, tally: Tally): void {
  const { staticFiles = {} } = stack.manifest;
  const { basePath } = stack.bundle.config;
  const expected = expectedFiles(stack.bundle);
  for (const [pathname, { file, rewritten }] of expected) {
    const held = Object.hasOwn(staticFiles, pathname) ? staticFiles[pathname] : undefined;
    // A rewrite's name is no hash of the bytes it answers with, whatever the file it names is.
    const written = rewritten ? { ...file, immutable: false } : file;
    const failure = heldFailure(held, written, staticFileStatus(file.pathname, basePath));
    if (failure !== undefined) {
      const named = rewritten
        ? 'named by an unconditional rewrite of the build onto a file'
        : 'written by the build';
      tally.add(pathname, failed(held === undefined ? `${named}, and ${failure}` : failure));
    }
  }
  unwrittenFiles(staticFiles, expected, tally);
}

/**
 * Every file the manifest serves where the build wrote none, and no rewrite of it names one
 * (`expected`, by pathname), and every file of a kept build (`deploymentId`): a deploy's own
 * (`unheldFiles`), as the stack deploys no build before this one, whose files a deploy would keep.
 */
function unwrittenFiles(
  staticFiles: Readonly<Record<string, StaticFileEntry>>,
  expected: ReadonlyMap<string, unknown>,
  tally: Tally,
): void {
  for (const [pathname, held] of Object.entries(staticFiles)) {
    if (held.deploymentId !== undefined) {
      tally.add(
        pathname,
        failed(
          `held by the manifest the edge serves by as a file of ${held.deploymentId}, though the stack deploys no deployment before it`,
        ),
      );
    } else if (!expected.has(pathname)) {
      tally.add(pathname, failed(UNWRITTEN_FILE));
    }
  }
}

/**
 * `pathname` behind each default locale an application with `i18n` finds a shipped file behind as
 * well (`staticFileLocalesOf`): where its middleware's rewrite of a file to itself puts the locale in
 * front of it (`forceLocale`), which Next.js serves as the file. None for a pathname outside the
 * base path, or an application without `i18n`.
 */
function localizedSpellings(locales: StaticFileLocales | undefined, pathname: string): string[] {
  if (locales === undefined) {
    return [];
  }
  const { basePath } = locales;
  if (basePath !== '' && !pathname.startsWith(`${basePath}/`)) {
    return [];
  }
  const rest = pathname.slice(basePath.length);
  return locales.locales.map((locale) => `${basePath}/${locale}${rest}`);
}

/**
 * The pathnames a file is asked for at: its own; the one with a slash after it, where the edge finds
 * the file by that as well (`staticFileKey`) — an extensionless file of an application with
 * `trailingSlash`, which Next.js answers there; — a file under `_next/` of an application with an
 * `assetPrefix` — the one its pages load it by, under the prefix the build gives them
 * (`staticFileAssetPrefixOf`); and, in an application with `i18n`, each of those behind every
 * default locale (`localizedSpellings`).
 */
/**
 * The manifest under check as it finds a file by the slash (`staticFileTrailingSlash`) where the
 * build has `trailingSlash` (`dynamicRouting`), and not otherwise, whatever it says itself.
 */
function slashedAsBuilt(stack: CheckedStack): ProjectManifest {
  const view: ProjectManifest = { ...stack.manifest };
  if (stack.bundle.config.trailingSlash) {
    view.staticFileTrailingSlash = true;
  } else {
    delete view.staticFileTrailingSlash;
  }
  return view;
}

function spellingsOf(stack: CheckedStack, pathname: string): string[] {
  const slashed = `${pathname}/`;
  const spellings = [
    pathname,
    ...(pathname.endsWith('/') || staticFileKey(slashedAsBuilt(stack), slashed) !== pathname
      ? []
      : [slashed]),
  ];
  // As the build's documents load them, and its middleware rewrites them, not as the manifest
  // under check says they do.
  const prefix = staticFileAssetPrefixOf(stack.bundle);
  const internal = prefix === undefined ? undefined : `${prefix.basePath}/_next/`;
  const own =
    prefix === undefined ||
    internal === undefined ||
    staticFileRequestKeysOf(stack.bundle, undefined) ||
    !pathname.startsWith(internal)
      ? spellings
      : [...spellings, `${prefix.assetPrefix}/_next/${pathname.slice(internal.length)}`];
  const locales = staticFileLocalesOf(stack.bundle);
  return [...own, ...own.flatMap((spelling) => localizedSpellings(locales, spelling))];
}

/** The current build's actual asset names; the local stack has no previous deployment. */
function assetsAt(bundle: CheckedStack['bundle']): string {
  const prefix = staticFileAssetPrefixOf(bundle);
  const basePath = staticFileRequestKeysOf(bundle, undefined)
    ? (prefix?.assetPrefix ?? bundle.config.basePath)
    : bundle.config.basePath;
  return `${basePath}${NEXT_STATIC}`;
}

/**
 * Every file of the single build the local stack deploys, including its asset-prefix spellings.
 * Kept files and previous bytes are refused above: deployment-transition maps are checked by
 * deployment tests rather than inferred from the manifest under check.
 */
async function checkFiles(stack: CheckedStack, tally: Tally, prover: string): Promise<void> {
  const { staticFiles = {} } = stack.manifest;
  unheldFiles(stack, tally);
  misnamedDeployment(stack, tally);
  const assets = assetsAt(stack.bundle);
  // As the build's documents name it, not as the manifest under check says they do.
  const named = stack.bundle.deploymentId;
  const asked = Object.entries(staticFiles).filter(([, file]) => file.deploymentId === undefined);
  for (const [pathname, file] of asked) {
    for (const at of spellingsOf(stack, pathname)) {
      // As a request names it: a file's name written in as it is may hold a `%` that starts no
      // escape, and another file may be named as that spells it, which the edge finds first. The
      // manifest under check only picks the spelling: where it finds the file at none, the check
      // asks as a request would, to find that out.
      const escaped = fileRequestPathOf(stack.manifest, at, pathname) ?? escapedPathOf(at);
      if (escaped === undefined) {
        tally.add(at, skipped(UNREACHED));
        continue;
      }
      tally.add(at, await fileVerdict(stack, escaped, { file, prover }));
      if (pathname.startsWith(assets)) {
        const query = `?${DEPLOYMENT_ID_QUERY}=${encodeURIComponent(named)}`;
        tally.add(
          `${at}${query}`,
          await fileVerdict(stack, `${escaped}${query}`, { file, prover }),
        );
      }
    }
  }
}

/**
 * The deployment as the manifest names it, held to the build: its id, which the build's documents
 * ask for its assets by (`?dpl=`) and the edge picks the build's own files by, and the prefix its
 * pages load them under (`staticFileAssetPrefixOf`). Either named otherwise, the edge would answer
 * those requests by a deployment, or a prefix, no page asks by — and the check, asking as the
 * manifest says, would agree with it.
 */
function misnamedDeployment(stack: CheckedStack, tally: Tally): void {
  const { bundle, manifest } = stack;
  const { dplId } = manifest.deployment;
  if (dplId !== bundle.deploymentId) {
    tally.add(
      `?${DEPLOYMENT_ID_QUERY}=${bundle.deploymentId}`,
      failed(
        `named by the manifest the edge serves by as the deployment ${dplId ?? 'none'}, not the ${bundle.deploymentId} the build's documents name it by`,
      ),
    );
  }
  const prefix = staticFileAssetPrefixOf(bundle);
  const held = manifest.staticFileAssetPrefix;
  if ((manifest.staticFileRequestKeys === true) !== staticFileRequestKeysOf(bundle, undefined)) {
    tally.add('/_next/', failed('the manifest uses a different file-key format from this build'));
  }
  if (held?.assetPrefix !== prefix?.assetPrefix || held?.basePath !== prefix?.basePath) {
    const loaded = prefix === undefined ? 'none' : prefix.assetPrefix;
    tally.add(
      `${prefix?.assetPrefix ?? held?.assetPrefix ?? ''}/_next/`,
      failed(
        `held by the manifest the edge serves by under the asset prefix ${held?.assetPrefix ?? 'none'}, not the ${loaded} the build's pages load its files under`,
      ),
    );
  }
}

/** The name the manifest gives the middleware's Function in a verdict, beside the app Functions'. */
const MIDDLEWARE_FUNCTION = 'middleware';

/**
 * Every app Function, answering a miss as validation's probe of each has it answer (`probe.ts`), and
 * the middleware's, asked once on its own (`middleware-probe.ts`).
 */
async function checkFunctions(stack: CheckedStack, tally: Tally, prover: string): Promise<void> {
  misnamedFunctions(stack, tally);
  const miss = missOf(stack, prover);
  for (const name of stack.functions) {
    tally.add(name, await probeVerdict(stack, { name, miss, prover }));
  }
  if (stack.app.middlewareScriptName !== undefined) {
    tally.add(MIDDLEWARE_FUNCTION, await middlewareProbeVerdict(stack, prover));
  }
}

/**
 * Every Function the stack runs, named by the manifest as the script the stack runs it as (`app`):
 * the first, each split one by its name, the middleware's — and none besides. A probe of a split
 * Function says only the name the edge was asked for (`fn=`), and the first answers the miss a
 * probe makes as well as any: a split Function the manifest names the first one's script for, or
 * another's, sends the routes it holds to a Worker that does not hold them, and passes its probe.
 */
function misnamedFunctions(stack: CheckedStack, tally: Tally): void {
  const held = stack.manifest.app;
  const runs = stack.app;
  // And as the deployment the stack runs them for, which the edge names a gated image source by.
  if (held.deploymentId !== runs.deploymentId) {
    tally.add(
      'app',
      failed(
        `named by the manifest the edge serves by as the Functions of ${held.deploymentId}, not of the ${runs.deploymentId} the stack runs`,
      ),
    );
  }
  const named: (readonly [string, string | undefined, string | undefined])[] = [
    [PRIMARY_FUNCTION, held.scriptName, runs.scriptName],
    [MIDDLEWARE_FUNCTION, held.middlewareScriptName, runs.middlewareScriptName],
  ];
  const heldSplit = held.functions ?? {};
  const runSplit = runs.functions ?? {};
  const split = new Set(Object.keys(heldSplit));
  const ran = Object.keys(runSplit);
  for (const name of ran) {
    split.add(name);
  }
  for (const name of split) {
    named.push([name, heldSplit[name], runSplit[name]]);
  }
  for (const [name, heldAs, runAs] of named) {
    if (heldAs !== runAs) {
      tally.add(
        name,
        failed(
          `named by the manifest the edge serves by as the script ${heldAs ?? 'none'}, not the ${runAs ?? 'none'} the stack runs it as`,
        ),
      );
    }
  }
}

/**
 * Ask the stack for every prerendered route, every file of the build, and every app Function.
 * Rejects where the stack itself cannot say what the check has to know of an answer — its backstage
 * let go of, or failed to read back, what it kept of a traced request — rather than judge that
 * answer by a guess: the stack is then what failed, not the application (`local:check` says so and
 * exits 1).
 */
export async function checkStack(
  stack: LocalStack,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const prover = options.proverAgent ?? DEFAULT_PROVER_AGENT;
  const site = siteOf(stack, options.hostname);
  const checked: CheckedStack = { ...stack, site };
  const tally = new Tally();
  await misheldRules(checked, tally);
  await checkRoutes(checked, tally, prover);
  await checkFiles(checked, tally, prover);
  await checkFunctions(checked, tally, prover);
  return { checked: tally.checked, failures: tally.failures, skipped: tally.skipped };
}
