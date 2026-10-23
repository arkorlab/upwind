import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import {
  isReserved,
  pathIsReserved,
  type ReservedRoute,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { EDGE_VALIDATED_HEADER } from '@stayingupwind/core/request';

import {
  answeredBy,
  answerTo,
  type CheckedStack,
  EDGE_HEADER,
  failed,
  failureStatus,
  forwarded,
  type Verdict,
} from './answers.ts';
import { proverNavigation } from './browsers.ts';
import type { Reading } from './reading.ts';
import { routedReads } from './routing-reads.ts';
import { BACKSTAGE_ROUTES } from './workers/protocol.ts';

/**
 * Each app Function, asked for a miss through the edge, as a deployment's validation asks each
 * (`check.ts`): so that one holding no route the check reaches otherwise — route handlers only, say
 * — is still loaded and run once, and reached as the edge reaches it. The edge hands the request to
 * the Function it is told to and says so, and the Function answers something other than a failure;
 * and where the build's pages are all files — a static export, whose Function is what answers every
 * pathname it wrote no file for — it answers with the not-found document the build wrote, as
 * validation asks of an export. Where a rule of `next.config` claims every pathname — a catch-all — the
 * pathname is asked all the same, as validation's probe is, and held to not failing alone: what the
 * rule leads to is the application's to answer, but the Function still has to load to answer it.
 */

const NOT_FOUND_STATUS = 404;
/** What the edge's account of a request it handed to an app Function begins with. */
const HANDED_ON = 'passthrough;';
/** An export's not-found document, under its base path: what its Function answers a miss with. */
const NOT_FOUND_DOCUMENT = '/404';

/** A build whose pages are files rather than routes: neither a prerender nor an entrypoint. */
function servesDocumentsOnly(bundle: DeploymentBundle): boolean {
  return bundle.prerenders.length === 0 && bundle.entrypoints.length === 0;
}

/**
 * Every rule an export's Function evaluates on a miss: ahead of the filesystem, after it, and the
 * last-resort fallback. A pathname any of them covers is answered by the rule, not the not-found.
 * A rule with neither a status nor a destination is a header rule, which claims nothing.
 */
function exportClaims(bundle: DeploymentBundle): ReservedRoute[] {
  const { routing } = bundle;
  const claiming = routing.beforeMiddleware.filter(
    (route) => route.status !== undefined || route.destination !== undefined,
  );
  return [...claiming, ...routing.beforeFiles, ...routing.afterFiles, ...routing.fallback].map(
    (route) => {
      return {
        sourceRegex: route.sourceRegex,
        ...(route.has !== undefined && { has: route.has }),
        ...(route.missing !== undefined && { missing: route.missing }),
      };
    },
  );
}

/** A pathname asked of each Function, and whether something of the build's claims it. */
export interface Miss {
  readonly pathname: string;
  readonly claimed: boolean;
}

/**
 * How many pathnames are minted before a miss is given up on, as validation tries as many: a rule
 * that claims one may not claim another of another shape, and only one that claims every path
 * claims them all.
 */
const MISS_ATTEMPTS = 8;

/** The shapes of a miss, each a pathname no build could have predicted, differing in depth. */
const MISS_SHAPES: readonly ((id: string) => string)[] = [
  (id) => `/_upwind-local-check/${id}`,
  (id) => `/upwind-local-check-${id}`,
  (id) => `/${id}/${crypto.randomUUID()}`,
  (id) => `/${id}`,
];

/** The `attempt`-th miss, of the shapes in turn. */
function missSpelling(attempt: number): string {
  const shape = MISS_SHAPES[attempt % MISS_SHAPES.length] ?? MISS_SHAPES[0];
  return shape === undefined ? `/${crypto.randomUUID()}` : shape(crypto.randomUUID());
}

/**
 * A pathname no build serves, minted for this run under the build's base path: unpredictable, so
 * that no route of the application's is asked for in its place, and the first of several spellings
 * no rule of `next.config` claims — or, every one claimed, the first, asked all the same.
 */
export function missOf(stack: CheckedStack, prover: string): Miss {
  const { bundle, manifest } = stack;
  const misses = Array.from({ length: MISS_ATTEMPTS }, (_, attempt) => {
    const pathname = `${bundle.config.basePath}${missSpelling(attempt)}`;
    const url = new URL(pathname, stack.site);
    // As it is sent (`probeVerdict`): as the check's own agent, under the site's origin — the `Host`
    // its URL names and the forwarding headers beside it — each of which a rule may ask of. And as
    // it is routed (`routedReads`, Codex): the edge judges its rules on what the forwarder hands on,
    // and the Function, which an export's rules run in, is handed that — the edge's own `Via` among
    // it — so a rule asking of one claims the miss there as here.
    const headers = routedReads(url, forwarded(stack.site, proverNavigation(prover)));
    const claimed =
      Object.hasOwn(manifest.routes, pathname) ||
      Object.hasOwn(manifest.staticFiles ?? {}, pathname) ||
      isReserved(manifest, url, headers, false) ||
      (servesDocumentsOnly(bundle) && pathIsReserved(exportClaims(bundle), url, headers, false));
    return { pathname, claimed };
  });
  return (
    misses.find((miss) => !miss.claimed) ?? { pathname: misses[0]?.pathname ?? '/', claimed: true }
  );
}

/** The not-found document an export's Function answers `miss` with; none for any other build. */
function notFoundFor(stack: CheckedStack, miss: Miss): StaticFileEntry | undefined {
  const { bundle, manifest } = stack;
  return !miss.claimed && servesDocumentsOnly(bundle)
    ? manifest.staticFiles?.[`${bundle.config.basePath}${NOT_FOUND_DOCUMENT}`]
    : undefined;
}

/**
 * Why an answer to a probe of `name` is not one the edge got from that Function, as validation's
 * probe judges it: the edge handed the request to an app Function, taken as a probe of one
 * (`x-arkor-edge-validated`), and — for a build split across
 * several, where the edge picks the Function by the pointer it serves — says it asked the one named
 * first (`fn=`), which an edge that sent the request elsewhere does not say.
 *
 * A build of one Function is held to the first alone: the edge says which Function it asked only of
 * a deployment split across several (`dispatchSplit` in the edge), and validation probes no other.
 * Its one Function is the Worker its pointer names, which the edge reaches or answers `502` for.
 */
function handedOnFailure(name: string, split: boolean, answer: Reading): string | undefined {
  const answered = answeredBy(answer);
  if (!answered.startsWith(HANDED_ON)) {
    return `the edge did not hand it to an app Function (${EDGE_HEADER}: ${answered || 'none'})`;
  }
  // Said only of a request the edge took as a probe, as validation's probe has to be taken.
  if (answer.headers[EDGE_VALIDATED_HEADER] !== '1') {
    return `the edge did not take it as a probe of a Function (no ${EDGE_VALIDATED_HEADER})`;
  }
  return split && !answered.split(';').includes(`fn=${name}`)
    ? `the edge did not ask ${name} (${EDGE_HEADER}: ${answered})`
    : undefined;
}

function missFailure(notFound: StaticFileEntry | undefined, answer: Reading): string | undefined {
  if (notFound === undefined) {
    return failureStatus(answer);
  }
  if (answer.status !== NOT_FOUND_STATUS) {
    return `answered ${answer.status} for a pathname no file is held for, not ${NOT_FOUND_STATUS}`;
  }
  // The document's bytes as another type are not the document to a browser: HTML shown as text.
  const type = answer.headers['content-type'];
  if (mediaTypeOf(type) !== mediaTypeOf(notFound.contentType)) {
    return `answered a miss as ${type ?? 'no type'}, not as the not-found document's ${notFound.contentType}`;
  }
  return !answer.truncated && answer.sha256 === notFound.sha256
    ? undefined
    : 'answered a miss with other than the not-found document the build wrote';
}

/** A content type's media type, without its parameters, in the case it compares in. */
function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase();
}

