/**
 * Cloudflare's API as a deploy calls it, held in memory: accounts, Workers with their versions and
 * deployments, KV namespaces, R2 buckets and their objects, and D1 databases.
 *
 * It answers the way the API does where a deploy depends on it — the envelope, a 404 for what is not
 * there, a version uploaded without traffic until a deployment gives it some, a secret refused while
 * a Worker's newest version is not its deployed one — and keeps a log of every request, so a test can
 * say what was asked as well as what came of it. `fail` makes the next requests that match answer
 * with a status of the test's choosing, as Cloudflare does when it is busy or broken.
 *
 * A Worker's `workers.dev` name answers too, where the test says how (`workersDev`) and the Worker
 * is on `workers.dev` and deployed: with the version its deployment gives the traffic to, or the one
 * a request names (`cloudflare-workers-version-overrides`) where — and only where — the deployment
 * holds it, as Cloudflare routes one. A bucket may keep its objects elsewhere (`linkBucket`): in a
 * Miniflare bucket a Worker of the test writes, so the API and the Worker see the same objects.
 */

export interface FakeVersion {
  readonly id: string;
  readonly number: number;
  readonly metadata: Record<string, unknown>;
  readonly modules: readonly string[];
  readonly annotations: Readonly<Record<string, string>>;
  /** When it was uploaded, as a listing of versions dates it; none for one a test made undated. */
  readonly createdOn?: string;
}

interface Share {
  readonly version_id: string;
  readonly percentage: number;
}

export interface FakeScript {
  readonly name: string;
  readonly versions: FakeVersion[];
  readonly deployments: { readonly id: string; readonly versions: readonly Share[] }[];
  subdomain: { enabled: boolean; previews_enabled: boolean };
  migrationTag: string | undefined;
  readonly secrets: Map<string, string>;
  /** When the Worker was made, as the list of Workers says; a test sets it to age one. */
  createdOn?: string;
}

/** What answers a Worker's `workers.dev` name: the request, and the version it was routed to. */
export type WorkersDevHandler = (
  request: Request,
  version: FakeVersion,
  script: FakeScript,
) => Promise<Response> | Response;

/** A bucket's objects, kept where a test keeps them. */
export interface LinkedBucket {
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  isEmpty(): Promise<boolean>;
}

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

interface Failure {
  readonly method: string | undefined;
  /** A pattern of the path, or what the path ends with. */
  readonly path: RegExp | string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  remaining: number;
}

export interface FakeCloudflare {
  readonly fetch: typeof fetch;
  readonly requests: LoggedRequest[];
  readonly accounts: { id: string; name: string }[];
  subdomain: string | undefined;
  /**
   * Whether an upload is refused, as Cloudflare refuses one, where it binds a namespace, a bucket or
   * a database the account does not hold. Off by default: a suite that uploads Workers bound to
   * stores it never made opts out by leaving it so.
   */
  checkBindings: boolean;
  readonly scripts: Map<string, FakeScript>;
  readonly kv: Map<string, { id: string; title: string }>;
  readonly buckets: Map<string, Map<string, { bytes: Uint8Array; contentType: string }>>;
  readonly d1: Map<string, { uuid: string; name: string }>;
  /** What answers each Worker's `workers.dev` name, by the Worker's name. */
  readonly workersDev: Map<string, WorkersDevHandler>;
  /** Every request to a `workers.dev` name: its method, and its host and path. */
  readonly workersDevRequests: LoggedRequest[];
  /** Keep a bucket's objects in `store` rather than here. */
  linkBucket(name: string, store: LinkedBucket): void;
  /** Answer the next `times` requests that match — by a pattern, or by how the path ends — with `status`. */
  fail(
    match: { readonly method?: string; readonly path: RegExp | string },
    status: number,
    options?: { readonly times?: number; readonly headers?: Readonly<Record<string, string>> },
  ): void;
}

const BASE = 'https://api.cloudflare.com/client/v4';
const BASE_PATH = new URL(BASE).pathname;

function envelope(result: unknown, resultInfo?: unknown): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo !== undefined && { result_info: resultInfo }),
  });
}

function refusal(status: number, code: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status },
  );
}

function notFound(what: string): Response {
  return refusal(404, 10_007, `${what} not found`);
}

