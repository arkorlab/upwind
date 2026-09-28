import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';

/**
 * The three hooks, run for real against a host that is not one.
 *
 * Everything else about this tool is checked by the type checker or by a run against a platform, and a
 * run against a platform needs a credential, a project and a built Next.js — so what breaks quietly is
 * what neither would notice: a shell contract (what reaches standard output, which variables a
 * fixture's own scripts can see, which file the build id comes from) and an HTTP protocol (the order of
 * the calls, and what is read out of each answer).
 *
 * So: a fake application, a fake host, and the real `scripts/e2e-*.sh`. No credential, no network, a
 * few seconds. `pnpm check:deploy-tests`, and CI runs it.
 */

const execFileAsync = promisify(execFile);
const SCRIPTS = path.join(import.meta.dirname, '..', 'scripts');
const REPO = path.join(import.meta.dirname, '..', '..', '..');
const BUNDLE_BUILD_ID = 'from-the-bundle';
const OUTPUT_DIRECTORY_BUILD_ID = 'from-the-output-directory';
const TOKEN = 'ark_a_token_nothing_may_read';
const OK = 200;
const CREATED = 201;
const ACCEPTED = 202;
const NO_CONTENT = 204;
const NOT_FOUND = 404;

/**
 * An application that builds without Next.js, and lies about its build id on purpose.
 *
 * `.next/BUILD_ID` says one thing and the bundle says another, so that reading the wrong one is a
 * failure here rather than a fixture whose build id the suite silently gets wrong. Which is which
 * arrives in the environment rather than in this text, so that the text stays a file and not a
 * template.
 */
const BUILD_SCRIPT = String.raw`
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const saw = (name) => name + ': ' + (process.env[name] === undefined ? 'no' : 'YES');
console.log('the build saw ' + saw('ARKOR_API_TOKEN') + ' ' + saw('ARKOR_API_TOKEN_FILE'));

mkdirSync('.next', { recursive: true });
writeFileSync('.next/BUILD_ID', process.env.CHECK_OUTPUT_DIRECTORY_BUILD_ID);

const bytes = Buffer.from('a function\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
mkdirSync('.ppr-cdn/blobs', { recursive: true });
writeFileSync('.ppr-cdn/blobs/' + sha256, bytes);
writeFileSync(
  '.ppr-cdn/bundle.json',
  JSON.stringify({
    v: 1,
    deploymentId: process.env.NEXT_DEPLOYMENT_ID,
    nextVersion: '16.3.6',
    buildId: process.env.CHECK_BUNDLE_BUILD_ID,
    projectDir: '.',
    generatedAt: new Date().toISOString(),
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'RSC',
        varyHeader: 'RSC',
        prefetchHeader: 'Next-Router-Prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'Next-Router-Segment-Prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [],
    prerenders: [],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [
          {
            name: 'index.mjs',
            type: 'esm',
            blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' },
          },
        ],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
  }),
);
`;

/**
 * Its `build` is shaped like the one the suite's harness writes (`… && pnpm post-build`), and its
 * `post-build` is its own — which is the case that must not be dropped.
 */
const MANIFEST = {
  name: 'deploy-tests-check-application',
  private: true,
  scripts: {
    build: 'node build.mjs && pnpm post-build',
    'post-build':
      "node -e \"console.log('the fixture post-build ran; it saw ARKOR_API_TOKEN: ' + (process.env.ARKOR_API_TOKEN === undefined ? 'no' : 'YES'))\"",
  },
};

function writeApplication(appDir: string): void {
  mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
  writeFileSync(path.join(appDir, 'build.mjs'), BUILD_SCRIPT);
  // Its own value, for `@next/env` to read and the deployment's environment to be replaced with.
  writeFileSync(path.join(appDir, '.env'), 'OWN=yes\n');
  writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  // A fixture arrives with its own `next`, which is where `@next/env` is resolved from. This one is
  // given the adapter's, linked: that package depends on Next.js and this one deliberately does not,
  // and what is under test here is the reader rather than npm.
  const fromAdapter = createRequire(path.join(REPO, 'packages', 'adapter', 'package.json'));
  symlinkSync(
    path.dirname(fromAdapter.resolve('next/package.json')),
    path.join(appDir, 'node_modules', 'next'),
  );
}

