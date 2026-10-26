import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import { cliOf, packAll, succeed } from './check-deploy-build.ts';

/** Published packages and a relocated Node-only artifact, with no account or remote deployment. */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const START_MS = 30_000;
const STOP_MS = 35_000;
const REQUEST_MS = 20_000;
/** How often a kept image is asked for again, until it is answered from what was kept. */
const KEPT_POLL_MS = 100;
const HTTP_OK = 200;
const HTTP_SEE_OTHER = 303;
const HTTP_NOT_MODIFIED = 304;
/** The width `/_next/image` is asked for the fixture's `native.png`, one of the default sizes. */
const NATIVE_IMAGE_WIDTH = 64;
const WEBP = 'image/webp';
const HOME_MARKER = 'upwind-native-home';
const SERVING = /upwind: native server listening on (http:\/\/\S+)/u;

interface Running {
  readonly child: ChildProcess;
  readonly site: URL;
  readonly exited: Promise<[number | null, NodeJS.Signals | null]>;
}

function say(value: string): void {
  console.log(`check-native: ${value}`);
}

async function within<T>(work: Promise<T>, timeout: number, message: string): Promise<T> {
  const late = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    late.reject(new Error(message));
  }, timeout);
  try {
    return await Promise.race([work, late.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function pack(name: string): string {
  return `file:../packages/${name}.tgz`;
}

async function copyFixture(out: string): Promise<string> {
  const directory = path.join(out, 'source');
  await cp(path.join(ROOT, 'fixtures/next-native'), directory, {
    recursive: true,
    filter: (source) => {
      return !['.arkor', '.next', '.upwind', 'node_modules', 'package-lock.json'].includes(
        path.basename(source),
      );
    },
  });
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        devDependencies: { upwind: pack('upwind'), '@stayingupwind/adapter': pack('adapter') },
        overrides: {
          '@stayingupwind/core': pack('core'),
          '@stayingupwind/runtime': pack('runtime'),
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

async function runServer(
  command: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<Running> {
  const child = spawn(process.execPath, [...command], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const ready = Promise.withResolvers<URL>();
  const output = { text: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    output.text += chunk.toString('utf8');
    const url = SERVING.exec(output.text)?.[1];
    if (url !== undefined) ready.resolve(new URL(url));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    output.text += chunk.toString('utf8');
  });
  const ended = async (): Promise<never> => {
    await exited;
    throw new Error(`native server exited before listening:\n${output.text}`);
  };
  try {
    const site = await within(
      Promise.race([ready.promise, ended()]),
      START_MS,
      'native server did not listen',
    );
    return { child, site, exited };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

async function stopped(running: Running): Promise<void> {
  const [code, signal] = await within(
    running.exited,
    STOP_MS,
    'native server did not drain on SIGTERM',
  );
  assert.equal(signal, null, 'native server must finish its own shutdown');
  assert.equal(code, 0, 'native server must drain accepted work');
}

async function get(site: URL, pathname: string): Promise<Response> {
  const response = await fetch(new URL(pathname, site), {
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  assert.equal(
    response.status,
    HTTP_OK,
    `${pathname} returned ${String(response.status)}: ${response.status === HTTP_OK ? '' : await response.text()}`,
  );
  return response;
}

async function post(site: URL, pathname: string): Promise<void> {
  const response = await fetch(new URL(pathname, site), {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const body = await response.text();
  assert.equal(
    response.status,
    HTTP_OK,
    `${pathname} returned ${String(response.status)}: ${body}`,
  );
}

/** The port the application reads as its own: the one the server bound, though it was asked for 0. */
async function ownPort(site: URL): Promise<void> {
  const response = await get(site, '/api/port');
  const data = (await response.json()) as { readonly port: string | null };
  assert.equal(data.port, site.port, 'PORT must name the port the server bound');
}

async function cached(site: URL): Promise<string> {
  const response = await get(site, '/api/cached');
  const data = (await response.json()) as { readonly value: string };
  return data.value;
}

/**
 * `/_next/image` resized and re-encoded by the `sharp` the artifact carries — the server here runs
 * away from the installation the build copied it from — and a client holding it answered 304.
 */
async function images(site: URL, installed: string): Promise<void> {
  const source = new Uint8Array(await (await get(site, '/native.png')).arrayBuffer());
  const asked = new URL(`/_next/image?url=%2Fnative.png&w=${NATIVE_IMAGE_WIDTH}&q=75`, site);
  const accept = { accept: WEBP };
  const response = await fetch(asked, { headers: accept, signal: AbortSignal.timeout(REQUEST_MS) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, HTTP_OK, `${asked.pathname} returned ${String(response.status)}`);
  assert.equal(response.headers.get('content-type'), WEBP, 'the image must be re-encoded');
  // Read with the installation's own `sharp`, which the fixture depends on.
  const read = createRequire(path.join(installed, 'package.json'))('sharp') as (
    input: Uint8Array,
  ) => { metadata(): Promise<{ readonly width?: number }> };
  const { width } = await read(bytes).metadata();
  assert.equal(width, NATIVE_IMAGE_WIDTH, 'the image must be resized');
  assert.ok(bytes.byteLength < source.byteLength, 'the image must be smaller than its source');
  const tag = response.headers.get('etag');
  assert.ok(tag !== null, 'the image must carry an entity tag');
  const held = await fetch(asked, {
    headers: { ...accept, 'if-none-match': tag },
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  await held.body?.cancel();
  assert.equal(held.status, HTTP_NOT_MODIFIED, 'a client holding the image must be answered 304');
  await keptImage(asked, accept, { tag, bytes });
}

/**
 * The image kept on the server's disk once made (`runtime/src/native/image-cache.ts`), and asked for
 * again: answered from what was kept, its tag and bytes the ones made. Kept once the answer has gone
 * out, so asked for again until it is, for a while.
 */
async function keptImage(
  asked: URL,
  headers: Readonly<Record<string, string>>,
  made: { readonly tag: string; readonly bytes: Uint8Array },
): Promise<void> {
  const end = Date.now() + REQUEST_MS;
  for (;;) {
    const again = await fetch(asked, { headers, signal: AbortSignal.timeout(REQUEST_MS) });
    const bytes = new Uint8Array(await again.arrayBuffer());
    if (again.headers.get('x-nextjs-cache') === 'HIT') {
      assert.equal(again.headers.get('etag'), made.tag, 'a kept image must keep its entity tag');
      assert.deepEqual(bytes, made.bytes, 'a kept image must be the one made');
      return;
    }
    assert.ok(Date.now() < end, 'the image was never answered from what the server kept');
    await sleep(KEPT_POLL_MS);
  }
}

async function rewrites(site: URL): Promise<void> {
  for (const method of ['POST', 'PUT']) {
    const response = await fetch(new URL('/rewrite/echo', site), {
      method,
      body: `native-${method}`,
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    assert.equal(response.status, HTTP_OK);
    assert.equal(await response.text(), `native-${method}`);
  }
  const compressed = await get(site, '/rewrite/compressed');
  assert.equal(compressed.headers.get('content-encoding'), null);
  assert.equal(compressed.headers.get('content-length'), null);
  assert.deepEqual(compressed.headers.getSetCookie(), ['first=1; Path=/', 'second=2; Path=/']);
  assert.equal(await compressed.text(), 'native-rewritten-gzip');
}

async function basicRoutes(site: URL, actionMarker: string): Promise<void> {
  const home = await (await get(site, '/')).text();
  assert.ok(home.includes(HOME_MARKER));
  const asset = /src="(\/_next\/static\/[^"?]+)/u.exec(home)?.[1];
  assert.ok(asset !== undefined && asset !== '', 'the page must name a client asset');
  await (await get(site, asset)).body?.cancel();
  const file = await get(site, '/native.txt');
  assert.equal(
    file.headers.get('x-native-proxy'),
    'ran',
    'proxy must run before serving a public file',
  );
  assert.equal((await file.text()).trim(), 'native-public-file');
  const page = await get(site, '/ssr');
  assert.equal(page.headers.get('x-native-proxy'), 'ran');
  assert.ok((await page.text()).replaceAll('<!-- -->', '').includes('native-pages:request'));
  const rsc = await fetch(new URL('/?_rsc=native', site), {
    headers: { rsc: '1' },
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  assert.equal(rsc.status, HTTP_OK);
  assert.ok(rsc.headers.get('content-type')?.startsWith('text/x-component') === true);
  assert.ok((await rsc.text()).includes(HOME_MARKER));
  const node = (await (await get(site, '/api/node')).json()) as {
    readonly file: string;
    readonly child: string;
    readonly png: string;
  };
  assert.deepEqual(node, {
    file: 'native-traced-file',
    child: 'native-child',
    png: '89504e470d0a1a0a',
  });
  const formPage = await (await get(site, '/actions')).text();
  const action = /name="(\$ACTION_ID_[^"]+)"/u.exec(formPage)?.[1];
  assert.ok(action !== undefined && action !== '', 'the form must carry a compiled Server Action');
  const form = new FormData();
  form.set(action, '');
  form.set('value', 'native-action-completed');
  const submitted = await fetch(new URL('/actions', site), {
    method: 'POST',
    body: form,
    redirect: 'manual',
    headers: { origin: site.origin },
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  await submitted.body?.cancel();
  assert.equal(submitted.status, HTTP_SEE_OTHER);
  assert.equal(new URL(submitted.headers.get('location') ?? '', site).pathname, '/action-done');
  assert.equal(await readFile(actionMarker, 'utf8'), 'native-action-completed');
}

async function ppr(site: URL, release: () => void): Promise<void> {
  const response = await get(site, '/ppr');
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('<p>native-shell</p>')) {
    const chunk = await within(reader.read(), REQUEST_MS, 'PPR did not stream its shell');
    assert.equal(
      chunk.done,
      false,
      'the response must not finish before its dynamic boundary is released',
    );
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.ok(!received.includes('<p>native-dynamic</p>'));
  release();
  for (;;) {
    const chunk = await within(
      reader.read(),
      REQUEST_MS,
      'PPR did not finish after releasing its dynamic boundary',
    );
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.ok(received.includes('<p>native-dynamic</p>'));
}

async function probe(out: string, source: string | undefined): Promise<void> {
  const deployed = path.join(out, 'deployed');
  const native = path.join(deployed, '.arkor/node');
  if (source !== undefined) {
    await mkdir(path.dirname(native), { recursive: true });
    await cp(path.join(source, '.arkor/node'), native, { recursive: true, verbatimSymlinks: true });
  }
  await rm(path.join(out, 'cache'), { recursive: true, force: true });
  const files = await readdir(native, { recursive: true });
  assert.ok(
    files.some((name) => name.endsWith('.node')),
    'the native addon must travel with the artifact',
  );
  for (const file of files) {
    const parts = file.split(path.sep);
    assert.ok(
      parts.every((part) => !['miniflare', 'workerd', 'wrangler'].includes(part)),
      `native artifact carries ${file}`,
    );
  }
  const installed = path.join(out, 'installed');
  if (source !== undefined) await rename(source, installed);
  const dynamic = { released: false, pending: new Set<ServerResponse>() };
  const after = { pending: new Set<ServerResponse>(), entered: Promise.withResolvers<undefined>() };
  const state = { value: 'one' };
  const control = createServer((request, response) => {
    switch (request.url ?? '') {
      case '/rewrite/echo': {
        request.pipe(response);
        break;
      }
      case '/rewrite/compressed': {
        const bytes = gzipSync('native-rewritten-gzip');
        response.writeHead(HTTP_OK, {
          'content-encoding': 'gzip',
          'content-length': bytes.byteLength,
          'set-cookie': ['first=1; Path=/', 'second=2; Path=/'],
        });
        response.end(bytes);
        break;
      }
      case '/dynamic': {
        if (dynamic.released) response.end('released');
        else dynamic.pending.add(response);
        break;
      }
      case '/after': {
        after.pending.add(response);
        after.entered.resolve(undefined);
        break;
      }
      default: {
        response.end(state.value);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(0, '127.0.0.1', () => {
      control.off('error', reject);
      resolve();
    });
  });
  const address = control.address();
  assert.ok(address !== null && typeof address !== 'string');
  const actionMarker = path.join(out, 'action-marker');
  const afterMarker = path.join(out, 'after-marker');
  await Promise.all(
    [actionMarker, afterMarker].map(async (file) => {
      await rm(file, { force: true });
    }),
  );
  const env = {
    PORT: '0',
    UPWIND_NODE_HOSTNAME: '127.0.0.1',
    UPWIND_NODE_CACHE_DIR: path.join(out, 'cache'),
    UPWIND_NATIVE_CONTROL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
    UPWIND_NATIVE_ACTION_MARKER: actionMarker,
    UPWIND_NATIVE_AFTER_MARKER: afterMarker,
  };
  const children = new Set<Running>();
  try {
    const first = await runServer([path.join(native, 'server.mjs')], deployed, env);
    children.add(first);
    await basicRoutes(first.site, actionMarker);
    await ownPort(first.site);
    await rewrites(first.site);
    await images(first.site, installed);
    await ppr(first.site, () => {
      dynamic.released = true;
      for (const response of dynamic.pending) response.end('released');
      dynamic.pending.clear();
    });
    assert.ok(
      (await (await get(first.site, '/isr')).text())
        .replaceAll('<!-- -->', '')
        .includes('native-isr:seed'),
    );
    assert.equal(await cached(first.site), 'one');
    state.value = 'two';
    assert.equal(await cached(first.site), 'one');
    await post(first.site, '/api/invalidate');
    assert.equal(await cached(first.site), 'two');
    await post(first.site, '/api/revalidate');
    assert.ok(
      (await (await get(first.site, '/isr')).text())
        .replaceAll('<!-- -->', '')
        .includes('native-isr:two'),
    );
    await post(first.site, '/api/after');
    await within(after.entered.promise, REQUEST_MS, 'after() did not begin its accepted task');
    first.child.kill('SIGTERM');
    for (const response of after.pending) response.end('released');
    after.pending.clear();
    await stopped(first);
    assert.equal(await readFile(afterMarker, 'utf8'), 'native-after-completed');
    state.value = 'three';
    const second = await runServer([path.join(native, 'server.mjs')], deployed, env);
    children.add(second);
    assert.equal(await cached(second.site), 'two', 'use cache must survive a restart');
    assert.ok(
      (await (await get(second.site, '/isr')).text())
        .replaceAll('<!-- -->', '')
        .includes('native-isr:two'),
      'ISR must survive a restart without reseeding',
    );
    second.child.kill('SIGTERM');
    await stopped(second);
    const cli = await runServer(
      [
        cliOf(installed),
        'start',
        deployed,
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
        '--cache-dir',
        path.join(out, 'cache'),
      ],
      deployed,
      env,
    );
    children.add(cli);
    assert.ok((await (await get(cli.site, '/')).text()).includes(HOME_MARKER));
    await ownPort(cli.site);
    cli.child.kill('SIGTERM');
    await stopped(cli);
  } finally {
    for (const running of children)
      if (running.child.exitCode === null && running.child.signalCode === null)
        running.child.kill('SIGKILL');
    for (const response of dynamic.pending) response.end();
    for (const response of after.pending) response.end();
    await new Promise<void>((resolve) => {
      control.close(() => {
        resolve();
      });
    });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, 'probe-only': { type: 'boolean' } },
    strict: true,
  });
  if (values.out === undefined) throw new Error('usage: check-native.ts --out <directory>');
  const out = path.resolve(values.out);
  if (values['probe-only'] === true) {
    await probe(out, undefined);
    return;
  }
  process.env['NEXT_TELEMETRY_DISABLED'] = '1';
  Reflect.deleteProperty(process.env, 'UPWIND_NATIVE_CONTROL_ORIGIN');
  say('packing the public packages');
  await packAll(out);
  const source = await copyFixture(out);
  succeed('npm', ['install', '--no-audit', '--no-fund'], source);
  succeed(process.execPath, [cliOf(source), 'build', source, '--target=node'], source);
  say('probing only the relocated native artifact');
  await probe(out, source);
  say('routing, native dependencies, PPR, invalidation, persistence and shutdown passed');
}

await main();
