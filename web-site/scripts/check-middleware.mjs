import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The website deliberately installs the published CLI and adapter, outside the workspace.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const cli = createRequire(require.resolve('upwind/package.json'));
const adapter = createRequire(require.resolve('@stayingupwind/adapter'));
const out = path.join(root, '.arkor');
const signal = AbortSignal.timeout(60_000);
const proof = { status: 'running', cases: [], egressAttempts: 0 };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function bounded(pending, until = signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(until.reason);
    until.addEventListener('abort', abort, { once: true });
    if (until.aborted) abort();
    pending.then(resolve, reject).finally(() => until.removeEventListener('abort', abort));
  });
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function packageProof(file) {
  const bytes = await readFile(file);
  const value = JSON.parse(bytes);
  return { name: value.name, version: value.version, packageJsonSha256: digest(bytes) };
}

async function protocol() {
  // Public core exports are TypeScript intended for application bundlers. Use the installed
  // adapter's bundler rather than Node's unsupported type stripping inside node_modules.
  const { rolldown } = await import(pathToFileURL(adapter.resolve('rolldown')));
  await using bundle = await rolldown({
    input: 'website-middleware-protocol',
    platform: 'node',
    plugins: [
      {
        name: 'website-protocol',
        resolveId: (id) =>
          id === 'website-middleware-protocol' ? '\0website-protocol' : undefined,
        load: (id) =>
          id === '\0website-protocol'
            ? `export { MIDDLEWARE_ONLY_HEADER, middlewareApplies } from ${JSON.stringify(cli.resolve('@stayingupwind/core/paas'))};\nexport { budgetPatterns, createPatternBudget } from ${JSON.stringify(cli.resolve('@stayingupwind/core/request'))};`
            : undefined,
      },
    ],
  });
  const file = path.join(out, 'website-protocol.mjs');
  await bundle.write({ file, format: 'esm' });
  proof.protocolSha256 = digest(await readFile(file));
  return import(pathToFileURL(file));
}