interface FakeHost {
  readonly port: number;
  /** What the bundle said its build id was, as the registration carried it. */
  readonly registered: () => string | undefined;
  /** The names the deployment's environment was replaced with. */
  readonly environment: () => string[];
  close: () => void;
}

/** A host that answers the six calls this tool makes, and nothing else. */
async function fakeHost(deploymentId: string): Promise<FakeHost> {
  let registered: string | undefined;
  let environment: string[] = [];
  let port = 0;

  async function body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'HEAD') {
      // This application has no static file, so readiness rests on the pointer alone.
      response.writeHead(NO_CONTENT);
      response.end();
      return;
    }
    const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
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
        const sent = (await body(request)) as { env: { name: string }[] };
        environment = sent.env.map((entry) => entry.name);
      }
      answer(OK, { env: [] });
      return;
    }
    if (pathname === '/v1/projects/p/deployments' && request.method === 'POST') {
      registered = ((await body(request)) as { buildId: string }).buildId;
      answer(CREATED, { deployment: { id: deploymentId }, missing: [] });
      return;
    }
    if (pathname.endsWith('/finalize')) {
      answer(ACCEPTED, { run: { id: 'run_checked' } });
      return;
    }
    if (pathname.endsWith(deploymentId)) {
      answer(OK, {
        deployment: { id: deploymentId, projectId: 'p', status: 'active' },
        run: { currentStep: 'activate' },
      });
      return;
    }
    answer(NOT_FOUND, { ok: false, error: { code: 'not_found', message: 'nothing here' } });
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
    close: () => {
      server.close();
    },
  };
}

function holds(said: string, held: boolean): void {
  console.log(`  ${held ? 'ok  ' : 'NOT '} ${said}`);
  if (!held) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'upwind-deploy-tests-check-'));
  const appDir = path.join(workDir, 'application');
  mkdirSync(appDir);
  writeApplication(appDir);
  const tokenFile = path.join(workDir, 'token');
  writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const deploymentId = createId(DEPLOYMENT_ID_PREFIX);
  const host = await fakeHost(deploymentId);
  const env = {
    ...process.env,
    ARKOR_API_URL: `http://127.0.0.1:${String(host.port)}`,
    ARKOR_API_TOKEN_FILE: tokenFile,
    ADAPTER_TEST_PROJECT_ID: 'p',
    ADAPTER_DIR: REPO,
    NEXT_DEPLOYMENT_ID: deploymentId,
    CHECK_BUNDLE_BUILD_ID: BUNDLE_BUILD_ID,
    CHECK_OUTPUT_DIRECTORY_BUILD_ID: OUTPUT_DIRECTORY_BUILD_ID,
  };
  const hook = (name: string): Promise<{ stdout: string }> =>
    execFileAsync('bash', [path.join(SCRIPTS, name)], { cwd: appDir, env });
  try {
    const deployed = await hook('e2e-deploy.sh');
    const logs = await hook('e2e-logs.sh');
    await hook('e2e-cleanup.sh');
    const build = readFileSync(path.join(appDir, '.adapter-build.log'), 'utf8');

    holds(
      'the deploy hook prints the URL, and only the URL',
      deployed.stdout.trim() === `http://127.0.0.1:${String(host.port)}`,
    );
    holds(
      "the registration carries the bundle's own build id",
      host.registered() === BUNDLE_BUILD_ID,
    );
    holds(
      "and the marker the harness reads is not the output directory's",
      !build.includes(OUTPUT_DIRECTORY_BUILD_ID),
    );
    holds(
      "the deployment's environment is the application's own",
      host.environment().join(',') === 'OWN',
    );
    holds('the build saw no token', build.includes('ARKOR_API_TOKEN: no'));
    holds('nor the file holding it', build.includes('ARKOR_API_TOKEN_FILE: no'));
    holds("the application's own post-build ran", build.includes('the fixture post-build ran'));
    holds('and it saw no token either', build.includes('it saw ARKOR_API_TOKEN: no'));
    holds(
      'the logs hook leads with the three markers',
      /^BUILD_ID: .+\nDEPLOYMENT_ID: .+\nNEXT_SUPPORTS_IMMUTABLE_ASSETS: 1\n/u.test(logs.stdout),
    );
  } finally {
    host.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