/** One route of the API: a method, a path under the account, and what it answers. */
interface Route {
  readonly method: string;
  readonly path: RegExp;
  readonly answer: (
    request: Request,
    match: RegExpExecArray,
    url: URL,
  ) => Promise<Response> | Response;
}

const OVERRIDE = /^([^=]+)="([^"]+)"$/u;

/**
 * The version a request to a Worker reaches: the one its request names, where the Worker's
 * deployment holds it — Cloudflare's version override — and the one with the largest share
 * otherwise, without a word that the named one was passed over.
 */
export function selectedVersion(script: FakeScript, request: Request): FakeVersion | undefined {
  const shares = script.deployments[0]?.versions ?? [];
  const named = OVERRIDE.exec(request.headers.get('cloudflare-workers-version-overrides') ?? '');
  const asked = named?.[1] === script.name ? named[2] : undefined;
  const held = shares.some((share) => share.version_id === asked) ? asked : undefined;
  const id =
    held ?? shares.toSorted((one, other) => other.percentage - one.percentage)[0]?.version_id;
  return script.versions.find((version) => version.id === id);
}

/** A binding's text, as a version was uploaded with it. */
export function bindingText(version: FakeVersion, name: string): string | undefined {
  const bindings = (version.metadata['bindings'] ?? []) as readonly {
    readonly name?: string;
    readonly text?: string;
  }[];
  return bindings.find((binding) => binding.name === name)?.text;
}

/** A version as a listing of versions shows it. */
function summaryOf(version: FakeVersion): Record<string, unknown> {
  return {
    id: version.id,
    number: version.number,
    annotations: version.annotations,
    ...(version.createdOn !== undefined && { metadata: { created_on: version.createdOn } }),
  };
}

/** Where the fake's clock starts: every upload is dated a second after the one before. */
const UPLOADS_FROM = Date.parse('2026-10-01T00:00:00.000Z');
const SECOND_MS = 1000;

function emptyScript(name: string): FakeScript {
  return {
    name,
    versions: [],
    deployments: [],
    subdomain: { enabled: true, previews_enabled: true },
    migrationTag: undefined,
    secrets: new Map(),
  };
}

/** How many of a Worker's newest versions a deployment can choose among. */
const DEPLOYABLE_VERSIONS = 100;

/** The items of one page of a list; all of them where the request asks for no page. */
function pageOf<T>(all: readonly T[], url: URL): readonly T[] {
  const perPage = url.searchParams.get('per_page');
  if (perPage === null) {
    return all;
  }
  const page = Number(url.searchParams.get('page') ?? '1');
  return all.slice((page - 1) * Number(perPage), page * Number(perPage));
}

/** Whether any of the values is one `matches` takes. */
function holds<T>(values: Iterable<T>, matches: (value: T) => boolean): boolean {
  for (const value of values) {
    if (matches(value)) {
      return true;
    }
  }
  return false;
}

/** A page of a list, as Cloudflare numbers pages. */
function paged(all: readonly unknown[], url: URL, defaultPerPage: number): Response {
  const page = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number(url.searchParams.get('per_page') ?? String(defaultPerPage));
  return envelope(all.slice((page - 1) * perPage, page * perPage), {
    page,
    per_page: perPage,
    total_pages: Math.max(1, Math.ceil(all.length / perPage)),
  });
}

