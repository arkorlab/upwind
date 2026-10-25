/**
 * CI only: build the fixed official native-addon fixture with the actual adapter, then run its
 * emitted Node Function on loopback. No Cloudflare service, credentials, browser or next start.
 * Usage: node tools/native-addon-next-ci.mts <pinned-next-checkout>/test/e2e/prerender-native-module
 * The Linux runner must provide an empty, writable /bundle, Node24.22.1, pnpm12.14.0 and a C++
 * toolchain/Python for node-gyp. Run after the SDK's normal build. This is not a hosted measurement.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeNativeArtifact } from './native-addon-next-artifact.mts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEXT_VERSION = '16.4.3';
const NEXT_COMMIT = '29bbeab09981148ade186e8599ecdede15abc281';
const NODE_VERSION = '24.22.1';
const PNPM_VERSION = '12.14.0';
const REACT_VERSION = '19.3.0';
const MAX_BUILD_MS = 900_000;
const CLOSE_MS = 35_000;
const KILL_MS = 5000;
const PROBE_MS = 30_000;
const POLL_MS = 100;
const MAX_BODY = 2_097_152;
const BUNDLE_ROOT = '/bundle';
const OWNER_MARKER = '.upwind-native-next-ci-owner';
const TOKEN = randomBytes(32).toString('base64url');
const PINNED_FILES: Readonly<Record<string, string>> = {
  '.npmrc': '951a2b6e795f12e7e5e47a7ce71ab649cbb6e614',
  'bindings/index.js': 'fd4a2e414af0b19ae18ef43baed3eaa37a918db5',
  'bindings/package.json': 'a942bce5029cb83ffbf14d56d1d871ade3eba2e5',
  'native-addon-wrapper/index.js': '3c4a1356340798dd8f18b0e03fffdc4f3e99a1df',
  'native-addon-wrapper/package.json': 'be8bcc6a8708932ecdccd4e9b1484f0711656b3d',
  'native-addon/addon.cc': '2436d072feb14ad567e0abfe4309d2a02ac7b837',
  'native-addon/binding.gyp': '9c111067225943ff066f9a7b12d1891a642d3ca0',
  'native-addon/index.js': '52a1e8bf48a95cede2d325c2540aa6e679450339',
  'native-addon/package.json': '37c6888cf9a97330eb2f19c6c2679b8a36d8d679',
  'package.json': '22e1cf3cb2033b62c0e13cb70bdf4dca04874943',
  'pages/blog/[slug].js': 'fc0337f79e7b1aee3da96da05fd4c3116e7911c5',
  'pages/index.js': '39a9c6502ed04e370cf4f31db959c35874bceaa9',
  'pnpm-workspace.yaml': '68e8462f659082028ecf628c03a4b6f7bc32ae8a',
  'users.json': 'f683b73c83219124be7ca5d5c27d0bf4aa62afd2',
};

function record(value: unknown): Record<string, unknown> {
  assert(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'Expected a JSON object',
  );
  return value as Record<string, unknown>;
}

async function inventory(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, item.name);
    assert(!item.isSymbolicLink(), 'The source fixture must not contain symlinks');
    if (item.isDirectory()) files.push(...(await inventory(directory, name)));
    else {
      assert(item.isFile(), 'The source fixture must contain regular files');
      files.push(name);
    }
  }
  return files;
}

async function copyFixture(source: string, target: string): Promise<void> {
  assert.deepEqual(
    (await inventory(source)).toSorted(),
    Object.keys(PINNED_FILES).toSorted(),
    'Official fixture inventory changed',
  );
  for (const [name, expected] of Object.entries(PINNED_FILES)) {
    const bytes = await readFile(path.join(source, name));
    const blob = createHash('sha1')
      .update(`blob ${bytes.byteLength}\0`)
      .update(bytes)
      .digest('hex');
    assert.equal(blob, expected, `Official fixture source changed: ${name}`);
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await writeFile(path.join(target, name), bytes, { flag: 'wx' });
  }
}

function environment(userConfig: string, globalConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    TMPDIR: process.env['TMPDIR'],
    CI: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_registry: 'https://registry.npmjs.org',
  };
  return env;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function alive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  signalGroup(child, 'SIGTERM');
  const deadline = Date.now() + CLOSE_MS;
  while (alive(child) && Date.now() < deadline) await pause(POLL_MS);
  if (alive(child)) signalGroup(child, 'SIGKILL');
  const hardDeadline = Date.now() + KILL_MS;
  while (alive(child) && Date.now() < hardDeadline) await pause(POLL_MS);
  assert(!alive(child), 'A CI child process group survived cleanup');
}

const children = new Set<ChildProcess>();
let interrupted = false;

async function command(
  binary: string,
  args: readonly string[],
  cwd: string,
  options: { env: NodeJS.ProcessEnv; capture?: boolean },
): Promise<string> {
  assert(!interrupted, 'The CI control was interrupted');
  const child = spawn(binary, args, {
    cwd,
    env: options.env,
    detached: true,
    stdio: options.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  children.add(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > MAX_BODY) signalGroup(child, 'SIGKILL');
  });
  const deadline = setTimeout(() => {
    signalGroup(child, 'SIGKILL');
  }, MAX_BUILD_MS);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode) => {
        resolve(exitCode);
      });
    });
    assert.equal(code, 0, 'The isolated native fixture command failed');
    return output;
  } finally {
    clearTimeout(deadline);
    await stop(child);
    children.delete(child);
  }
}

async function prepare(source: string, directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  await copyFixture(source, directory);
  const packageFile = path.join(directory, 'package.json');
  const original = record(JSON.parse(await readFile(packageFile, 'utf8')));
  const manager = record(JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')))[
    'packageManager'
  ];
  assert(
    typeof manager === 'string' && manager.startsWith(`pnpm@${PNPM_VERSION}+`),
    'SDK package manager pin changed',
  );
  await writeFile(
    packageFile,
    JSON.stringify(
      {
        ...original,
        private: true,
        name: 'upwind-native-next-ci',
        packageManager: manager,
        dependencies: {
          ...record(original['dependencies']),
          next: NEXT_VERSION,
          react: REACT_VERSION,
          'react-dom': REACT_VERSION,
        },
      },
      undefined,
      2,
    ),
  );
  // Keep the official native-addon build allowlist. Add the same explicit cooldown and run/install
  // separation as this SDK; native-addon is a direct file dependency, not an exotic subdependency.
  const workspace = await readFile(path.join(directory, 'pnpm-workspace.yaml'), 'utf8');
  await writeFile(
    path.join(directory, 'pnpm-workspace.yaml'),
    `${workspace}\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - next\n  - '@next/*'\nverifyDepsBeforeRun: false\nstrictPeerDependencies: true\n`,
  );
  const adapter = path.join(ROOT, 'packages/adapter/dist/index.js');
  assert((await lstat(adapter)).isFile(), 'Build the SDK before this CI helper');
  await writeFile(
    path.join(directory, 'next.config.mjs'),
    `export default {adapterPath:${JSON.stringify(adapter)}};\n`,
    { flag: 'wx' },
  );
  assert.equal(
    (await command('pnpm', ['--version'], directory, { env, capture: true })).trim(),
    PNPM_VERSION,
    'Use the SDK pinned package manager',
  );
  await command(
    'pnpm',
    ['install', '--no-frozen-lockfile', '--registry=https://registry.npmjs.org'],
    directory,
    { env },
  );
  const installed = record(
    JSON.parse(await readFile(path.join(directory, 'node_modules/next/package.json'), 'utf8')),
  );
  assert.equal(installed['version'], NEXT_VERSION, 'The fixture installed a different Next.js');
  await command('pnpm', ['exec', 'next', 'build'], directory, { env });
}

async function bodyOf(response: Response): Promise<string> {
  if (response.status !== 200) {
    await response.body?.cancel();
    assert.equal(response.status, 200, 'The native Function did not answer successfully');
  }
  const reader = response.body?.getReader();
  assert(reader !== undefined);
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      assert(length <= MAX_BODY, 'Oversized fixture response');
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString();
}

function request(pathname: string, data = false): Promise<Response> {
  return fetch(`http://127.0.0.1:8080${pathname}`, {
    headers: {
      'x-upwind-control-token': TOKEN,
      'x-upwind-request-url': `https://native-ci.test${pathname}`,
      ...(data && { 'x-nextjs-data': '1' }),
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_MS),
  });
}

function nextData(html: string): Record<string, unknown> {
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  assert(start !== -1, 'Missing Next data script');
  const content = html.indexOf('>', start);
  const end = html.indexOf('</script>', content);
  assert(content !== -1 && end !== -1, 'Malformed Next data script');
  return record(JSON.parse(html.slice(content + 1, end)));
}

function expected(slug: string) {
  return {
    params: { slug },
    blog: true,
    contextAware: true,
    users: [
      { id: 1, first_name: 'john', last_name: 'deux' },
      { id: 2, first_name: 'zeit', last_name: 'geist' },
    ],
  };
}

async function smoke(
  identity: { deploymentId: string; functionName: string; buildId: string },
  env: NodeJS.ProcessEnv,
): Promise<void> {
  assert(!interrupted, 'The CI control was interrupted');
  const runtime = {
    v: 1,
    deploymentId: identity.deploymentId,
    functionName: identity.functionName,
    controlToken: TOKEN,
    capabilities: { services: {} },
  };
  const child = spawn(process.execPath, [path.join(BUNDLE_ROOT, 'upwind/server.mjs')], {
    cwd: BUNDLE_ROOT,
    env: {
      ...env,
      NODE_ENV: 'production',
      NEXT_RUNTIME: 'nodejs',
      ARKOR_NODE_RUNTIME: JSON.stringify(runtime),
    },
    detached: true,
    stdio: 'inherit',
  });
  children.add(child);
  let startError: Error | undefined;
  child.once('error', (error) => {
    startError = error;
  });
  try {
    const deadline = Date.now() + PROBE_MS;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && startError === undefined) {
      try {
        const response = await fetch('http://127.0.0.1:8080/__upwind/ready', {
          headers: { 'x-upwind-control-token': TOKEN },
          signal: AbortSignal.timeout(PROBE_MS),
        });
        ready =
          response.status === 200 && record(JSON.parse(await bodyOf(response)))['ready'] === true;
        if (ready) break;
      } catch {
        /* A cold Node process may not have bound its port yet. */
      }
      await pause(POLL_MS);
    }
    assert(ready && startError === undefined, 'The emitted Node Function did not become ready');
    const first = nextData(await bodyOf(await request('/blog/first')));
    assert.deepEqual(record(first['props'])['pageProps'], expected('first'));
    // Browser fallback fetches this exact Pages data route after receiving its initial shell.
    await bodyOf(await request('/blog/second'));
    const second = record(
      JSON.parse(
        await bodyOf(
          await request(
            `/_next/data/${encodeURIComponent(identity.buildId)}/blog/second.json`,
            true,
          ),
        ),
      ),
    );
    assert.deepEqual(second['pageProps'], expected('second'));
  } finally {
    await stop(child);
    children.delete(child);
  }
}

