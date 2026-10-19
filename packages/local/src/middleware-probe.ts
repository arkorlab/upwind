import {
  escapedPathOf,
  fileRequestPathOf,
  requestPathOf,
  routeRequestPathOf,
  validationPathnameFor,
} from '@stayingupwind/core/manifest';
import { middlewareApplies } from '@stayingupwind/core/paas';

import {
  answerTo,
  type CheckedStack,
  failed,
  forwarded,
  skipped,
  type Verdict,
} from './answers.ts';
import { proverNavigation } from './browsers.ts';
import { middlewareReads } from './routing-reads.ts';
import { BACKSTAGE_ROUTES, type MiddlewareProbe } from './workers/protocol.ts';

/**
 * The deployment's middleware, asked once on its own (`check.ts`), as each app Function is: so that
 * one whose matchers cover nothing else the check asks for — an `/api/*` one in a build of pages and
 * files — is still loaded and run, about a request its matchers cover, and answers as the edge reads
 * a middleware's answer rather than failing (`BACKSTAGE_ROUTES.middleware`). What it decides is the
 * application's; that it decides at all is the deployment's.
 */

/** As much of the backstage's account as is read: a few words of JSON. */
const ACCOUNT_BYTES = 4096;
const SERVER_ERROR = 500;

/** Why the middleware is not asked about anything: a request its matchers cover is not to be had. */
const UNMATCHED =
  'not asked: its matchers cover none of the pages and files the check asks for, nor a pathname they spell';
