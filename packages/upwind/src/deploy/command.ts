import { type AccountView, readAccount, resolveAccount } from './account.ts';
import type { DeployOptions } from './args.ts';
import { buildForDeploy, readBuildNote } from './build.ts';
import { createCloudflareClient } from './cloudflare/client.ts';
import { type DeploySettings, readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';
import { readSecrets, reservedNames } from './env.ts';
import { projectNames } from './names.ts';
import { MAX_ACCOUNT_WORKERS, type Preflight, preflight } from './preflight.ts';

/**
 * `upwind deploy`, as far as this version goes: build for a deploy, check the build and the account,
 * and say what a deploy would do.
 *
 * The order is the one a deploy keeps when it goes further. Nothing that reaches the account comes
 * before everything that can be refused without it, and the project's own code — its configuration
 * and its build — runs only after the credentials were taken out of the environment (`cli.ts`).
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

/** The account's Workers other than the project's, and how many it would hold with the project's at most. */
function workersOf(plan: Preflight, account: AccountView): { others: number; total: number } {
  const others = account.workers - account.projectWorkers.length;
  return { others, total: others + plan.projectedWorkers };
}

/**
 * What the account cannot take: more Workers than it may hold, counting the ones it has of others.
 * More than the project's alone would hold is the plan's problem already (`preflight`).
 */
function capacityProblems(plan: Preflight, account: AccountView): string[] {
  const { others, total } = workersOf(plan, account);
  if (plan.projectedWorkers > MAX_ACCOUNT_WORKERS || total <= MAX_ACCOUNT_WORKERS) {
    return [];
  }
  return [
    `the account holds ${others} Workers besides this project's, and with this project's at most it would hold ${total}, over the ${MAX_ACCOUNT_WORKERS} an account on Workers Paid may; lower deploy.keep or --keep, or delete Workers the account no longer needs`,
  ];
}

function describeAccount(plan: Preflight, account: AccountView): void {
  const { total } = workersOf(plan, account);
  line(
    `account ${account.accountId}: ${account.workers} Workers, ${account.projectWorkers.length} of them this project's; with this project's at most, ${total} of ${MAX_ACCOUNT_WORKERS}`,
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
  describeAccount(plan, account);
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

/** What a run reaches Cloudflare with; a test gives it a fake. */
export interface DeployIo {
  readonly fetch?: typeof fetch | undefined;
}

async function accountOf(
  credentials: CloudflareCredentials | undefined,
  settings: DeploySettings,
  io: DeployIo,
): Promise<AccountView | undefined> {
  if (credentials === undefined) {
    return undefined;
  }
  const client = createCloudflareClient({ apiToken: credentials.apiToken, fetch: io.fetch });
  const accountId = await resolveAccount(client, credentials.accountId);
  return readAccount({ client, accountId }, projectNames(settings.project));
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
  const account = await accountOf(credentials, settings, io);
  describePlan({ plan, settings, secrets, account });
  for (const warning of plan.warnings) {
    console.warn(`upwind: warning: ${warning}`);
  }
  const problems = [
    ...plan.problems,
    ...(account === undefined ? [] : [...account.problems, ...capacityProblems(plan, account)]),
  ];
  if (problems.length > 0) {
    const things = plural(problems.length, 'one thing stops', `${problems.length} things stop`);
    console.error(`upwind: ${things} this deployment:`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    return 1;
  }
  if (!options.dryRun) {
    console.error(
      'upwind: this version of `upwind deploy` plans a deployment and stops there; run it with --dry-run',
    );
    return 1;
  }
  return 0;
}
