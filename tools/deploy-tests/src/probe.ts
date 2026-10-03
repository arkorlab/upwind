import {
  type DeploymentBundle,
  foldedHeaderRulesOf,
  headerRulesOf,
  type Route,
} from '@stayingupwind/core/bundle';
import type { MiddlewareMatcher } from '@stayingupwind/core/manifest';
import { middlewareApplies } from '@stayingupwind/core/paas';

import { USER_AGENT } from './client.ts';

/**
 * What the readiness probe asks for, and how its answer is judged.
 *
 * One request, chosen so that its answer can say whose deployment gave it: a file of the bundle's that
 * nothing in the build's own routing would answer in its place, sent with headers the rules it might
 * meet are judged against, and compared by digest. `deploy.ts` decides when to ask and what to make of a
 * deployment that has not answered yet; this decides what asking means.
 */

/** Asked for by the probe, and judged by it: see `probeHeaders`. */
export const PROBE_ENCODING = 'identity';
/** How much of a page is read looking for `data-dpl-id`, which is on its first element. */
const MAX_PAGE_PREFIX = 65_536;
const REDIRECTION = 300;
const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;

/**
 * One request to prove the host is answering with *this* deployment.
 *
 * A static file of the bundle, by preference one whose path carries the build id, and its digest as the
 * expected `ETag`: a `HEAD` for it neither renders a page nor moves the body. A fixture with no static
 * file at all — a route handler and nothing else — has only the host's own account of which deployment
 * is current to go by, which is why that case is said out loud rather than passed off as the same
 * evidence.
 */
/** What one readiness check needs: where to ask, what would prove it, and whose deployment it is. */
export interface Probe {
  readonly url: URL;
  readonly etag: string | undefined;
  /**
   * Whether that digest is this build's alone.
   *
   * A content-addressed asset is shared across deployments on purpose — that is what the path means —
   * and an unchanged `public/` file is byte for byte what the fixture before it served. Either can be
   * answered by the deployment before this one while the pointer's move is still reaching the edge, so
   * neither proves which deployment answered. Both are still worth asking for: where the other
   * deployment does not have the file, the digest is proof, and where it does, the answer is no weaker
   * than the pointer this is read beside. What it is not is called proof.
   */
  readonly onlyThisBuild: boolean;
  /**
   * The application's own root, asked for when the file above cannot say whose deployment answered.
   *
   * A page Next.js rendered names its deployment itself — `data-dpl-id` on `<html>`, the mark its own
   * skew protection reads — so where one comes back, it is the evidence the file could not give.
   */
  readonly page: URL;
  readonly deploymentId: string;
}

/** A rule is ahead of the file only if it answers or rewrites; one that does neither sets headers. */
function answersOrRewrites(route: Route): boolean {
  return route.status !== undefined || route.destination !== undefined;
}

function setsEtag(rule: { headers?: Record<string, string> | undefined }): boolean {
  return Object.keys(rule.headers ?? {}).some((name) => name.toLowerCase() === 'etag');
}

/**
 * Everything that could stop a file's own digest from coming back, as one list.
 *
 * Three kinds of thing, and all three are matcher-shaped — a pattern and its conditions — which is what
 * lets the host's own reading of that shape answer for all of them. **Middleware** answers whatever it
 * matches, and a catch-all matcher includes `/_next/static`. A **redirect or rewrite ahead of the
 * filesystem** answers instead of the file; one after it does not, because by then the file has won. And
 * a **header rule that sets `ETag`** leaves the file where it is and replaces the one thing being
 * compared — from `headerRulesOf` and `foldedHeaderRulesOf`, which is where the host looks for them, both
 * read because which one it consults depends on whether it reproduces the build's own routing.
 */
function couldAnswer(bundle: DeploymentBundle): MiddlewareMatcher[] {
  const { routing } = bundle;
  return [
    ...routing.middlewareMatchers,
    ...[...routing.beforeMiddleware, ...routing.beforeFiles].filter((route) =>
      answersOrRewrites(route),
    ),
    ...[...headerRulesOf(bundle), ...(foldedHeaderRulesOf(bundle) ?? [])].filter((rule) =>
      setsEtag(rule),
    ),
  ];
}

/**
 * The headers the probe's request carries, to judge a rule's conditions by the request that will be made.
 *
 * Judging them against no headers at all would be judging a different request: a condition on
 * `user-agent` or `accept` holds for the probe and would read as failing, and the asset it disqualifies
 * would be chosen and then intercepted. Measured on Node 24 — `fetch` adds `host`, `connection`,
 * `accept`, `accept-language`, `sec-fetch-mode`, `user-agent` and `accept-encoding`, and nothing else.
 *
 * Two of them are set on the request rather than left to the runtime, because a default is not a thing
 * this file can state: `user-agent`, which would otherwise be `node`, and `accept-encoding`, whose
 * default turned out to depend on the scheme — `br, gzip, deflate` over HTTPS and `gzip, deflate` over
 * plain HTTP, both measured. `identity` earns its place twice over: it is the one value that is the same
 * under either scheme, and a response nobody compressed is a response whose `ETag` no proxy had a reason
 * to touch.
 */
