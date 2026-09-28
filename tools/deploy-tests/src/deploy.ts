import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';

import {
  bundleBlobs,
  type DeploymentBundle,
  deploymentBundleSchema,
} from '@stayingupwind/core/bundle';

import { ApiError, type Client, type DeploymentDetail, type ProjectDetail } from './client.ts';
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

const BUNDLE_DIRECTORY = '.ppr-cdn';
const BLOBS_DIRECTORY = 'blobs';
const UPLOAD_CONCURRENCY = 8;
const POLL_INTERVAL_MS = 3000;
/** How long a deployment may go without reaching a further step before it is taken to be stuck. */
const NO_PROGRESS_TIMEOUT_MS = 900_000;
const PROGRESS_EVERY = 25;
const TERMINAL_STATUSES = new Set(['active', 'failed', 'retired']);
const SERVER_ERROR = 500;

export interface DeployInput {
  /** The isolated copy of the test application the suite's harness made; the hook's own directory. */
  readonly appDir: string;
  readonly client: Client;
  readonly config: Config;
  /** Everything this says goes to standard error: standard output carries the URL and nothing else. */
  readonly log: (message: string) => void;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface Deployment {
  /** Where the suite sends its requests. */
  readonly url: string;
  readonly deploymentId: string;
  readonly runId: string;
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
    // a log hours later by somebody who has to decide whether the fault is theirs or the host's.
    throw new Error(`the project's URL is not a URL: ${detail.previewUrl}`, { cause: error });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new Error(`the project is not served over public HTTP(S): ${detail.previewUrl}`);
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
  const now = input.now ?? Date.now;
  const wait = input.sleep ?? ((ms: number): Promise<void> => sleepFor(ms));
  let deadline = now() + NO_PROGRESS_TIMEOUT_MS;
  let seen: string | undefined;
  for (;;) {
    const detail = await visible(input, deploymentId);
    if (detail === undefined) {
      // The same deadline as every other kind of no progress: a deployment that is never visible is
      // a deployment that stopped moving, and a wait with no end is worse than a failure with one.
      if (now() >= deadline) {
        throw new Error('the deployment was registered and never became visible');
      }
      await wait(input.pollIntervalMs ?? POLL_INTERVAL_MS);
      continue;
    }
    if (detail.currentStep !== seen) {
      seen = detail.currentStep;
      deadline = now() + NO_PROGRESS_TIMEOUT_MS;
      input.log(`  ${seen ?? 'between steps'}`);
    }
    if (TERMINAL_STATUSES.has(detail.status)) {
      settled(input, deploymentId, detail);
      return;
    }
    if (now() >= deadline) {
      const stalledOn = seen === undefined ? '' : ` on ${seen}`;
      throw new Error(`the deployment stopped making progress${stalledOn}`);
    }
    await wait(input.pollIntervalMs ?? POLL_INTERVAL_MS);
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
function probeOf(publicUrl: URL, bundle: DeploymentBundle): { url: URL; etag: string | undefined } {
  const file =
    bundle.staticFiles.find((entry) => entry.pathname.includes(`/${bundle.buildId}/`)) ??
    bundle.staticFiles.find((entry) => entry.immutable) ??
    bundle.staticFiles[0];
  const url = new URL(publicUrl.origin);
  // Assigned rather than resolved, so that a fixture's `//path` stays on this host.
  url.pathname = file?.pathname ?? (bundle.config.basePath || '/');
  return { url, etag: file === undefined ? undefined : `"${file.blob.sha256}"` };
}

async function answered(
  input: DeployInput,
  probe: { url: URL; etag: string | undefined },
): Promise<string | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(probe.url, { method: 'HEAD', redirect: 'manual' });
  } catch (error) {
    return `the request failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  await response.body?.cancel();
  if (probe.etag !== undefined) {
    return response.ok && response.headers.get('etag') === probe.etag
      ? undefined
      : `HTTP ${String(response.status)} without the bundle's own asset behind it`;
  }
  // Nothing of this fixture's is being identified here — it has no static file — so the question is
  // only whether the host is answering at all, and an answer is an answer. What the application said
  // is the suite's to judge: a route-only fixture may answer `500` on purpose, and waiting out the
  // deadline over it would stop the very test that meant to see it. Said out loud, since a `5xx` here
  // is also what a deployment that cannot start looks like.
  if (response.status >= SERVER_ERROR) {
    input.log(
      `${probe.url.href} answered ${String(response.status)}; with no static file to identify this ` +
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
  bundle: DeploymentBundle,
  probe: { url: URL; etag: string | undefined },
): Promise<string | undefined> {
  if (detail.active?.deploymentId !== bundle.deploymentId) {
    return 'the project does not answer with this deployment yet';
  }
  if (detail.active.mode === 'disabled') {
    // Not an observation to wait out: nothing this tool does will turn it back on, so the deadline
    // would only be fifteen minutes of asking a question already answered.
    throw new Error(
      `${input.config.projectId} answers with this deployment but is disabled, so nothing is served`,
    );
  }
  return answered(input, probe);
}

/** What was proved, and what was not, once the host is answering with this deployment. */
function sayItIsServed(input: DeployInput, probe: { url: URL; etag: string | undefined }): void {
  input.log(`${probe.url.href} answers with this deployment`);
  if (probe.etag === undefined) {
    input.log('this fixture has no static file, so only the host says which deployment answered');
  }
}

/** The project's own answer, or nothing while the API cannot give one (`aMoment`). */
async function answering(input: DeployInput): Promise<ProjectDetail | undefined> {
  try {
    return await input.client.getProject();
  } catch (error) {
    if (aMoment(error)) {
      return undefined;
    }
    throw error;
  }
}

async function waitUntilServed(
  input: DeployInput,
  bundle: DeploymentBundle,
  publicUrl: URL,
): Promise<void> {
  const now = input.now ?? Date.now;
  const wait = input.sleep ?? ((ms: number): Promise<void> => sleepFor(ms));
  const probe = probeOf(publicUrl, bundle);
  const deadline = now() + NO_PROGRESS_TIMEOUT_MS;
  let said: string | undefined;
  for (;;) {
    const detail = await answering(input);
    if (detail === undefined) {
      if (now() >= deadline) {
        throw new Error('the API never said what the project answers with');
      }
      await wait(input.pollIntervalMs ?? POLL_INTERVAL_MS);
      continue;
    }
    // Validated outside that tolerance on purpose: a project that answers as a different project, or
    // with no public URL, is an answer and not a moment.
    if (previewUrlOf(detail, input.config).origin !== publicUrl.origin) {
      throw new Error('the project changed the hostname it is served on during the deployment');
    }
    const observation = await served(input, detail, bundle, probe);
    if (observation === undefined) {
      sayItIsServed(input, probe);
      return;
    }
    if (observation !== said) {
      input.log(observation);
      said = observation;
    }
    if (now() >= deadline) {
      throw new Error(`the deployment was never served: ${observation}`);
    }
    await wait(input.pollIntervalMs ?? POLL_INTERVAL_MS);
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
  const publicUrl = await hostedProject(input.client, input.config);
  input.log(`${input.config.projectId} is served at ${publicUrl.origin}`);
  const env = await input.client.getEnv();
  await input.client.putEnv(env);
  input.log(
    `the token may write: ${String(env.length)} variable${env.length === 1 ? '' : 's'} put back unchanged`,
  );
  input.log('a run would replace that environment for every fixture');
}
