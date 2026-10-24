import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  appFunctions,
  type DeploymentBundle,
  deploymentBundleSchema,
  type FunctionSpec,
} from '@stayingupwind/core/bundle';

import { authLayout } from '../auth/layout.ts';
import type { DeploySettings } from './config.ts';
import { isHostBound } from './env.ts';
import { type FunctionScript, functionScripts } from './names.ts';

/**
 * What a deploy checks of a build before it reaches for an account: everything that would refuse
 * the deployment later, found while refusing it costs nothing.
 *
 * Each check is about a deployment that would *run* and be wrong — not one Cloudflare would turn
 * away, which it says itself, but one it would take and serve: a Function missing its runtime
 * cache answers every read a miss, a cron nobody fires never runs, an auth secret nobody set fails
 * the first sign-in. None of those shows until a visitor finds it.
 *
 * The limits held to are Workers Paid's, which a deployment of a Next.js application needs: on
 * Workers Free, whose limits are lower (100 Workers, 64 variables a Worker), Cloudflare refuses what
 * goes past them when it is uploaded.
 */

/** Where `upwind build` writes the deployment bundle, in the project. */
export const BUNDLE_PATH = '.arkor/bundle.json';

/** What Cloudflare holds a Worker to, unpacked — 64 MiB; `dependencies.ts` in the adapter splits by it. */
const MAX_WORKER_BYTES = 67_108_864;
/** How many variables and secrets one Worker may have on Workers Paid. */
const MAX_WORKER_VARIABLES = 128;
/** How many Workers an account may hold on Workers Paid. */
export const MAX_ACCOUNT_WORKERS = 500;
/** The project's own Workers beside its Functions: edge, cache, cache-read, prefetch, agent. */
export const PROJECT_WORKERS = 5;

/**
 * The text bindings a deploy gives every Function beside its secrets: the deployment's id, the
 * runtime, the cache's token and the response cache's lifetime (`functionBindings`), and the
 * storage manifest where the project has storage.
 */
const HOST_VARIABLES = 4;

/** The name a Worker upload's metadata part has, which no module can share (`form.ts`). */
const METADATA_PART = 'metadata';

/**
 * What the runtime cache's Function host carries (`@stayingupwind/cache`'s `function/host.ts`): a
 * Function built without it answers every cache read a miss and revalidates nothing.
 */
const CACHE_HOST_MARK = 'upwind-cache-host-artifacts-v1';

/**
 * The variables a project's auth reads its secret from where its configuration names none, any one
 * of which will do (`@stayingupwind/auth`'s `secret.ts`).
 */
const AUTH_SECRETS = ['AUTH_SECRET', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_SECRETS'];

export interface Preflight {
  readonly bundleDir: string;
  readonly bundle: DeploymentBundle;
  readonly functions: readonly FunctionScript[];
  /**
   * Workers the project holds at most, at a deploy's peak: its own, and the Functions of each kept
   * deployment, the live one, and the one being deployed.
   */
  readonly projectedWorkers: number;
  /** Every reason the deployment would be refused, in the order found. */
  readonly problems: readonly string[];
  /** What may be wrong, where the build cannot say whether it is. */
  readonly warnings: readonly string[];
}

/** The bundle a build left, read and held to its schema. */
export async function readBundle(projectDir: string): Promise<{
  readonly bundleDir: string;
  readonly bundle: DeploymentBundle;
}> {
  const bundleFile = path.join(projectDir, BUNDLE_PATH);
  const bundleDir = path.dirname(bundleFile);
  let raw: string;
  try {
    raw = await readFile(bundleFile, 'utf8');
  } catch {
    throw new Error(
      `${BUNDLE_PATH} is not in ${projectDir}; build first (\`upwind deploy --build-only\`), or deploy without --prebuilt`,
    );
  }
  const parsed = deploymentBundleSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new Error(
      `${BUNDLE_PATH} is not a deployment bundle this version reads: ${parsed.error.message}`,
    );
  }
  return { bundleDir, bundle: parsed.data };
}

function functionBytes(spec: FunctionSpec): number {
  let total = 0;
  for (const module of spec.modules) {
    total += module.blob.byteLength;
  }
  return total;
}

/** Whether any module of the Function carries the cache host's mark. */
async function carriesCacheHost(bundleDir: string, spec: FunctionSpec): Promise<boolean> {
  for (const module of spec.modules) {
    if (module.type !== 'esm' && module.type !== 'commonjs') {
      continue;
    }
    const text = await readFile(path.join(bundleDir, 'blobs', module.blob.sha256), 'utf8');
    if (text.includes(CACHE_HOST_MARK)) {
      return true;
    }
  }
  return false;
}

interface CheckInput {
  readonly projectDir: string;
  readonly settings: DeploySettings;
  readonly secrets: ReadonlyMap<string, string>;
}

