import { type CloudflareClient, unlessMissing, UPLOAD_TIMEOUT_MS } from './client.ts';

/**
 * The Workers operations a deploy uses, on one account.
 *
 * A Worker has *versions* — each upload of its code and bindings — and a *deployment*, which says
 * which versions take its traffic and in what shares. `PUT …/scripts/<name>` uploads a version and
 * deploys it at once, and is the only upload that creates a Worker with code; `POST
 * …/scripts/<name>/versions` uploads one that takes no traffic until a deployment says so. A
 * deploy needs both: the second for the edge, whose new version is checked before it is made the
 * live one, and the first for whatever has no traffic to protect.
 */

export interface AccountScope {
  readonly client: CloudflareClient;
  readonly accountId: string;
}

function account(scope: AccountScope): string {
  return `/accounts/${encodeURIComponent(scope.accountId)}`;
}

function script(scope: AccountScope, name: string): string {
  return `${account(scope)}/workers/scripts/${encodeURIComponent(name)}`;
}

/** The account's `workers.dev` subdomain, or nothing when it has not chosen one. */
export async function accountSubdomain(scope: AccountScope): Promise<string | undefined> {
  const answer = await unlessMissing(
    scope.client.request<{ readonly subdomain?: string }>(
      'GET',
      `${account(scope)}/workers/subdomain`,
    ),
  );
  const subdomain = answer?.result.subdomain;
  return subdomain === undefined || subdomain === '' ? undefined : subdomain;
}

/** One of the account's Workers, as the list of them says. */
export interface ScriptSummary {
  readonly id: string;
  readonly created_on?: string;
  readonly modified_on?: string;
}

export async function listScripts(scope: AccountScope): Promise<readonly ScriptSummary[]> {
  const answer = await scope.client.request<readonly ScriptSummary[]>(
    'GET',
    `${account(scope)}/workers/scripts`,
  );
  return answer.result;
}

/** Whether a Worker answers on `workers.dev`, and whether each of its versions does at a URL of its own. */
export interface ScriptSubdomain {
  readonly enabled: boolean;
  readonly previews_enabled: boolean;
}

/**
 * A Worker with no code yet, reachable only as said: what a deploy makes before it uploads a
 * Function, so that the Function is never on `workers.dev`, not even between its upload and a
 * change of setting.
 */
export async function createWorker(
  scope: AccountScope,
  name: string,
  subdomain: ScriptSubdomain,
): Promise<void> {
  await scope.client.request('POST', `${account(scope)}/workers/workers`, {
    body: { name, subdomain },
  });
}

/** Upload a version and deploy it at once; creates the Worker where there is none. */
export async function putScript(scope: AccountScope, name: string, form: FormData): Promise<void> {
  await scope.client.request('PUT', script(scope, name), {
    body: form,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    repeatable: true,
  });
}

/** A version of a Worker, as an upload or a listing of them answers. */
export interface WorkerVersion {
  readonly id: string;
  readonly number?: number;
  readonly annotations?: Readonly<Record<string, string>>;
  readonly metadata?: {
    readonly created_on?: string;
    readonly source?: string;
  };
  /** What the version was uploaded with; in the answer for one version, not in a listing. */
  readonly resources?: {
    readonly bindings?: readonly {
      readonly type: string;
      readonly name: string;
      readonly text?: string;
    }[];
  };
}

/** Upload a version that takes no traffic until a deployment gives it some. */
export async function uploadVersion(
  scope: AccountScope,
  name: string,
  form: FormData,
): Promise<WorkerVersion> {
  const answer = await scope.client.request<WorkerVersion>(
    'POST',
    `${script(scope, name)}/versions`,
    {
      body: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    },
  );
  return answer.result;
}

/** A Worker's versions, newest first, as many of them as Cloudflare keeps listing. */
export async function listVersions(
  scope: AccountScope,
  name: string,
): Promise<readonly WorkerVersion[]> {
  const answer = await scope.client.request<{ readonly items?: readonly WorkerVersion[] }>(
    'GET',
    `${script(scope, name)}/versions`,
    { query: { deployable: true } },
  );
  return answer.result.items ?? [];
}

/** A listing asks for this many versions a page. */
const VERSIONS_PAGE = 100;
/** And reads no more than this many pages: a Worker's oldest versions are of no deployment's use. */
const MAX_VERSION_PAGES = 10;

/**
 * Every version of a Worker, newest first — those a deployment can no longer choose among as well
 * as those it can (`listVersions`) — up to `VERSIONS_PAGE` × `MAX_VERSION_PAGES` of them.
 */
export async function listAllVersions(
  scope: AccountScope,
  name: string,
): Promise<readonly WorkerVersion[]> {
  const versions: WorkerVersion[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_VERSION_PAGES; page += 1) {
    const answer = await scope.client.request<{ readonly items?: readonly WorkerVersion[] }>(
      'GET',
      `${script(scope, name)}/versions`,
      { query: { page, per_page: VERSIONS_PAGE } },
    );
    const items = answer.result.items ?? [];
    // A page of none new is the end, whether the listing pages or answers every page whole.
    const fresh = items.filter((version) => !seen.has(version.id));
    for (const version of fresh) {
      seen.add(version.id);
      versions.push(version);
    }
    if (fresh.length === 0 || items.length < VERSIONS_PAGE) {
      return versions;
    }
  }
  return versions;
}

