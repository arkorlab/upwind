import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * The host `check.ts` deploys into: the six calls of the public API this tool uses, the application's
 * readiness file, and its root page — enough of a host to run the three hooks against, and strict about
 * the order the calls come in.
 */

const OK = 200;
const CREATED = 201;
const ACCEPTED = 202;
const CONFLICT = 409;
const NOT_FOUND = 404;
const SERVICE_UNAVAILABLE = 503;
/** What the root page says on each request of a `moves` host, the last repeated from then on. */
const PAGE_SEQUENCE = ['a moment', 'the deployment before', 'a moment', 'this deployment'] as const;

export interface FakeHost {
  readonly port: number;
  /** What the bundle said its build id was, as the registration carried it. */
  readonly registered: () => string | undefined;
  /** The deployment's environment as it was replaced, names and values. */
  readonly environment: () => Record<string, string>;
  /** The digests that were uploaded, in the order they arrived. */
  readonly uploaded: () => string[];
  /** Whatever this host refused, because it was asked out of order. */
  readonly refusals: () => string[];
  /** When this host's root page first named this deployment rather than the one before. */
  readonly namedAt: () => number | undefined;
  close: () => void;
}

/**
 * What the application's root page does once the deployment is finalized.
 *
 * `moves`: what a host that brings a deployment in place by place looks like from outside — the file the
 * probe asks for is already the new deployment's, while the page goes through everything a page can say
 * on the way: an error before anything (a moment, to be asked again rather than given up on), the
 * deployment before (named in it, as Next.js names every page it renders), an error again (silence, which
 * must not be taken for the switch), and at last this deployment's own `404`, which names it as well as
 * any page would. `names nobody`: a root that answers without the mark, which leaves the probe as the only
 * evidence there is.
 */
type PageBehaviour = 'moves' | 'names nobody';

/**
 * A host that answers the six calls this tool makes, and nothing else — in order.
 *
 * The order is half of what is being checked, so it is a host that refuses out of it: no upload before
 * a registration, no finalize before every blob it asked for, no polling before a finalize. A refusal
 * here fails the check with the call that made it, rather than passing because a fake host was willing
 * to answer anything.
 */