/**
 * The app Function the build names `name`, asked for `miss` on the stack's backstage as the edge
 * routes a validation's probe of one: as the check's own agent, as validation asks as its prover,
 * under the site's origin, handed by the edge to the Function it names and told the middleware ran
 * (`x-arkor-middleware-done`), so that it routes the pathname itself rather than run the middleware
 * again. Read for its status, or for as much as the
 * not-found document an export answers with, and let go of past that.
 */
export async function probeVerdict(
  stack: CheckedStack,
  probed: { readonly name: string; readonly miss: Miss; readonly prover: string },
): Promise<Verdict> {
  const { name, miss } = probed;
  const notFound = notFoundFor(stack, miss);
  const probe = new URL(
    `.${BACKSTAGE_ROUTES.function}${encodeURIComponent(name)}?path=${encodeURIComponent(miss.pathname)}`,
    stack.backstage,
  );
  const answer = await answerTo(probe, {
    headers: forwarded(stack.site, proverNavigation(probed.prover)),
    headersOnly: notFound === undefined,
    // An export's not-found read to a byte past its length, which only a longer answer reaches.
    ...(notFound !== undefined && { limitBytes: notFound.byteLength + 1 }),
  });
  if (typeof answer === 'string') {
    return failed(answer);
  }
  const split = stack.functions.length > 1;
  return failed(handedOnFailure(name, split, answer) ?? missFailure(notFound, answer));
}
