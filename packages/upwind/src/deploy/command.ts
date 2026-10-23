import { type AccountView, readAccount, resolveAccount } from './account.ts';
import type { DeployOptions } from './args.ts';
import { buildForDeploy, readBuildNote } from './build.ts';
import { createCloudflareClient } from './cloudflare/client.ts';
import type { AccountScope } from './cloudflare/workers.ts';
import { type DeploySettings, readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';
import { deployToAccount } from './deploy-run.ts';
import { readSecrets, reservedNames } from './env.ts';
import { projectNames } from './names.ts';
import { MAX_ACCOUNT_WORKERS, type Preflight, preflight } from './preflight.ts';

/**
 * `upwind deploy`: build for a deploy, check the build and the account and say what a deploy will
 * do — and then, unless `--dry-run` says to stop there, do it (`deploy-run.ts`).
 *
 * Nothing that reaches the account comes before everything that can be refused without it, and the
 * project's own code — its configuration and its build — runs only after the credentials were taken
 * out of the environment (`cli.ts`).
 */

function line(text: string): void {
  console.log(`  ${text}`);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Where the deployment would be reached, as far as the account says. */
function reachedAt(settings: DeploySettings, account: AccountView | undefined): string[] {
  const edge = projectNames(settings.project).edge;
  const reached: string[] = [];
  if (settings.workersDev) {
    const subdomain = account?.subdomain;
    reached.push(
      subdomain === undefined
        ? `${edge} on workers.dev`
        : `https://${edge}.${subdomain}.workers.dev`,
    );
  }
  for (const hostname of settings.hostnames) {
    reached.push(`https://${hostname}`);
  }
  return reached;
}

/** How many Workers the account would hold, counted two ways (`workersOf`). */
interface WorkerCount {
  /** The account's Workers other than the project's. */
  readonly others: number;
  /**
   * What this deploy holds at its peak: every Worker on the account now, the project's among them,
   * with the new build's Functions and whatever of the project's own Workers is not there yet. The
   * deployments kept now keep their Functions until the new one is live, however many each has.
   */
  readonly peak: number;
  /** What a deploy of this build's size holds at most, once older deployments are down to `keep`. */
  readonly steady: number;
}

function workersOf(plan: Preflight, settings: DeploySettings, account: AccountView): WorkerCount {
  const present = new Set(account.projectWorkers);
  const names = projectNames(settings.project);
  const own = [names.edge, names.cache, names.cacheRead, names.prefetch, names.agent];
  // A Worker already there is counted once: a run of a deployment stopped part way has some of its
  // Functions on the account, and the project's own Workers are there after its first deploy.
  const added = [...plan.functions.map((script) => script.scriptName), ...own].filter(
    (name) => !present.has(name),
  );
  const others = account.workers - account.projectWorkers.length;
  return {
    others,
    peak: account.workers + added.length,
    steady: others + plan.projectedWorkers,
  };
}

/**
 * What the account cannot take: more Workers than it may hold, at this deploy's peak or once a
 * deploy of this size has cleaned up. More than the project's alone would hold is the plan's problem
 * already (`preflight`).
 */
function capacityProblems(
  plan: Preflight,
  settings: DeploySettings,
  account: AccountView,
): string[] {
  const { others, peak, steady } = workersOf(plan, settings, account);
  const problems: string[] = [];
  if (peak > MAX_ACCOUNT_WORKERS) {
    problems.push(
      `the account holds ${account.workers} Workers, ${account.projectWorkers.length} of them this project's, and this deploy would bring it to ${peak} before it cleans any up, over the ${MAX_ACCOUNT_WORKERS} an account on Workers Paid may: the deployments kept now keep their Functions until the new one is live; delete Workers the account no longer needs`,
    );
  }
  if (plan.projectedWorkers <= MAX_ACCOUNT_WORKERS && steady > MAX_ACCOUNT_WORKERS) {
    problems.push(
      `the account holds ${others} Workers besides this project's, and with this project's at most it would hold ${steady}, over the ${MAX_ACCOUNT_WORKERS} an account on Workers Paid may; lower deploy.keep or --keep, or delete Workers the account no longer needs`,
    );
  }
  return problems;
}

function describeAccount(plan: Preflight, settings: DeploySettings, account: AccountView): void {
  const { peak, steady } = workersOf(plan, settings, account);
  line(
    `account ${account.accountId}: ${account.workers} Workers, ${account.projectWorkers.length} of them this project's; with this project's at most, ${Math.max(peak, steady)} of ${MAX_ACCOUNT_WORKERS}`,
  );
  const shares = account.live?.versions.map(
    (share) => `${share.version_id} at ${String(share.percentage)}%`,
  );
  line(
    shares === undefined
      ? 'live: nothing yet; this would be the first deployment'
      : `live: ${shares.join(', ')}`,
  );
}

function describePlan(input: {
  readonly plan: Preflight;
  readonly settings: DeploySettings;
  readonly secrets: ReadonlyMap<string, string>;
  readonly account: AccountView | undefined;
}): void {
  const { plan, settings, secrets, account } = input;
  console.log(`upwind: ${settings.project}, deployment ${plan.bundle.deploymentId}`);
  const functions = plan.functions.map((script) => `${script.name} as ${script.scriptName}`);
  line(`Functions: ${functions.join(', ')}`);
  const kept = plural(settings.keep, 'deployment', 'deployments');
  line(
    `Workers: up to ${plan.projectedWorkers} for this project, keeping ${settings.keep} ${kept} to roll back to`,
  );
  if (settings.storage.length > 0) {
    const storage = settings.storage.map((binding) => `${binding.name} (${binding.kind})`);
    line(`storage: ${storage.join(', ')}`);
  }
  if (secrets.size > 0) {
    // Names only: a plan is printed to logs, and a secret's value is never anyone's to read there.
    line(`secrets: ${[...secrets.keys()].join(', ')}`);
  }
  line(`reached at: ${reachedAt(settings, account).join(', ')}`);
  if (account === undefined) {
    line('account: not read, since CLOUDFLARE_API_TOKEN is not set');
    return;
  }
  describeAccount(plan, settings, account);
}

/**
 * The build to deploy: one made now, or the one `--prebuilt` names, which has to be one a deploy
 * built. Nothing where there is none to go on with — a failed build, or a build that stops there.
 */
async function buildToDeploy(options: DeployOptions): Promise<number | undefined> {
  if (options.prebuilt) {
    if ((await readBuildNote(options.projectDir)) !== undefined) {
      return undefined;
    }
    console.error(
      'upwind: --prebuilt deploys what `upwind deploy --build-only` built, and nothing it built is here; build with it first',
    );
    return 1;
  }
  const built = await buildForDeploy(options.projectDir);
  if ('exitCode' in built) {
    return built.exitCode;
  }
  if (options.buildOnly) {
    console.log(`upwind: built ${built.deploymentId}; deploy it with \`upwind deploy --prebuilt\``);
    return 0;
  }
  return undefined;
}

/** Whether the bundle is the one the deploy's own build note names; said where it is not. */
async function isNotedBuild(options: DeployOptions, plan: Preflight): Promise<boolean> {
  const noted = (await readBuildNote(options.projectDir))?.deploymentId;
  if (noted === plan.bundle.deploymentId) {
    return true;
  }
  console.error(
    `upwind: the bundle in ${options.projectDir} is ${plan.bundle.deploymentId}, and the deploy build note names ${noted ?? 'none'}; build it again with \`upwind deploy --build-only\``,
  );
  return false;
}

/** What a run reaches Cloudflare with, and waits with; a test gives it fakes. */
export interface DeployIo {
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

async function scopeOf(
  credentials: CloudflareCredentials | undefined,
  io: DeployIo,
): Promise<AccountScope | undefined> {
  if (credentials === undefined) {
    return undefined;
  }
  const client = createCloudflareClient({ apiToken: credentials.apiToken, fetch: io.fetch });
  return { client, accountId: await resolveAccount(client, credentials.accountId) };
}

/** What `upwind deploy` exits with. */
export async function runDeploy(
  options: DeployOptions,
  credentials: CloudflareCredentials | undefined,
  io: DeployIo = {},
): Promise<number> {
  const settings = await readDeploySettings(options.projectDir, { keep: options.keep });
  const stopped = await buildToDeploy(options);
  if (stopped !== undefined) {
    return stopped;
  }
  const secrets = await readSecrets({
    files: options.envFiles,
    names: settings.secrets,
    env: process.env,
    reserved: reservedNames(settings.storage),
  });
  const plan = await preflight({ projectDir: options.projectDir, settings, secrets });
  if (!(await isNotedBuild(options, plan))) {
    return 1;
  }
  const names = projectNames(settings.project);
  const scope = await scopeOf(credentials, io);
  const inspect = (account: AccountView | undefined): number | undefined => {
    describePlan({ plan, settings, secrets, account });
    for (const warning of plan.warnings) {
      console.warn(`upwind: warning: ${warning}`);
    }
    const problems = [
      ...plan.problems,
      ...(account === undefined
        ? []
        : [...account.problems, ...capacityProblems(plan, settings, account)]),
    ];
    if (problems.length > 0) {
      const things = plural(problems.length, 'one thing stops', `${problems.length} things stop`);
      console.error(`upwind: ${things} this deployment:`);
      for (const problem of problems) {
        console.error(`  - ${problem}`);
      }
      return 1;
    }
    if (options.dryRun) {
      return 0;
    }
    if (scope === undefined || account === undefined) {
      console.error(
        'upwind: a deploy reaches the account with CLOUDFLARE_API_TOKEN, which is not set',
      );
      return 1;
    }
    return undefined;
  };
  if (options.dryRun || scope === undefined) {
    const account = scope === undefined ? undefined : await readAccount(scope, names);
    return inspect(account) ?? 0;
  }
  // The deploy acquires exclusion before reading the view checked above, and keeps it through
  // provisioning, activation and retention, including the agent's cleanup.
  return deployToAccount(
    {
      scope,
      settings,
      plan,
      secrets,
      message: options.message,
      resetCacheKey: options.resetCacheKey,
      ...io,
    },
    inspect,
  );
}
