import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';

import {
  bundleBlobs,
  type DeploymentBundle,
  deploymentBundleSchema,
  foldedHeaderRulesOf,
  headerRulesOf,
  type Route,
} from '@stayingupwind/core/bundle';
import type { MiddlewareMatcher } from '@stayingupwind/core/manifest';
import { middlewareApplies } from '@stayingupwind/core/paas';

import {
  ApiError,
  type Client,
  type DeploymentDetail,
  type ProjectDetail,
  USER_AGENT,
} from './client.ts';
import type { Config } from './config.ts';
import { fixtureEnvironment } from './fixture-env.ts';

/**
 * A test application deployed the way anybody deploys: its bundle uploaded to a host over that host's
 * public API, and served by the host from then on.
 *
 * This is what the suite needs of an adapter that has no server of its own. What the adapter writes is
 * a bundle; serving one — the static files, the shells, the routing in front of the Function — is the
 * host's half of the contract, and the only honest way to test the two together is to let a host do
 * it. Nothing here is test-only: every call is an operation the API already serves, and the only thing
 * asked of the host is a project to put fixtures in.
 */

const BUNDLE_DIRECTORY = '.arkor';
const BLOBS_DIRECTORY = 'blobs';
const UPLOAD_CONCURRENCY = 8;
const POLL_INTERVAL_MS = 3000;
/** How long a deployment may go without reaching a further step before it is taken to be stuck. */
const NO_PROGRESS_TIMEOUT_MS = 900_000;
const PROGRESS_EVERY = 25;
/** How long any one request may take. The client bounds its own; this is the readiness probe's. */
const REQUEST_TIMEOUT_MS = 30_000;
const TERMINAL_STATUSES = new Set(['active', 'failed', 'retired']);
const REDIRECTION = 300;
const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;
/**
 * How long the asset's path may be redirected before that is taken as the answer it is.
 *
 * A redirect can never carry the file's digest, so this is not a wait that ends by waiting — except in
 * one window, which is why it is a wait at all: the pointer flips before every part of the host has
 * caught up, and what answers in between is the deployment before this one, which in this project is
 * the previous fixture and may be a Next.js test application that redirects everything.
 */
const REDIRECT_GRACE_MS = 30_000;
/** Asked for by the probe, and judged by it: see `probeHeaders`. */
const PROBE_ENCODING = 'identity';
const MS_PER_SECOND = 1000;

export interface DeployInput {
  /** The isolated copy of the test application the suite's harness made; the hook's own directory. */
  readonly appDir: string;
  readonly client: Client;
  readonly config: Config;
  /** Everything this says goes to standard error: standard output carries the URL and nothing else. */
  readonly log: (message: string) => void;
}

export interface Deployment {
  /** Where the suite sends its requests. */
  readonly url: string;
  readonly deploymentId: string;
  readonly runId: string;
}

/**
 * A URL-shaped string with anything before an `@` taken out, for a message that will be kept.
 *
 * Applied to what did not parse, where `URL.origin` is not available to do it properly: the only place
 * a URL can carry a credential is between `//` and `@`, so that is what goes.
 */
function withoutUserinfo(said: string): string {
  return said.replace(/\/\/[^/@]*@/u, '//…@');
}

/** The project this tool was pointed at, and where the host serves it. */
async function hostedProject(client: Client, config: Config): Promise<URL> {
  return previewUrlOf(await client.getProject(), config);
}