async function main(): Promise<void> {
  assert.equal(process.env['CI'], 'true', 'This helper runs only in isolated Linux CI');
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.node, NODE_VERSION);
  assert(
    typeof record(record(process.report.getReport())['header'])['glibcVersionRuntime'] === 'string',
    'The CI runtime must use glibc',
  );
  assert(
    process.env['NODE_OPTIONS'] === undefined,
    'Unset inherited Node loaders/options for this control',
  );
  const source = process.argv[2];
  const runnerTemp = process.env['RUNNER_TEMP'];
  assert(
    source !== undefined && runnerTemp !== undefined,
    'Pass the fixed fixture path and RUNNER_TEMP',
  );
  assert(
    (await lstat(BUNDLE_ROOT)).isDirectory() && (await readdir(BUNDLE_ROOT)).length === 0,
    'CI must provide an empty writable /bundle',
  );
  await writeFile(path.join(BUNDLE_ROOT, OWNER_MARKER), TOKEN, { flag: 'wx' });
  const directory = await mkdtemp(path.join(await realpath(runnerTemp), 'upwind-native-next-'));
  const cancel = (): void => {
    interrupted = true;
    process.exitCode = 1;
    for (const child of children) signalGroup(child, 'SIGKILL');
  };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  try {
    const config = path.join(directory, 'user.npmrc');
    const globalConfig = path.join(directory, 'global.npmrc');
    await writeFile(config, 'registry=https://registry.npmjs.org\n');
    await writeFile(globalConfig, 'registry=https://registry.npmjs.org\n');
    const fixture = path.join(directory, 'fixture');
    await mkdir(fixture);
    const env = environment(config, globalConfig);
    await prepare(await realpath(source), fixture, env);
    const identity = await materializeNativeArtifact(fixture, BUNDLE_ROOT, NODE_VERSION);
    await smoke(identity, env);
    assert(!interrupted, 'The CI control was interrupted');
  } finally {
    const closed = await Promise.allSettled([...children].map(stop));
    if ((await readFile(path.join(BUNDLE_ROOT, OWNER_MARKER), 'utf8')) === TOKEN) {
      for (const name of await readdir(BUNDLE_ROOT))
        await rm(path.join(BUNDLE_ROOT, name), { recursive: true, force: true });
    }
    await rm(directory, { recursive: true, force: true });
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    assert(
      closed.every((result) => result.status === 'fulfilled'),
      'CI process group cleanup failed',
    );
  }
  console.log(
    JSON.stringify({
      complete: true,
      nextVersion: NEXT_VERSION,
      nextCommit: NEXT_COMMIT,
      nativeFunctions: 1,
      paths: ['/blog/first', '/blog/second'],
      nativeContextAware: true,
    }),
  );
}

await main();