function request(address, pathname, header, options = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.request(
      new URL(pathname, address),
      {
        method: options.method ?? 'GET',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: {
          host: 'locale.test:8443',
          accept: 'text/html',
          'sec-fetch-mode': 'navigate',
          [header]: '1',
          ...options.headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes: Buffer.concat(chunks).length,
            complete: response.complete,
            elapsedMs: performance.now() - started,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let runtime;
let failure;
try {
  await mkdir(out, { recursive: true });
  proof.packages = await Promise.all([
    packageProof(require.resolve('next/package.json')),
    packageProof(require.resolve('upwind/package.json')),
    packageProof(
      path.resolve(path.dirname(require.resolve('@stayingupwind/adapter')), '../package.json'),
    ),
    packageProof(
      path.resolve(path.dirname(cli.resolve('@stayingupwind/core/paas')), '../../package.json'),
    ),
  ]);
  proof.lockSha256 = digest(await readFile(path.join(root, 'pnpm-lock.yaml')));
  const bundle = await json(path.join(out, 'bundle.json'));
  const manifestBytes = await readFile(path.join(root, '.next/server/middleware-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const compiler = manifest.middleware['/'];
  assert.ok(compiler, 'Next.js did not compile the Edge middleware');
  const functions = await json(path.join(root, '.next/server/functions-config-manifest.json'));
  assert.equal(functions.functions['/_middleware'], undefined, 'Node.js Proxy still exists');
  proof.compiler = {
    manifestSha256: digest(manifestBytes),
    name: compiler.name,
    files: compiler.files,
    matchers: compiler.matchers,
  };
  const spec = bundle.functions.middleware;
  assert.ok(
    spec?.modules.some((module) => module.name === 'edge.cjs'),
    'Edge module absent',
  );
  proof.function = {
    mainModule: spec.mainModule,
    compatibilityDate: spec.compatibilityDate,
    compatibilityFlags: spec.compatibilityFlags,
    modules: spec.modules,
  };
  const modules = {};
  for (const module of spec.modules) {
    assert.match(module.blob.sha256, /^[a-f0-9]{64}$/u);
    const bytes = await readFile(path.join(out, 'blobs', module.blob.sha256));
    assert.equal(bytes.length, module.blob.byteLength, `${module.name} length`);
    assert.equal(digest(bytes), module.blob.sha256, `${module.name} SHA-256`);
    modules[module.name] = {
      type: module.type === 'commonjs' ? 'cjs' : module.type,
      contents: module.type === 'data' || module.type === 'wasm' ? bytes : bytes.toString('utf8'),
    };
  }
  assert.equal(Object.keys(modules).length, spec.modules.length, 'duplicate module names');
  assert.ok(Object.hasOwn(modules, spec.mainModule), 'main module absent');
  const { MIDDLEWARE_ONLY_HEADER, middlewareApplies, budgetPatterns, createPatternBudget } =
    await bounded(protocol());
  let budget = createPatternBudget();
  budgetPatterns(() => budget);
  for (const [pathname, expected] of [
    ['/', true],
    ['/en', true],
    ['/ja', true],
    ['/docs', true],
    ['/robots.txt', false],
    ['/sitemap.xml', false],
    ['/_next/static/site.js', false],
    ['/_next/data/build/en.json', false],
  ]) {
    budget = createPatternBudget();
    assert.equal(
      middlewareApplies(
        bundle.routing.middlewareMatchers,
        new URL(pathname, 'http://locale.test'),
        new Headers(),
      ),
      expected,
      `matcher ${pathname}`,
    );
  }
  const { Miniflare } = await import(pathToFileURL(cli.resolve('miniflare')));
  runtime = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'website-middleware',
          compatibilityDate: spec.compatibilityDate,
          compatibilityFlags: spec.compatibilityFlags,
          manifest: { mainModule: spec.mainModule, modulesRoot: '/bundle', modules },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: () => {
              proof.egressAttempts += 1;
              throw new Error('Website middleware attempted outbound network');
            },
          },
        },
      },
    ],
  });
  const address = await bounded(runtime.ready);
  const cases = [
    {
      path: '/?next=%2Fdocs%3Fq%3D1&x=two%20words',
      rewrite: '/en?next=%2Fdocs%3Fq%3D1&x=two%20words',
    },
    { path: '/', rewrite: '/en', headers: { 'accept-language': 'en' } },
    { path: '/', status: 307, location: '/ja', vary: true, headers: { 'accept-language': 'ja' } },
    {
      path: '/docs?q=one',
      status: 307,
      location: '/ja/docs?q=one',
      vary: true,
      headers: { cookie: 'locale=ja', 'accept-language': 'en' },
    },
    { path: '/', rewrite: '/en', headers: { cookie: 'locale=en', 'accept-language': 'ja' } },
    { path: '/', rewrite: '/en', headers: { cookie: 'locale=invalid', 'accept-language': 'en' } },
    { path: '/ja', next: true },
    { path: '/ja/docs?q=one', next: true },
    { path: '/en?next=%2Fja', status: 308, location: '/?next=%2Fja', cookie: true },
    { path: '/en/docs?q=one', status: 308, location: '/docs?q=one', cookie: true },
    { path: '/en', status: 308, location: '/', method: 'HEAD', cookie: true },
    { path: '/en', status: 308, location: '/', headers: { 'sec-purpose': 'prefetch' } },
    { path: '/en', status: 308, location: '/', headers: { purpose: 'prefetch' } },
    { path: '/en', status: 308, location: '/', headers: { accept: 'text/x-component', rsc: '1' } },
    { path: '/en', status: 308, location: '/', method: 'POST' },
  ];
  for (const test of cases) {
    const response = await request(address, test.path, MIDDLEWARE_ONLY_HEADER, test);
    proof.cases.push({
      path: test.path,
      method: test.method ?? 'GET',
      requestHeaders: test.headers ?? {},
      ...response,
    });
    assert.equal(response.status, test.status ?? 200, test.path);
    assert.equal(response.bytes, 0, `unexpected app/body ${test.path}`);
    assert.equal(response.complete, true);
    assert.equal(
      response.headers['x-middleware-rewrite'],
      test.rewrite ? new URL(test.rewrite, 'http://locale.test:8443').href : undefined,
    );
    assert.equal(
      response.headers.location,
      test.location ? new URL(test.location, 'http://locale.test:8443').href : undefined,
    );
    assert.equal(response.headers['x-middleware-next'], test.next ? '1' : undefined);
    const cookies = response.headers['set-cookie'] ?? [];
    assert.equal(cookies.length, test.cookie ? 1 : 0);
    if (test.cookie) {
      assert.match(cookies[0], /^locale=en;/u);
      for (const attribute of ['Path=/', 'Max-Age=31536000', 'HttpOnly', 'Secure', 'SameSite=lax'])
        assert.ok(cookies[0].includes(attribute), attribute);
    }
    if (test.path.startsWith('/en'))
      assert.equal(response.headers['cache-control'], 'private, no-store');
    const vary = (response.headers.vary ?? '').toLowerCase();
    if (test.vary) assert.ok(vary.includes('cookie') && vary.includes('accept-language'));
    if (test.rewrite)
      assert.ok(
        !vary.includes('cookie') && !vary.includes('accept-language'),
        'rewrite overwrote Next.js Vary',
      );
    assert.equal(proof.egressAttempts, 0);
  }
  proof.status = 'success';
} catch (error) {
  failure = error;
  proof.status = 'failed';
  proof.error = String(error);
} finally {
  if (runtime) {
    try {
      await bounded(runtime.dispose(), AbortSignal.timeout(5_000));
      assert.equal(proof.egressAttempts, 0);
    } catch (error) {
      proof.cleanupError = String(error);
      failure ??= error;
      proof.status = 'failed';
    }
  }
  try {
    await writeFile(path.join(out, 'middleware-check.json'), `${JSON.stringify(proof, null, 2)}\n`);
  } catch (error) {
    if (failure) console.error('Could not retain middleware failure metadata:', error);
    else failure = error;
  }
}
if (failure) throw failure;
console.log(
  `Compiled Edge middleware: ${proof.cases.length} HTTP behavior cases passed; no outbound calls.`,
);