function previewUrlOf(detail: ProjectDetail, config: Config): URL {
  if (detail.id !== config.projectId) {
    throw new Error(`the API answered with a different project than ${config.projectId}`);
  }
  let url: URL;
  try {
    url = new URL(detail.previewUrl);
  } catch (error) {
    // `Invalid URL` on its own names neither the value nor where it came from, and this is read out of
    // a log hours later by somebody who has to decide whether the fault is theirs or the host's. What
    // is quoted is quoted without its userinfo: this log is kept, and a URL may carry a credential.
    throw new Error(`the project's URL is not a URL: ${withoutUserinfo(detail.previewUrl)}`, {
      cause: error,
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    // `origin` is the one form of a parsed URL that cannot carry a credential.
    throw new Error(`the project is not served over public HTTP(S): ${url.origin}`);
  }
  return url;
}

export async function readBundle(appDir: string): Promise<DeploymentBundle> {
  const file = path.join(appDir, BUNDLE_DIRECTORY, 'bundle.json');
  const json = await readFile(file, 'utf8');
  return deploymentBundleSchema.parse(JSON.parse(json));
}

/**
 * Replace, rather than merge: a value the fixture before this one set must not answer for this one.
 *
 * Every variable goes up as a secret. The API answers a secret's value as `null`, so a fixture's own
 * values cannot be read back out of the project by anything holding a `read` token.
 */
async function replaceEnvironment(input: DeployInput): Promise<void> {
  const env = await fixtureEnvironment(input.appDir);
  const names = Object.keys(env);
  input.log(
    `replacing the project's environment with ${String(names.length)} of the fixture's own`,
  );
  await input.client.putEnv(names.map((name) => ({ name, value: env[name] ?? '', secret: true })));
}

async function uploadMissing(
  input: DeployInput,
  bundle: DeploymentBundle,
  missing: readonly string[],
): Promise<void> {
  const named = bundleBlobs(bundle);
  const queue = [...missing];
  let uploaded = 0;
  const upload = async (): Promise<void> => {
    for (let sha256 = queue.shift(); sha256 !== undefined; sha256 = queue.shift()) {
      // That the bundle names this digest at all is worth refusing on: a request for one it does not
      // name is a request to upload a file this build never produced.
      if (!named.has(sha256)) {
        throw new Error(`the host asked for ${sha256}, which the bundle does not name`);
      }
      const bytes = await readFile(
        path.join(input.appDir, BUNDLE_DIRECTORY, BLOBS_DIRECTORY, sha256),
      );
      await input.client.putBlob(bundle.deploymentId, sha256, new Uint8Array(bytes));
      uploaded += 1;
      if (uploaded % PROGRESS_EVERY === 0 || uploaded === missing.length) {
        input.log(`  uploaded ${String(uploaded)}/${String(missing.length)} blobs`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, missing.length) }, () => upload()),
  );
}

/**
 * Whether a refusal is the API having a moment rather than an answer about the deployment.
 *
 * A `5xx` is the platform's own failure and says nothing about what was asked. The client already
 * makes a handful of attempts at one (`isServerFailure`); this is what happens when all of them are
 * spent, and these loops are polling anyway — losing a fixture that deployed perfectly well to a run
 * of bad gateways would be a failure of this tool's making. Everything else — a refusal, a validation,
 * a project that is not there — is an answer, and is not waited out. The deadline bounds both.
 */
function aMoment(error: unknown): boolean {
  return error instanceof ApiError && error.status >= SERVER_ERROR;
}

/**
 * The deployment as the API sees it, or nothing while it cannot say.
 *
 * It was registered a moment ago, by id, and the registration was answered — so a `not_found` here is
 * not an answer about this deployment, it is a read that has not caught up with the write. Polling
 * again is the whole of the response; the deadline above still ends a wait that never resolves.
 */
async function visible(
  input: DeployInput,
  deploymentId: string,
): Promise<DeploymentDetail | undefined> {
  try {
    return await input.client.getDeployment(deploymentId);
  } catch (error) {
    if (aMoment(error) || (error instanceof ApiError && error.code === 'not_found')) {
      return undefined;
    }
    throw error;
  }
}

/** What a deployment the host has finished with has to be for the suite to test it. */
function settled(input: DeployInput, deploymentId: string, detail: DeploymentDetail): void {
  if (detail.id !== deploymentId || detail.projectId !== input.config.projectId) {
    throw new Error('the API answered with a different deployment than the one uploaded');
  }
  if (detail.status !== 'active') {
    throw new Error(`the deployment ${detail.status}: ${detail.errorMessage ?? 'no detail'}`);
  }
}

/**
 * Wait for the host to finish with the deployment.
 *
 * The deadline is on a deployment that has stopped moving, not on how long the whole thing takes: every
 * step it reaches starts it over. A deployment is as long as the application is big, and a total-time
 * deadline turns a slower build into a failure reported while the host goes on to succeed. One that is
 * genuinely stuck reaches no further step, so it still gives up — and says where it was.
 */
async function waitForHost(input: DeployInput, deploymentId: string): Promise<void> {
  let deadline = Date.now() + NO_PROGRESS_TIMEOUT_MS;
  let seen: string | undefined;
  for (;;) {
    const detail = await visible(input, deploymentId);
    if (detail === undefined) {
      // The same deadline as every other kind of no progress: a deployment that is never visible is
      // a deployment that stopped moving, and a wait with no end is worse than a failure with one.
      if (Date.now() >= deadline) {
        throw new Error('the deployment was registered and never became visible');
      }
      await sleepFor(POLL_INTERVAL_MS);
      continue;
    }
    if (detail.currentStep !== seen) {
      seen = detail.currentStep;
      deadline = Date.now() + NO_PROGRESS_TIMEOUT_MS;
      input.log(`  ${seen ?? 'between steps'}`);
    }
    if (TERMINAL_STATUSES.has(detail.status)) {
      settled(input, deploymentId, detail);
      return;
    }
    if (Date.now() >= deadline) {
      const stalledOn = seen === undefined ? '' : ` on ${seen}`;
      throw new Error(`the deployment stopped making progress${stalledOn}`);
    }
    await sleepFor(POLL_INTERVAL_MS);
  }
}

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
interface Probe {
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

function probeOf(publicUrl: URL, bundle: DeploymentBundle): Probe {
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
    deploymentId: bundle.deploymentId,
  };
}

/**
 * Whether the host answered with the file the probe asked for.
 *
 * `W/` off the front of what came back: a proxy that recompresses a response may mark its `ETag` weak,
 * and a weak one still names this file. The probe asks for no encoding partly so that it rarely has to.
 */
function sameFile(sent: string | null, expected: string): boolean {
  return sent !== null && sent.replace(/^W\//u, '') === expected;
}

/**
 * What one probe saw, when it did not prove the deployment.
 *
 * `redirected` because that one is not a wait like the others. Every other thing a probe sees is a
 * deployment that may yet catch up — a `404` becomes the file, a `502` becomes an answer — but a
 * redirect is the host answering, correctly, with something that is not this file, and no amount of
 * asking again turns it into the digest. It is told apart so that it can be waited out briefly and then
 * reported for what it is, rather than polled for a quarter of an hour.
 */
interface Unproved {
  readonly said: string;
  readonly redirected: boolean;
}

async function answered(
  input: DeployInput,
  probe: Probe,
  remainingMs: number,
): Promise<Unproved | undefined> {
  // Bounded, because a connection that is accepted and then never answered would otherwise sit here
  // for ever: the deadline this is polling against is only looked at between requests.
  const within = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
  let response: Response;
  try {
    response = await fetch(probe.url, {
      method: 'HEAD',
      // The two `probeHeaders` does not leave to the runtime, sent here so that what it judged a rule's
      // conditions against is what the host is asked with.
      headers: { 'accept-encoding': PROBE_ENCODING, 'user-agent': USER_AGENT },
      // Followed by hand, not by `fetch`: where the redirect leads is not this deployment's asset, and
      // following it turns a configuration to report into whatever that destination happens to do —
      // measured, a location that does not resolve comes back as `TypeError: fetch failed`. Node gives
      // the real status and headers here, unlike a browser's opaque `0`.
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1, within)),
    });
  } catch (error) {
    return {
      said: `the request failed: ${error instanceof Error ? error.message : String(error)}`,
      redirected: false,
    };
  }
  await response.body?.cancel();
  if (probe.etag !== undefined) {
    // Whatever the status. The digest is the whole question, and nothing but this file answers it: a
    // `404` is what a bundled error document is served with, and a `304` is the file itself withheld
    // from somebody who already had it. Requiring a `2xx` as well would have waited out the deadline
    // over a file the host was already serving.
    if (sameFile(response.headers.get('etag'), probe.etag)) {
      return undefined;
    }
    const status = response.status;
    return {
      said: `HTTP ${String(status)} without the bundle's own asset behind it`,
      // A `Location` as well as a `3xx`, because the grace is about being sent elsewhere and the range
      // holds one status that is not: a `304` is the file, withheld because the asker already had it.
      // Nothing here asks conditionally, so no host should send one — and if one does, it is not a
      // configuration to report but a host to keep asking.
      redirected:
        status >= REDIRECTION && status < CLIENT_ERROR && response.headers.has('location'),
    };
  }
  // Nothing of this fixture's is being identified here — it has no asset to be identified by — so the
  // question is only whether the host is answering at all, and an answer is an answer. What the
  // application said is the suite's to judge: a route-only fixture may answer `500` on purpose, and
  // waiting out the deadline over it would stop the very test that meant to see it. Said out loud,
  // since a `5xx` here is also what a deployment that cannot start looks like.
  //
  // A redirect gets no grace on this path, deliberately: the probe is the application's own root, and
  // fixtures redirect that on purpose — a trailing slash, a locale, middleware. Failing those after
  // thirty seconds, to catch a previous deployment still answering a moment after the pointer moved,
  // would cost more than it saves where no digest can tell the two apart.
  if (response.status >= SERVER_ERROR) {
    input.log(
      `${probe.url.href} answered ${String(response.status)}; with no asset to identify this ` +
        'deployment by, the host answering at all is what counts as served',
    );
  }
  return undefined;
}

/**
 * What stands between this deployment and the suite, said in the words of what is actually wrong.
 *
 * A project that is not answering at all is worth telling apart from one that has not caught up: the
 * first is somebody's decision and waiting out the deadline tells nobody anything.
 */
async function served(
  input: DeployInput,
  detail: ProjectDetail,
  probe: Probe,
  remainingMs: number,
): Promise<Unproved | undefined> {
  if (detail.active?.deploymentId !== probe.deploymentId) {
    return { said: 'the project does not answer with this deployment yet', redirected: false };
  }
  if (detail.active.mode === 'disabled') {
    // Not an observation to wait out: nothing this tool does will turn it back on, so the deadline
    // would only be fifteen minutes of asking a question already answered.
    throw new Error(
      `${input.config.projectId} answers with this deployment but is disabled, so nothing is served`,
    );
  }
  return answered(input, probe, remainingMs);
}

/** What was proved, and what was not, once the host is answering with this deployment. */
function sayItIsServed(input: DeployInput, probe: Probe): void {
  input.log(`${probe.url.href} answers with this deployment`);
  if (probe.etag === undefined) {
    input.log(
      'no asset of this deployment could identify it — it has none, or something runs ahead of them ' +
        '— so only the host says which deployment answered',
    );
    return;
  }
  if (!probe.onlyThisBuild) {
    input.log(
      "that file is not this build's alone — a content-addressed asset is shared across deployments " +
        'on purpose, and an unchanged `public/` file is what the fixture before it served — so the ' +
        'host is still what says which deployment answered',
    );
  }
}

/** The project's own answer, waiting out an API that cannot give one yet (`aMoment`). */
async function answering(input: DeployInput, deadline: number): Promise<ProjectDetail> {
  for (;;) {
    try {
      return await input.client.getProject();
    } catch (error) {
      if (!aMoment(error)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error('the API never said what the project answers with', { cause: error });
      }
      await sleepFor(POLL_INTERVAL_MS);
    }
  }
}

/**
 * How long the probe's path has been redirected, or the end of waiting for it to stop.
 *
 * Kept as the moment it started rather than a count of tries, so that a host which redirects, answers
 * some other way, and redirects again is given the grace afresh — that is a host still settling, which
 * is the case the grace is for.
 */
function redirectedSince(probe: Probe, since: number | undefined): number {
  const started = since ?? Date.now();
  if (Date.now() - started >= REDIRECT_GRACE_MS) {
    throw new Error(
      `${probe.url.href} has redirected for ${String(REDIRECT_GRACE_MS / MS_PER_SECOND)}s instead of ` +
        "serving this deployment's own file. A redirect cannot carry the file's digest, so this is " +
        'not a wait that ends: either the project is protected, or something in front of it redirects ' +
        'static files.',
    );
  }
  return started;
}

/**
 * The settle the host was said to need (`Config.settleMs`), all of it, from the moment the probe got
 * through.
 *
 * Not from when the host first named this deployment as current, though that comes earlier and would
 * cost less: a host may name a deployment before the switch has reached any request at all, so the
 * naming is no evidence of where the switch has got to. A probe that reached the new deployment is —
 * the switch had begun by then — so the whole settle counted from there covers it, whichever of the two
 * the host did first. Why it is needed at all: suites of a full run whose received pages carried
 * Next.js's own `data-dpl-id` named an earlier fixture's deployment on some requests, while other
 * requests of the same suite reached their own.
 */
async function letItSettle(input: DeployInput): Promise<void> {
  const { settleMs } = input.config;
  if (settleMs > 0) {
    input.log(
      `letting the host settle: ${String(settleMs / MS_PER_SECOND)}s before the suite starts, so ` +
        'that every request reaches this deployment',
    );
    await sleepFor(settleMs);
  }
}

async function waitUntilServed(
  input: DeployInput,
  bundle: DeploymentBundle,
  publicUrl: URL,
): Promise<void> {
  const probe = probeOf(publicUrl, bundle);
  const deadline = Date.now() + NO_PROGRESS_TIMEOUT_MS;
  let said: string | undefined;
  let redirecting: number | undefined;
  for (;;) {
    const detail = await answering(input, deadline);
    // Validated outside that tolerance on purpose: a project that answers as a different project, or
    // with no public URL, is an answer and not a moment.
    if (previewUrlOf(detail, input.config).origin !== publicUrl.origin) {
      throw new Error('the project changed the hostname it is served on during the deployment');
    }
    const observation = await served(input, detail, probe, deadline - Date.now());
    if (observation === undefined) {
      sayItIsServed(input, probe);
      await letItSettle(input);
      return;
    }
    if (observation.said !== said) {
      input.log(observation.said);
      said = observation.said;
    }
    redirecting = observation.redirected ? redirectedSince(probe, redirecting) : undefined;
    if (Date.now() >= deadline) {
      throw new Error(`the deployment was never served: ${observation.said}`);
    }
    await sleepFor(POLL_INTERVAL_MS);
  }
}

/** What a refusal of a whole class of build should say, rather than a code and a status. */
function explained(error: unknown): unknown {
  if (error instanceof ApiError && error.code === 'unsupported_next') {
    return new Error(
      'the host does not deploy this Next.js. The suite builds with whatever the upstream checkout ' +
        'is, and the adapter supports a range (`SUPPORTED_NEXT_RANGE`) — a checkout outside it is ' +
        'refused for every fixture, not just this one.',
    );
  }
  return error;
}

export async function deployFixture(input: DeployInput): Promise<Deployment> {
  const publicUrl = await hostedProject(input.client, input.config);
  // Before the environment is replaced, not after: a build that wrote no bundle — a `next.config`
  // naming an `adapterPath` of its own, a Next.js without the hook — should not first cost the
  // project the environment of whatever was tested before it.
  const bundle = await readBundle(input.appDir);
  await replaceEnvironment(input);
  input.log(`uploading ${bundle.deploymentId} to ${input.config.projectId}`);
  let runId: string;
  try {
    const missing = await input.client.createDeployment(bundle);
    input.log(
      `registered; ${String(missing.length)} of ${String(bundleBlobs(bundle).size)} blobs to upload`,
    );
    if (missing.length > 0) {
      await uploadMissing(input, bundle, missing);
    }
    runId = await input.client.finalize(bundle.deploymentId);
  } catch (error) {
    throw explained(error);
  }
  input.log(`the host is deploying it (${runId})`);
  await waitForHost(input, bundle.deploymentId);
  await waitUntilServed(input, bundle, publicUrl);
  input.log('runtime logs are not available through the API; the deployment is left in place');
  return { url: publicUrl.origin, deploymentId: bundle.deploymentId, runId };
}

/**
 * Whether a run would get as far as its first deployment, answered without making one.
 *
 * A fixture is minutes of building before the first call to the API, so a token that cannot write, or
 * a project id that names somebody else's application, is worth learning about first. The third check
 * writes, because writing is the only way to tell a `write` token from a `read` one — the API reports
 * nothing about a token's scopes. It is a no-op by the API's own definition: a secret reads back as
 * `null`, and `null` put back keeps the value already stored, so what this puts is what it just read
 * and the project is left as it was found.
 */
export async function preflight(input: {
  readonly client: Client;
  readonly config: Config;
  readonly log: (message: string) => void;
}): Promise<void> {
  input.log(`the API: ${input.config.baseUrl}`);
  const detail = await input.client.getProject();
  const publicUrl = previewUrlOf(detail, input.config);
  // Asked here as well as while waiting to be served: a project that is off cannot serve a fixture, and
  // learning that now costs a second rather than a Next.js build and a suite of its own failures.
  if (detail.active?.mode === 'disabled') {
    throw new Error(
      `${input.config.projectId} is disabled, so nothing it is given would be served`,
    );
  }
  input.log(`${input.config.projectId} is served at ${publicUrl.origin}`);
  const env = await input.client.getEnv();
  await input.client.putEnv(env);
  input.log(
    `the token may write: ${String(env.length)} variable${env.length === 1 ? '' : 's'} put back unchanged`,
  );
  input.log('a run would replace that environment for every fixture');
}