/** Where a matcher, as the application wrote it (`/api/:path*`), stops spelling a pathname. */
const PATTERN_SYNTAX = /[(*+:?\\{]/u;
/** A segment of the check's own after what a matcher spells, for one that asks for one there. */
const SPELLED_SEGMENT = 'upwind-check';
/** Named parameters, with a simple custom pattern and modifier where the matcher names one. */
const NAMED_PARAMETER = /:[A-Za-z_]\w*(?:\((?:\\.|[^\\()])*\))?[?*+]?/gu;
/** Small witnesses for common constraints, not a solver for arbitrary matcher expressions. */
const PARAMETER_WITNESSES = new Map([
  ['[0-9]', '1'],
  ['[0-9]+', '1'],
  ['[a-z]', 'a'],
  ['[A-Z]', 'A'],
  ['[a-z]+', 'a'],
  ['[A-Z]+', 'A'],
  ['[A-Za-z]+', 'a'],
  ['[a-zA-Z]+', 'a'],
  [String.raw`\d+`, '1'],
  [String.raw`\d`, '1'],
]);

/** A simple ASCII literal or its alternatives, not an arbitrary regular-expression solver. */
function firstLiteral(pattern: string): string | undefined {
  if (
    pattern === '' ||
    pattern.startsWith('|') ||
    pattern.endsWith('|') ||
    pattern.includes('||') ||
    /[^\w|-]/u.test(pattern)
  ) {
    return undefined;
  }
  const alternativeAt = pattern.indexOf('|');
  return alternativeAt === -1 ? pattern : pattern.slice(0, alternativeAt);
}

/** Fill each parameter separately, so a numeric parameter need not share a letter's witness. */
function spelledParameter(parameter: string): string {
  const opening = parameter.indexOf('(');
  const closing = parameter.lastIndexOf(')');
  const pattern = parameter.slice(opening + 1, closing);
  return PARAMETER_WITNESSES.get(pattern) ?? firstLiteral(pattern) ?? SPELLED_SEGMENT;
}

/**
 * Pathnames a matcher as the application wrote it (`source`) may cover: what it spells before its
 * first parameter, group or modifier, alone and with a segment after it, and with its named
 * parameters filled while keeping their literal suffixes — under the build's base
 * path, and its default locale where it has locales, which Next.js has every matcher name first.
 * Only a guess, each held to the matchers as compiled before the middleware is asked about it.
 */
function spelledBy(source: string | undefined, config: CheckedStack['bundle']['config']): string[] {
  if (source === undefined) {
    return [];
  }
  const literal = source.split(PATTERN_SYNTAX, 1)[0] ?? '';
  const stem = literal.endsWith('/') ? literal.slice(0, -1) : literal;
  const filled = [
    ...[SPELLED_SEGMENT, '1'].map((value) => source.replaceAll(NAMED_PARAMETER, () => value)),
    source.replaceAll(NAMED_PARAMETER, (parameter) => spelledParameter(parameter)),
  ];
  const locale = config.i18n?.defaultLocale;
  const prefixes = [
    config.basePath,
    ...(locale === undefined ? [] : [`${config.basePath}/${locale}`]),
  ];
  return prefixes.flatMap((prefix) => {
    return [
      prefix === '' && stem === '' ? '/' : `${prefix}${stem}`,
      `${prefix}${stem}/${SPELLED_SEGMENT}`,
      ...filled.map((pathname) => `${prefix}${pathname}`),
    ];
  });
}

/**
 * A pathname to ask the middleware about that its matchers cover: of the front page, the pages and
 * the files the check asks for, and what its matchers spell (`spelledBy`), the first they cover —
 * or none, where they cover none of them. Asked about a request they do not cover, a middleware may
 * fail as no visitor's request could have it fail: it may take every request it is given to be one
 * they cover.
 */
function pathnameFor(stack: CheckedStack, prover: string): string | undefined {
  const { bundle, manifest } = stack;
  const matchers = bundle.middleware?.matchers ?? [];
  // Each as a request names it, as the check asks it (`checkRoutes`, `checkFiles`): the backstage
  // asks the middleware for a request at the pathname it is handed. One no request names is not
  // asked.
  const pages = Object.keys(manifest.routes).map((key) => {
    const pathname = validationPathnameFor(key, manifest) ?? key;
    return pathname === key ? routeRequestPathOf(manifest, key) : requestPathOf(pathname);
  });
  const files = Object.keys(manifest.staticFiles ?? {}).map(
    (file) => fileRequestPathOf(manifest, file) ?? escapedPathOf(file),
  );
  const spelled = matchers.flatMap((matcher) => spelledBy(matcher.source, bundle.config));
  const candidates = ['/', ...pages, ...files, ...spelled].filter((each) => each !== undefined);
  const headers = proverNavigation(prover);
  return candidates.find((pathname) => {
    const url = new URL(pathname, stack.site);
    return middlewareApplies(matchers, url, middlewareReads(manifest, url, headers));
  });
}

/** What the backstage said the middleware made of the request, where it said anything readable. */
function probeOf(text: string): MiddlewareProbe | undefined {
  let said: unknown;
  try {
    said = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof said === 'object' && said !== null && 'kind' in said
    ? (said as MiddlewareProbe)
    : undefined;
}

/**
 * Why the deployment's middleware fails to answer a request its matchers cover, asked as the edge
 * asks it (`pathnameFor`): it threw, could not be reached, or answered a server error of its own.
 * None where it decided anything — to let the request on, to rewrite it, to answer it itself —
 * which is the application's to decide. Not asked where no such request is to be had. Rejects where
 * the backstage itself cannot say, as for a traced request (`checkStack`).
 */
export async function middlewareProbeVerdict(
  stack: CheckedStack,
  prover: string,
): Promise<Verdict> {
  const pathname = pathnameFor(stack, prover);
  if (pathname === undefined) {
    return skipped(UNMATCHED);
  }
  const asked = new URL(`.${BACKSTAGE_ROUTES.middleware}`, stack.backstage);
  asked.searchParams.set('path', pathname);
  const answer = await answerTo(asked, {
    headers: forwarded(stack.site, proverNavigation(prover)),
    headBytes: ACCOUNT_BYTES,
  });
  const probe = typeof answer === 'string' ? undefined : probeOf(answer.head.toString());
  if (probe === undefined) {
    const said = typeof answer === 'string' ? answer : `answered ${answer.status}`;
    throw new Error(`the stack's backstage said nothing of its middleware: ${said}`);
  }
  if (probe.kind === 'failed') {
    return failed(`asked about ${pathname} as the edge asks it, failed: ${probe.reason}`);
  }
  return failed(
    probe.status >= SERVER_ERROR
      ? `asked about ${pathname} as the edge asks it, answered ${probe.status}`
      : undefined,
  );
}
