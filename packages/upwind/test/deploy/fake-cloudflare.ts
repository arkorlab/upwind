/**
 * Cloudflare's API as a deploy calls it, held in memory: accounts, Workers with their versions and
 * deployments, KV namespaces, R2 buckets and their objects, and D1 databases.
 *
 * It answers the way the API does where a deploy depends on it — the envelope, a 404 for what is not
 * there, a version uploaded without traffic until a deployment gives it some, a secret refused while
 * a Worker's newest version is not its deployed one — and keeps a log of every request, so a test can
 * say what was asked as well as what came of it. `fail` makes the next requests that match answer
 * with a status of the test's choosing, as Cloudflare does when it is busy or broken.
 */

export interface FakeVersion {
  readonly id: string;
  readonly number: number;
  readonly metadata: Record<string, unknown>;
  readonly modules: readonly string[];
  readonly annotations: Readonly<Record<string, string>>;
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

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

interface Failure {
  readonly method: string | undefined;
  readonly path: RegExp;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  remaining: number;
}

export interface FakeCloudflare {
  readonly fetch: typeof fetch;
  readonly requests: LoggedRequest[];
  readonly accounts: { id: string; name: string }[];
  subdomain: string | undefined;
  readonly scripts: Map<string, FakeScript>;
  readonly kv: Map<string, { id: string; title: string }>;
  readonly buckets: Map<string, Map<string, { bytes: Uint8Array; contentType: string }>>;
  readonly d1: Map<string, { uuid: string; name: string }>;
  /** Answer the next `times` requests that match with `status`. */
  fail(
    match: { readonly method?: string; readonly path: RegExp },
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

/** A version as a listing of versions shows it. */
function summaryOf(version: FakeVersion): Record<string, unknown> {
  return { id: version.id, number: version.number, annotations: version.annotations };
}

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
  const scripts = new Map<string, FakeScript>();
  const kv = new Map<string, { id: string; title: string }>();
  const buckets = new Map<string, Map<string, { bytes: Uint8Array; contentType: string }>>();
  const d1 = new Map<string, { uuid: string; name: string }>();
  const state: { subdomain: string | undefined } = { subdomain: 'example' };

  async function versionOf(target: FakeScript, request: Request): Promise<FakeVersion> {
    const form = await request.formData();
    const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as Record<
      string,
      unknown
    >;
    const version: FakeVersion = {
      id: nextId('version'),
      number: target.versions.length + 1,
      metadata,
      modules: [...form.keys()].filter((key) => key !== 'metadata'),
      annotations: (metadata['annotations'] as Record<string, string> | undefined) ?? {},
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
        scripts.set(name, target);
        const version = await versionOf(target, request);
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
      answer: (_, match) => {
        const name = match[1] ?? '';
        const bucket = buckets.get(name);
        if (bucket === undefined) {
          return notFound('bucket');
        }
        if (bucket.size > 0) {
          return refusal(409, 10_008, 'the bucket is not empty');
        }
        buckets.delete(name);
        return envelope(null);
      },
    },
    {
      method: 'GET',
      path: /^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/u,
      answer: (_, match) => {
        const object = buckets.get(match[1] ?? '')?.get(match[2] ?? '');
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
        const bucket = buckets.get(match[1] ?? '');
        if (bucket === undefined) {
          return notFound('bucket');
        }
        bucket.set(match[2] ?? '', {
          bytes: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get('content-type') ?? 'application/octet-stream',
        });
        return envelope({ key: match[2] });
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
        candidate.path.test(path)
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

  const fake: FakeCloudflare = {
    requests: [],
    accounts: [{ id: accountId, name: 'Test account' }],
    get subdomain() {
      return state.subdomain;
    },
    set subdomain(value) {
      state.subdomain = value;
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
        return new Response('not the API', { status: 400 });
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