function probeHeaders(url: URL): Headers {
  return new Headers({
    accept: '*/*',
    'accept-encoding': PROBE_ENCODING,
    'accept-language': '*',
    connection: 'close',
    host: url.host,
    'sec-fetch-mode': 'cors',
    'user-agent': USER_AGENT,
  });
}

/**
 * Whether a `HEAD` of this URL would come back with the file's own digest, as far as the bundle says.
 *
 * `middlewareApplies` is the host's own answer to "would this apply to this request": the pattern as
 * Next.js compiled it, the conditions as Next.js reads them, and a path that matches only once decoded.
 * Asking it rather than reading the patterns here is what keeps a *conditional* catch-all rule from
 * disqualifying every asset a build has — and what that would cost is not caution but evidence, since
 * the probe would fall back to the pointer, which is the weakest thing it can rest on.
 *
 * Used for the rules as well as the matchers, because the shape is the same one. The rules get the
 * decoded retry too, which the host would not give them; it can only make this answer more cautious, and
 * the alternative is a second reading of the same patterns kept in step with the host's by hand.
 */
function showsTheDigest(could: readonly MiddlewareMatcher[], url: URL, headers: Headers): boolean {
  try {
    return !middlewareApplies(could, url, headers);
  } catch {
    // A pattern this engine will not take. The schema refuses what is unsafe to run, and every ordinary
    // one compiles, so this is the last resort — read as applying, which loses a candidate rather than
    // the deployment.
    return false;
  }
}

export function probeOf(publicUrl: URL, bundle: DeploymentBundle): Probe {
  // Assigned rather than resolved, so that a fixture's `//path` stays on this host.
  const asked = (pathname: string): URL => {
    const url = new URL(publicUrl.origin);
    url.pathname = pathname;
    return url;
  };
  const could = couldAnswer(bundle);
  const headers = probeHeaders(publicUrl);
  const quiet = bundle.staticFiles.filter((entry) =>
    showsTheDigest(could, asked(entry.pathname), headers),
  );
  // A path carrying the build id first, because that is the one digest another deployment cannot have.
  const named = quiet.find((entry) => entry.pathname.includes(`/${bundle.buildId}/`));
  const file = named ?? quiet.find((entry) => entry.immutable) ?? quiet[0];
  return {
    url: asked(file?.pathname ?? (bundle.config.basePath || '/')),
    etag: file === undefined ? undefined : `"${file.blob.sha256}"`,
    onlyThisBuild: named !== undefined,
    page: asked(bundle.config.basePath || '/'),
    deploymentId: bundle.deploymentId,
  };
}

/**
 * Whether the host answered with the file the probe asked for.
 *
 * `W/` off the front of what came back: a proxy that recompresses a response may mark its `ETag` weak,
 * and a weak one still names this file. The probe asks for no encoding partly so that it rarely has to.
 */
export function sameFile(sent: string | null, expected: string): boolean {
  return sent !== null && sent.replace(/^W\//u, '') === expected;
}

/**
 * What the application's page said about whose deployment answered it.
 *
 * Three answers, because two kinds of silence mean different things. A page that answered and names
 * nobody — a redirect, JSON, HTML without the mark — is a definite answer: that route does not carry
 * one, and asking again will not change it. One that could not be asked — a timeout, a dropped
 * connection, a `5xx` that is not a page — is a moment, and the next request may well be a page.
 */
export type PageAnswer =
  | { readonly kind: 'named'; readonly deploymentId: string }
  | { readonly kind: 'unnamed' }
  | { readonly kind: 'unreachable' };

const UNNAMED: PageAnswer = { kind: 'unnamed' };
const UNREACHABLE: PageAnswer = { kind: 'unreachable' };

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A stream already errored when its headers arrived cannot be cancelled, and need not be.
  }
}

/**
 * The deployment the application's page names on its `<html>`.
 *
 * Any page that is not a redirect, error pages included: Next.js renders a `404` or a `500` with the same
 * mark, so the status says nothing about whose page it is. Read only as far as the mark, which is on the
 * first element, so a page that streams for as long as it likes is cancelled rather than waited out —
 * and a read cut short, the timeout firing on a page still streaming, is a moment rather than a failure
 * of the deployment.
 */
export async function askThePage(probe: Probe, withinMs: number): Promise<PageAnswer> {
  let response: Response;
  try {
    response = await fetch(probe.page, {
      headers: { 'accept-encoding': PROBE_ENCODING, 'user-agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(withinMs),
    });
  } catch {
    return UNREACHABLE;
  }
  const html = (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
  if (response.status >= REDIRECTION && response.status < CLIENT_ERROR) {
    await discard(response);
    return UNNAMED;
  }
  if (!html) {
    await discard(response);
    return response.status >= SERVER_ERROR ? UNREACHABLE : UNNAMED;
  }
  return markOn(response);
}

async function markOn(response: Response): Promise<PageAnswer> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return UNNAMED;
  }
  const decoder = new TextDecoder();
  let read = '';
  try {
    while (read.length < MAX_PAGE_PREFIX) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      read += decoder.decode(chunk.value, { stream: true });
      const named = /data-dpl-id="([^"]+)"/u.exec(read)?.[1];
      if (named !== undefined) {
        return { kind: 'named', deploymentId: named };
      }
    }
    return UNNAMED;
  } catch {
    return UNREACHABLE;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already over, which is all the cancel was for.
    }
  }
}