export async function fakeHost(
  deploymentId: string,
  page: PageBehaviour = 'moves',
): Promise<FakeHost> {
  let registered: string | undefined;
  let environment: Record<string, string> = {};
  let wanted: string[] = [];
  /** The application's one static file, learned at registration: where it is and what it hashes to. */
  let asset: { pathname: string; sha256: string } | undefined;
  const uploaded: string[] = [];
  const refusals: string[] = [];
  let finalized = false;
  let namedAt: number | undefined;
  /** How many times the page has been asked for; the first answer is the deployment before. */
  let pages = 0;
  let port = 0;

  /** Refuse, and remember: the check reads these back rather than trusting a status alone. */
  function outOfOrder(said: string): { status: number; body: unknown } {
    refusals.push(said);
    return {
      status: CONFLICT,
      body: { ok: false, error: { code: 'deployment_conflict', message: said } },
    };
  }

  async function body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  /** The deployment's own half of the protocol: registered, uploaded into, finalized, then polled. */
  function aboutTheDeployment(pathname: string, method: string): { status: number; body: unknown } {
    const blob = /\/blobs\/(?<sha256>[0-9a-f]{64})$/u.exec(pathname)?.groups?.['sha256'];
    if (blob !== undefined && method === 'PUT') {
      if (registered === undefined) {
        return outOfOrder('a blob arrived before the deployment was registered');
      }
      uploaded.push(blob);
      return { status: OK, body: { sha256: blob } };
    }
    if (pathname.endsWith('/finalize')) {
      const missing = wanted.filter((sha256) => !uploaded.includes(sha256));
      if (registered === undefined || missing.length > 0) {
        return outOfOrder(`a finalize arrived with ${String(missing.length)} blobs still missing`);
      }
      finalized = true;
      return { status: ACCEPTED, body: { run: { id: 'run_checked' } } };
    }
    if (pathname.endsWith(deploymentId)) {
      if (!finalized) {
        return outOfOrder('the deployment was polled before it was finalized');
      }
      return {
        status: OK,
        body: {
          deployment: { id: deploymentId, projectId: 'p', status: 'active' },
          run: { currentStep: 'activate' },
        },
      };
    }
    return {
      status: NOT_FOUND,
      body: { ok: false, error: { code: 'not_found', message: 'nothing here' } },
    };
  }

  /**
   * The application's own root, which is what a host that brings a deployment in place by place looks
   * like from outside: the file the probe asks for is already the new deployment's, and the first page
   * asked for after that is still the one before — named in it, as Next.js names every page it renders.
   * The second is an error, which names nobody and must not be taken for the switch having happened; the
   * third is this deployment's.
   */
  function servePage(response: ServerResponse): void {
    pages += 1;
    if (page === 'names nobody') {
      response.writeHead(OK, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!DOCTYPE html><html><body>a page</body></html>');
      return;
    }
    const said = PAGE_SEQUENCE[Math.min(pages, PAGE_SEQUENCE.length) - 1];
    if (said === 'a moment') {
      response.writeHead(SERVICE_UNAVAILABLE, { 'content-type': 'text/plain' });
      response.end('a moment');
      return;
    }
    const before = said === 'the deployment before';
    if (!before) {
      namedAt ??= Date.now();
    }
    // Upper case on purpose: a media type is case-insensitive, and the probe has to read it as one.
    response.writeHead(before ? OK : NOT_FOUND, { 'content-type': 'Text/HTML; charset=utf-8' });
    response.end(
      `<!DOCTYPE html><html data-dpl-id="${before ? 'dpl_thedeploymentbefore' : deploymentId}">` +
        '<body>a page</body></html>',
    );
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'HEAD') {
      // Only the file the bundle named, and only once the deployment is finalized: a host that answered
      // every path with the right digest would let a probe of the wrong URL pass for readiness, which is
      // the thing this is here to catch.
      const asked = (request.url ?? '/').split('?', 1)[0] ?? '/';
      if (!finalized || asked !== asset?.pathname) {
        response.writeHead(NOT_FOUND);
        response.end();
        return;
      }
      response.writeHead(OK, { etag: `"${asset.sha256}"` });
      response.end();
      return;
    }
    const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
    if (finalized && pathname === '/' && request.method === 'GET') {
      servePage(response);
      return;
    }
    const answer = (status: number, said: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(said));
    };
    if (pathname === '/v1/projects/p') {
      answer(OK, {
        project: { id: 'p', previewUrl: `http://127.0.0.1:${String(port)}/` },
        active: { projectId: 'p', mode: 'live', app: { deploymentId } },
      });
      return;
    }
    if (pathname === '/v1/projects/p/env') {
      if (request.method === 'PUT') {
        const sent = (await body(request)) as { env: { name: string; value: string }[] };
        environment = Object.fromEntries(sent.env.map((entry) => [entry.name, entry.value]));
      }
      answer(OK, { env: [] });
      return;
    }
    if (pathname === '/v1/projects/p/deployments' && request.method === 'POST') {
      const bundle = (await body(request)) as {
        buildId: string;
        staticFiles: { pathname: string; blob: { sha256: string } }[];
        functions: { app: { modules: { blob: { sha256: string } }[] } };
      };
      registered = bundle.buildId;
      const [file] = bundle.staticFiles;
      asset =
        file === undefined ? undefined : { pathname: file.pathname, sha256: file.blob.sha256 };
      // Every blob it names is asked for, so that the upload loop is what answers, not `missing: []`.
      wanted = bundle.functions.app.modules.map((module) => module.blob.sha256);
      answer(CREATED, { deployment: { id: deploymentId }, missing: wanted });
      return;
    }
    const onward = aboutTheDeployment(pathname, request.method ?? 'GET');
    answer(onward.status, onward.body);
  }

  async function answering(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await handle(request, response);
    } catch (error) {
      // Nothing else is listening for this, and a fake host that died quietly would look like a tool
      // that hung: whatever went wrong here ends the check with it.
      console.error(error);
      process.exitCode = 1;
      response.destroy();
    }
  }

  const server: Server = createServer((request, response) => {
    // A request listener returns nothing, and this promise cannot reject: `answering` is where a
    // failure becomes an ended check.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- answered above, not awaited.
    void answering(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as { port: number }).port;
  return {
    port,
    registered: () => registered,
    environment: () => environment,
    uploaded: () => [...uploaded],
    refusals: () => [...refusals],
    namedAt: () => namedAt,
    close: () => {
      server.close();
    },
  };
}