export async function getVersion(
  scope: AccountScope,
  name: string,
  versionId: string,
): Promise<WorkerVersion> {
  const answer = await scope.client.request<WorkerVersion>(
    'GET',
    `${script(scope, name)}/versions/${encodeURIComponent(versionId)}`,
  );
  return answer.result;
}

/** A version's share of a Worker's traffic. */
export interface VersionShare {
  readonly version_id: string;
  readonly percentage: number;
}

/** Which versions take a Worker's traffic, and how much each. */
export interface WorkerDeployment {
  readonly id: string;
  readonly created_on?: string;
  readonly versions: readonly VersionShare[];
  readonly annotations?: Readonly<Record<string, string>>;
}

/** A Worker's deployments, the live one first; nothing for a Worker that does not exist. */
export async function listDeployments(
  scope: AccountScope,
  name: string,
): Promise<readonly WorkerDeployment[] | undefined> {
  const answer = await unlessMissing(
    scope.client.request<{ readonly deployments?: readonly WorkerDeployment[] }>(
      'GET',
      `${script(scope, name)}/deployments`,
    ),
  );
  return answer === undefined ? undefined : (answer.result.deployments ?? []);
}

/**
 * Give a Worker's traffic to these versions, in these shares. The message is given whole: what a
 * deploy takes of one (`args.ts`) is well inside what Cloudflare keeps.
 */
export async function createDeployment(
  scope: AccountScope,
  name: string,
  versions: readonly VersionShare[],
  message: string,
): Promise<WorkerDeployment> {
  const answer = await scope.client.request<WorkerDeployment>(
    'POST',
    `${script(scope, name)}/deployments`,
    {
      body: {
        strategy: 'percentage',
        versions,
        annotations: { 'workers/message': message },
      },
      // The same shares asked for twice are the same deployment.
      repeatable: true,
    },
  );
  return answer.result;
}

export async function getScriptSubdomain(
  scope: AccountScope,
  name: string,
): Promise<ScriptSubdomain | undefined> {
  const answer = await unlessMissing(
    scope.client.request<ScriptSubdomain>('GET', `${script(scope, name)}/subdomain`),
  );
  return answer?.result;
}

export async function setScriptSubdomain(
  scope: AccountScope,
  name: string,
  subdomain: ScriptSubdomain,
): Promise<void> {
  await scope.client.request('POST', `${script(scope, name)}/subdomain`, {
    body: subdomain,
    repeatable: true,
  });
}

/** One of a Worker's Cron Triggers, as Cloudflare lists it. */
interface Schedule {
  readonly cron: string;
}

/** The Cron Triggers a Worker fires on, as written; none for a Worker that is not there. */
export async function getSchedules(scope: AccountScope, name: string): Promise<readonly string[]> {
  const answer = await unlessMissing(
    scope.client.request<{ readonly schedules?: readonly Schedule[] }>(
      'GET',
      `${script(scope, name)}/schedules`,
    ),
  );
  return (answer?.result.schedules ?? []).map((schedule) => schedule.cron);
}

/**
 * Replace a Worker's Cron Triggers with these. They are the Worker's, not a version's: the live
 * version is invoked on them as soon as Cloudflare has them everywhere, which it says may take as
 * long as fifteen minutes.
 */
export async function putSchedules(
  scope: AccountScope,
  name: string,
  crons: readonly string[],
): Promise<void> {
  await scope.client.request('PUT', `${script(scope, name)}/schedules`, {
    body: crons.map((cron) => ({ cron })),
    repeatable: true,
  });
}

/**
 * Set one secret of a Worker. Cloudflare makes this a new version, deployed at once — and refuses
 * it while the Worker's newest version is not the deployed one, which a Worker only uploaded with
 * `PUT` never is.
 */
export async function putSecret(
  scope: AccountScope,
  name: string,
  secret: { readonly name: string; readonly text: string },
): Promise<void> {
  await scope.client.request('PUT', `${script(scope, name)}/secrets`, {
    body: { name: secret.name, text: secret.text, type: 'secret_text' },
    repeatable: true,
  });
}

/** The tag of the last Durable Object migration a Worker applied; nothing for one that applied none. */
export async function migrationTag(scope: AccountScope, name: string): Promise<string | undefined> {
  const answer = await unlessMissing(
    scope.client.request<{
      readonly default_environment?: { readonly script?: { readonly migration_tag?: string } };
    }>('GET', `${account(scope)}/workers/services/${encodeURIComponent(name)}`),
  );
  const tag = answer?.result.default_environment?.script?.migration_tag;
  return tag === undefined || tag === '' ? undefined : tag;
}

/** Delete a Worker; `force` deletes one still bound by others. Nothing to do for one that is gone. */
export async function deleteScript(
  scope: AccountScope,
  name: string,
  options: { readonly force: boolean },
): Promise<void> {
  await unlessMissing(
    scope.client.request('DELETE', script(scope, name), {
      query: { force: options.force ? true : undefined },
      repeatable: true,
    }),
  );
}

/** A hostname attached to a Worker as its own domain. */
export interface CustomDomain {
  readonly hostname: string;
  readonly service: string;
}

/** The custom domains attached to a Worker, by hand or by any tool. */
export async function listCustomDomains(
  scope: AccountScope,
  service: string,
): Promise<readonly CustomDomain[]> {
  const answer = await scope.client.request<readonly CustomDomain[]>(
    'GET',
    `${account(scope)}/workers/domains`,
    { query: { service } },
  );
  return answer.result;
}