/** What the build has that this command cannot run yet: workflows, Durable Objects, crons, gates. */
function unsupported(bundle: DeploymentBundle, settings: DeploySettings): string[] {
  const problems: string[] = [];
  if (bundle.functions.workflow !== undefined) {
    problems.push(
      'the build runs workflows, and a self-hosted deployment runs no workflow World yet',
    );
  }
  const objects = new Set((bundle.durableObjects ?? []).map((object) => object.name));
  const built = bundle.functions.durableObjects;
  if (built !== undefined) {
    for (const name of Object.keys(built)) {
      objects.add(name);
    }
  }
  if (objects.size > 0) {
    problems.push(
      `the build has Durable Objects of its own (${[...objects].join(', ')}), which a self-hosted deployment does not bind yet`,
    );
  }
  if (settings.crons > 0 || (bundle.crons?.length ?? 0) > 0) {
    problems.push(
      'the project declares cron jobs, and a self-hosted deployment fires none yet — remove them, or they would silently never run',
    );
  }
  if (bundle.gates !== undefined) {
    problems.push(
      'the build declares route gates, which `upwind deploy` does not bind yet; deploy it with a host that binds those gates',
    );
  }
  return problems;
}

/** Storage named as one of the host's own bindings, which a Function cannot be given twice. */
function clashing(settings: DeploySettings): string[] {
  const taken = settings.storage.map((binding) => binding.name).filter((name) => isHostBound(name));
  return taken.length === 0
    ? []
    : [
        `deploy.storage names ${taken.join(', ')}, which the host binds in every Function itself; give the storage another name`,
      ];
}

/** What Cloudflare would refuse of a Function, or take and break: its size, its variables, a module's name. */
function beyondLimits(bundle: DeploymentBundle, input: CheckInput): string[] {
  const problems: string[] = [];
  const variables =
    HOST_VARIABLES + input.secrets.size + (input.settings.storage.length > 0 ? 1 : 0);
  if (variables > MAX_WORKER_VARIABLES) {
    problems.push(
      `each Function would hold ${variables} variables and secrets, over the ${MAX_WORKER_VARIABLES} a Worker may on Workers Paid`,
    );
  }
  const specs: (readonly [string, FunctionSpec])[] = [...appFunctions(bundle)];
  if (bundle.functions.middleware !== undefined) {
    specs.push(['middleware', bundle.functions.middleware]);
  }
  for (const [name, spec] of specs) {
    if (spec.modules.some((module) => module.name === METADATA_PART)) {
      problems.push(
        `the ${name} Function has a module called \`${METADATA_PART}\`, which a Worker's upload keeps for its own configuration`,
      );
    }
    const bytes = functionBytes(spec);
    if (bytes > MAX_WORKER_BYTES) {
      problems.push(
        `the ${name} Function is ${bytes} bytes, over the ${MAX_WORKER_BYTES} a Worker may be`,
      );
    }
  }
  return problems;
}

/** What the deployment would run and get wrong: a cache it cannot reach. */
async function wrongAtRuntime(bundleDir: string, bundle: DeploymentBundle): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, spec] of appFunctions(bundle)) {
    if (!(await carriesCacheHost(bundleDir, spec))) {
      problems.push(
        `the ${name} Function was built without the runtime cache's host, so it would answer every cache read a miss; build it with \`upwind deploy\` or \`upwind deploy --build-only\``,
      );
    }
  }
  return problems;
}

/**
 * What may be wrong at runtime, where only the project's code knows whether it is: a sign-in with
 * no secret in the environment, which is right where the project's auth configuration names its
 * own. An empty value is no secret, as the auth package reads it.
 */
function mayBeWrong(input: CheckInput): string[] {
  const signsIn = authLayout(input.projectDir) !== undefined;
  const given = AUTH_SECRETS.some((name) => (input.secrets.get(name) ?? '') !== '');
  return signsIn && !given
    ? [
        `the project signs users in, and none of ${AUTH_SECRETS.join(', ')} is among the secrets with a value; unless its auth configuration names its secret itself, sign-in will refuse to answer — name one in deploy.secrets or an --env-file`,
      ]
    : [];
}

/** Every reason this build, deployed with these settings, would be wrong. */
export async function preflight(input: CheckInput): Promise<Preflight> {
  const { settings } = input;
  const { bundleDir, bundle } = await readBundle(input.projectDir);
  const problems: string[] = [];
  if (!settings.workersDev && settings.hostnames.length === 0) {
    problems.push(
      'deploy.workersDev is false and deploy.hostnames names nothing, so nothing would reach the edge',
    );
  }
  problems.push(
    ...unsupported(bundle, settings),
    ...clashing(settings),
    ...beyondLimits(bundle, input),
    ...(await wrongAtRuntime(bundleDir, bundle)),
  );
  const functions = functionScripts(settings.project, bundle);
  // At a deploy's peak: the deployments kept and the live one are all still there while the new
  // one's Functions are uploaded, and the oldest of them go only once the new one is live.
  const projectedWorkers = functions.length * (settings.keep + 2) + PROJECT_WORKERS;
  if (projectedWorkers > MAX_ACCOUNT_WORKERS) {
    problems.push(
      `keeping ${settings.keep} deployments of ${functions.length} Functions each would take ${projectedWorkers} Workers, over the ${MAX_ACCOUNT_WORKERS} an account on Workers Paid may hold; lower deploy.keep`,
    );
  }
  return { bundleDir, bundle, functions, projectedWorkers, problems, warnings: mayBeWrong(input) };
}