export function fakeCloudflare(options: { readonly accountId?: string } = {}): FakeCloudflare {
  const accountId = options.accountId ?? 'account-1';
  const failures: Failure[] = [];
  let ids = 0;
  const nextId = (prefix: string): string => {
    ids += 1;
    return `${prefix}-${ids}`;
  };
  let uploads = 0;
  const uploadedOn = (): string => {
    uploads += 1;
    return new Date(UPLOADS_FROM + uploads * SECOND_MS).toISOString();
  };
  const scripts = new Map<string, FakeScript>();
  const kv = new Map<string, { id: string; title: string }>();
  const buckets = new Map<string, Map<string, { bytes: Uint8Array; contentType: string }>>();
  const d1 = new Map<string, { uuid: string; name: string }>();
  const linked = new Map<string, LinkedBucket>();
  const workersDev = new Map<string, WorkersDevHandler>();
  const workersDevRequests: LoggedRequest[] = [];
  const state: { subdomain: string | undefined; checkBindings: boolean } = {
    subdomain: 'example',
    checkBindings: false,
  };

  /** A store an upload binds that the account does not hold; nothing where it holds them all. */
  function unheld(metadata: Record<string, unknown>): string | undefined {
    const bindings = (metadata['bindings'] ?? []) as readonly {
      readonly type: string;
      readonly name: string;
      readonly namespace_id?: string;
      readonly bucket_name?: string;
      readonly id?: string;
    }[];
    const missing = bindings.find((binding) => {
      switch (binding.type) {
        case 'kv_namespace': {
          return !kv.has(binding.namespace_id ?? '');
        }
        case 'r2_bucket': {
          return !buckets.has(binding.bucket_name ?? '');
        }
        case 'd1': {
          return !d1.has(binding.id ?? '');
        }
        default: {
          return false;
        }
      }
    });
    return missing?.name;
  }

  async function versionOf(target: FakeScript, request: Request): Promise<FakeVersion | Response> {
    const form = await request.formData();
    const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as Record<
      string,
      unknown
    >;
    const binding = state.checkBindings ? unheld(metadata) : undefined;
    if (binding !== undefined) {
      return refusal(400, 10_041, `the binding ${binding} names nothing the account holds`);
    }
    const version: FakeVersion = {
      id: nextId('version'),
      number: target.versions.length + 1,
      metadata,
      modules: [...form.keys()].filter((key) => key !== 'metadata'),
      annotations: (metadata['annotations'] as Record<string, string> | undefined) ?? {},
      createdOn: uploadedOn(),
    };
    target.versions.unshift(version);
    const migrations = metadata['migrations'] as { new_tag?: string } | undefined;
    if (migrations?.new_tag !== undefined) {
      target.migrationTag = migrations.new_tag;
    }
    return version;
  }

  /** The script a route names, or the 404 Cloudflare answers for one that is not there. */
  function scriptOr(match: RegExpExecArray): FakeScript | Response {
    return scripts.get(match[1] ?? '') ?? notFound('script');
  }

  const workerRoutes: readonly Route[] = [
    {
      method: 'GET',
      path: /^\/workers\/subdomain$/u,
      answer: () => {
        return state.subdomain === undefined
          ? notFound('subdomain')
          : envelope({ subdomain: state.subdomain });
      },
    },
    {
      method: 'GET',
      path: /^\/workers\/scripts$/u,
      answer: () => {
        return envelope(
          [...scripts.values()].map((script) => {
            return {
              id: script.name,
              ...(script.createdOn !== undefined && { created_on: script.createdOn }),
            };
          }),
        );
      },
    },
    {
      method: 'POST',
      path: /^\/workers\/workers$/u,
      answer: async (request) => {
        const body = (await request.json()) as {
          name: string;
          subdomain?: FakeScript['subdomain'];
        };
        if (scripts.has(body.name)) {
          return refusal(409, 10_021, 'a Worker of that name exists');
        }
        const created = emptyScript(body.name);
        if (body.subdomain !== undefined) {
          created.subdomain = { ...body.subdomain };
        }
        scripts.set(body.name, created);
        return envelope({ id: body.name, name: body.name });
      },
    },
    {
      method: 'PUT',
      path: /^\/workers\/scripts\/([^/]+)$/u,
      answer: async (request, match) => {
        const name = match[1] ?? '';
        const target = scripts.get(name) ?? emptyScript(name);
        const version = await versionOf(target, request);
        if (version instanceof Response) {
          return version;
        }
        scripts.set(name, target);
        // The secrets the upload names, and those it keeps (`keep_bindings`) of the version before.
        const keep = version.metadata['keep_bindings'] as readonly string[] | undefined;
        if (keep?.includes('secret_text') !== true) {
          target.secrets.clear();
        }
        const bindings = (version.metadata['bindings'] ?? []) as readonly {
          readonly type: string;
          readonly name: string;
          readonly text?: string;
        }[];
        for (const binding of bindings) {
          if (binding.type === 'secret_text' && binding.text !== undefined) {
            target.secrets.set(binding.name, binding.text);
          }
        }
        target.deployments.unshift({
          id: nextId('deployment'),
          versions: [{ version_id: version.id, percentage: 100 }],
        });
        return envelope({ id: name });
      },
    },
    {
      method: 'DELETE',
      path: /^\/workers\/scripts\/([^/]+)$/u,
      answer: (_, match) => (scripts.delete(match[1] ?? '') ? envelope(null) : notFound('script')),
    },
    {
      method: 'POST',
      path: /^\/workers\/scripts\/([^/]+)\/versions$/u,
      answer: async (request, match) => {
        const target = scriptOr(match);
        if (target instanceof Response) {
          return target;
        }
        const version = await versionOf(target, request);
        if (version instanceof Response) {
          return version;
        }
        return envelope({
          id: version.id,
          number: version.number,
          annotations: version.annotations,
        });
      },
    },
    {
      method: 'GET',
      path: /^\/workers\/scripts\/([^/]+)\/versions$/u,
      answer: (_, match, url) => {
        const target = scriptOr(match);
        if (target instanceof Response) {
          return target;
        }
        // A deployment chooses among the newest hundred, which is all `deployable` lists, unpaged.
        const items =
          url.searchParams.get('deployable') === 'true'
            ? target.versions.slice(0, DEPLOYABLE_VERSIONS)
            : pageOf(target.versions, url);
        return envelope({ items: items.map((version) => summaryOf(version)) });
      },
    },
    {
      method: 'GET',
      path: /^\/workers\/scripts\/([^/]+)\/versions\/([^/]+)$/u,
      answer: (_, match) => {
        const version = scripts
          .get(match[1] ?? '')
          ?.versions.find((candidate) => candidate.id === match[2]);
        // As Cloudflare answers for one version: what it was uploaded with, under `resources`.
        return version === undefined
          ? notFound('version')
          : envelope({ ...version, resources: { bindings: version.metadata['bindings'] ?? [] } });
      },
    },
    {
      method: 'GET',
      path: /^\/workers\/scripts\/([^/]+)\/deployments$/u,
      answer: (_, match) => {
        const target = scriptOr(match);
        return target instanceof Response ? target : envelope({ deployments: target.deployments });
      },
    },
    {
      method: 'POST',
      path: /^\/workers\/scripts\/([^/]+)\/deployments$/u,
      answer: async (request, match) => {
        const target = scriptOr(match);
        if (target instanceof Response) {
          return target;
        }
        const body = (await request.json()) as { versions: Share[] };
        const named = body.versions.map((share) => share.version_id);
        const total = body.versions.reduce((sum, share) => sum + share.percentage, 0);
        const known = named.every((id) => target.versions.some((version) => version.id === id));
        // As Cloudflare refuses one: a version the Worker does not have, shares that are not all of
        // the traffic, or a version twice.
        if (!known || total !== 100 || new Set(named).size !== named.length) {
          return refusal(400, 10_219, `no deployment of ${named.join(', ')} at ${String(total)}%`);
        }
        const deployment = { id: nextId('deployment'), versions: body.versions };
        target.deployments.unshift(deployment);
        return envelope(deployment);
      },
    },
    {
      method: 'GET',
      path: /^\/workers\/scripts\/([^/]+)\/subdomain$/u,
      answer: (_, match) => {
        const target = scriptOr(match);
        return target instanceof Response ? target : envelope(target.subdomain);
      },
    },
    {
      method: 'POST',
      path: /^\/workers\/scripts\/([^/]+)\/subdomain$/u,
      answer: async (request, match) => {
        const target = scriptOr(match);
        if (target instanceof Response) {
          return target;
        }
        target.subdomain = (await request.json()) as FakeScript['subdomain'];
        return envelope(target.subdomain);
      },
    },
    {
      method: 'PUT',
      path: /^\/workers\/scripts\/([^/]+)\/secrets$/u,
      answer: async (request, match) => {
        const target = scriptOr(match);
        if (target instanceof Response) {
          return target;
        }
        // A secret is a new version deployed at once, which Cloudflare refuses while a newer one
        // waits undeployed.
        if (target.deployments[0]?.versions[0]?.version_id !== target.versions[0]?.id) {
          return refusal(400, 10_215, 'the latest version is not deployed');
        }
        const body = (await request.json()) as { name: string; text: string };
        target.secrets.set(body.name, body.text);
        return envelope({ name: body.name, type: 'secret_text' });
      },
    },
    {
      method: 'GET',
      path: /^\/workers\/services\/([^/]+)$/u,
      answer: (_, match) => {
        const target = scriptOr(match);
        if (target instanceof Response) {
          return notFound('service');
        }
        return envelope({
          default_environment: { script: { migration_tag: target.migrationTag ?? '' } },
        });
      },
    },
    { method: 'GET', path: /^\/workers\/domains$/u, answer: () => envelope([]) },
  ];

  const storageRoutes: readonly Route[] = [
    {
      method: 'GET',
      path: /^\/storage\/kv\/namespaces$/u,
      answer: (_, _match, url) => paged([...kv.values()], url, 20),
    },
    {
      method: 'POST',
      path: /^\/storage\/kv\/namespaces$/u,
      answer: async (request) => {
        const body = (await request.json()) as { title: string };
        // A title is the account's once, as a database's name and a bucket's are.
        if (holds(kv.values(), (namespace) => namespace.title === body.title)) {
          return refusal(400, 10_014, 'a namespace with this account ID and title already exists');
        }
        const namespace = { id: nextId('kv'), title: body.title };
        kv.set(namespace.id, namespace);
        return envelope(namespace);
      },
    },
    {
      method: 'DELETE',
      path: /^\/storage\/kv\/namespaces\/([^/]+)$/u,
      answer: (_, match) => (kv.delete(match[1] ?? '') ? envelope(null) : notFound('namespace')),
    },
    {
      method: 'POST',
      path: /^\/r2\/buckets$/u,
      answer: async (request) => {
        const body = (await request.json()) as { name: string };
        if (buckets.has(body.name)) {
          return refusal(409, 10_004, 'the bucket exists');
        }
        buckets.set(body.name, new Map());
        return envelope({ name: body.name });
      },
    },
    {
      method: 'GET',
      path: /^\/r2\/buckets\/([^/]+)$/u,
      answer: (_, match) => {
        const name = match[1] ?? '';
        return buckets.has(name) ? envelope({ name }) : notFound('bucket');
      },
    },
    {
      method: 'DELETE',
      path: /^\/r2\/buckets\/([^/]+)$/u,
      answer: async (_, match) => {
        const name = match[1] ?? '';
        const bucket = buckets.get(name);
        if (bucket === undefined) {
          return notFound('bucket');
        }
        const store = linked.get(name);
        if (bucket.size > 0 || (store !== undefined && !(await store.isEmpty()))) {
          return refusal(409, 10_008, 'the bucket is not empty');
        }
        buckets.delete(name);
        return envelope(null);
      },
    },
    {
      method: 'GET',
      path: /^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/u,
      answer: async (_, match) => {
        const name = match[1] ?? '';
        const store = linked.get(name);
        const object =
          store === undefined || !buckets.has(name)
            ? buckets.get(name)?.get(match[2] ?? '')
            : await store.get(match[2] ?? '');
        return object === undefined
          ? new Response('', { status: 404 })
          : new Response(object.bytes as Uint8Array<ArrayBuffer>, {
              headers: { 'content-type': object.contentType },
            });
      },
    },
    {
      method: 'PUT',
      path: /^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/u,
      answer: async (request, match) => {
        const name = match[1] ?? '';
        const bucket = buckets.get(name);
        if (bucket === undefined) {
          return notFound('bucket');
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
        const store = linked.get(name);
        if (store === undefined) {
          bucket.set(match[2] ?? '', { bytes, contentType });
        } else {
          await store.put(match[2] ?? '', bytes, contentType);
        }
        return envelope({ key: match[2] });
      },
    },
    {
      method: 'DELETE',
      path: /^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/u,
      answer: async (_, match) => {
        const name = match[1] ?? '';
        const bucket = buckets.get(name);
        if (bucket === undefined) {
          return notFound('bucket');
        }
        const store = linked.get(name);
        if (store === undefined) {
          bucket.delete(match[2] ?? '');
        } else {
          await store.delete(match[2] ?? '');
        }
        return envelope(null);
      },
    },
    {
      method: 'GET',
      path: /^\/d1\/database$/u,
      answer: (_, _match, url) => {
        const name = url.searchParams.get('name');
        const all = [...d1.values()].filter((database) => name === null || database.name === name);
        return paged(all, url, 100);
      },
    },
    {
      method: 'POST',
      path: /^\/d1\/database$/u,
      answer: async (request) => {
        const body = (await request.json()) as { name: string };
        if (holds(d1.values(), (database) => database.name === body.name)) {
          return refusal(400, 7502, 'a database with that name already exists');
        }
        const database = { uuid: nextId('d1'), name: body.name };
        d1.set(database.uuid, database);
        return envelope(database);
      },
    },
    {
      method: 'DELETE',
      path: /^\/d1\/database\/([^/]+)$/u,
      answer: (_, match) => (d1.delete(match[1] ?? '') ? envelope(null) : notFound('database')),
    },
  ];

  const routes = [...workerRoutes, ...storageRoutes];

  /** A failure a test asked for, taken off its count, where the request matches one. */
  function injected(method: string, path: string): Response | undefined {
    const failure = failures.find((candidate) => {
      return (
        candidate.remaining > 0 &&
        (candidate.method === undefined || candidate.method === method) &&
        (typeof candidate.path === 'string'
          ? path.endsWith(candidate.path)
          : candidate.path.test(path))
      );
    });
    if (failure === undefined) {
      return undefined;
    }
    failure.remaining -= 1;
    return Response.json(
      { success: false, errors: [{ code: 1, message: 'injected' }], result: null },
      { status: failure.status, headers: failure.headers },
    );
  }

  /** A request to a Worker's `workers.dev` name, answered as the test says it is. */
  async function workersDevAnswer(request: Request, url: URL): Promise<Response | undefined> {
    const suffix = `.${state.subdomain ?? ''}.workers.dev`;
    if (state.subdomain === undefined || !url.hostname.endsWith(suffix)) {
      return undefined;
    }
    const name = url.hostname.slice(0, -suffix.length);
    workersDevRequests.push({
      method: request.method,
      path: `${url.hostname}${url.pathname}`,
      query: Object.fromEntries(url.searchParams),
    });
    const script = scripts.get(name);
    const version = script === undefined ? undefined : selectedVersion(script, request);
    const handler = workersDev.get(name);
    if (handler === undefined || version === undefined || script?.subdomain.enabled !== true) {
      // What `workers.dev` answers for a name nothing is deployed to.
      return new Response('There is nothing here yet', { status: 404 });
    }
    return handler(request, version, script);
  }

  const fake: FakeCloudflare = {
    requests: [],
    workersDevRequests,
    workersDev,
    linkBucket(name, store) {
      linked.set(name, store);
    },
    accounts: [{ id: accountId, name: 'Test account' }],
    get subdomain() {
      return state.subdomain;
    },
    set subdomain(value) {
      state.subdomain = value;
    },
    get checkBindings() {
      return state.checkBindings;
    },
    set checkBindings(value) {
      state.checkBindings = value;
    },
    scripts,
    kv,
    buckets,
    d1,
    fail(match, status, failOptions = {}) {
      failures.push({
        method: match.method,
        path: match.path,
        status,
        headers: failOptions.headers ?? {},
        remaining: failOptions.times ?? 1,
      });
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!url.href.startsWith(BASE)) {
        return (
          (await workersDevAnswer(request, url)) ?? new Response('not the API', { status: 400 })
        );
      }
      const path = decodeURI(url.pathname.slice(BASE_PATH.length));
      fake.requests.push({
        method: request.method,
        path,
        query: Object.fromEntries(url.searchParams),
      });
      const failed = injected(request.method, path);
      if (failed !== undefined) {
        return failed;
      }
      if (!request.headers.has('authorization')) {
        return refusal(401, 10_000, 'Authentication error');
      }
      return answer(request, path, url);
    },
  };

  async function answer(request: Request, path: string, url: URL): Promise<Response> {
    if (path === '/accounts' && request.method === 'GET') {
      return envelope(fake.accounts, { page: 1, per_page: 50, total_pages: 1 });
    }
    const prefix = `/accounts/${accountId}`;
    if (!path.startsWith(prefix)) {
      return refusal(403, 10_000, 'Authentication error');
    }
    const rest = path.slice(prefix.length);
    for (const route of routes) {
      const match = route.method === request.method ? route.path.exec(rest) : null;
      if (match !== null) {
        return route.answer(request, match, url);
      }
    }
    return refusal(404, 7003, `no route for ${request.method} ${path}`);
  }

  return fake;
}
