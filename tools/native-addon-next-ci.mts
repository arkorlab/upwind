/**
 * CI only: build the fixed official native-addon fixture with the actual adapter, then run its
 * emitted Node Function on loopback. No Cloudflare service, credentials, browser or next start.
 * Usage: node tools/native-addon-next-ci.mts <pinned-next-checkout>/test/e2e/prerender-native-module
 * The Linux runner must provide an empty, writable /bundle, Node24.22.1, pnpm12.15.0 and a C++
 * toolchain/Python for node-gyp. Run after the SDK's normal build. This is not a hosted measurement.
 */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
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

import {
  materializeNativeArtifact,
  type NativeFixtureIdentity,
} from './native-addon-next-artifact.mts';
import { retainNativeNextDiagnostics } from './native-addon-next-diagnostics.mts';
import { NativeNextProcesses, pause } from './native-addon-next-process.mts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEXT_VERSION = '16.4.3';
const NEXT_COMMIT = '29bbeab09981148ade186e8599ecdede15abc281';
const NODE_VERSION = '24.22.1';
const PNPM_VERSION = '12.15.0';
const REACT_VERSION = '19.3.0';
const PROBE_MS = 30_000;
const POLL_MS = 100;
const MAX_BODY = 2_097_152;
const TOKEN_BYTES = 32;
const HTTP_OK = 200;
const BUNDLE_ROOT = '/bundle';
const OWNER_MARKER = '.upwind-native-next-ci-owner';
const TOKEN = randomBytes(TOKEN_BYTES).toString('base64url');
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
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'Expected a JSON object',
  );
  return value as Record<string, unknown>;
}

function compareNames(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

function gitBlob(bytes: Buffer): string {
  // eslint-disable-next-line sonarjs/hashing -- This reproduces a pinned public Git blob identifier, not a security digest or credential.
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

async function inventory(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  for (const item of entries) {
    const name = path.posix.join(prefix, item.name);
    assert.ok(!item.isSymbolicLink(), 'The source fixture must not contain symlinks');
    if (item.isDirectory()) files.push(...(await inventory(directory, name)));
    else {
      assert.ok(item.isFile(), 'The source fixture must contain regular files');
      files.push(name);
    }
  }
  return files;
}

async function copyFixture(source: string, target: string): Promise<void> {
  assert.deepEqual(
    (await inventory(source)).toSorted(compareNames),
    Object.keys(PINNED_FILES).toSorted(compareNames),
    'Official fixture inventory changed',
  );
  for (const [name, expectedBlob] of Object.entries(PINNED_FILES)) {
    const bytes = await readFile(path.join(source, name));
    const blob = gitBlob(bytes);
    assert.equal(blob, expectedBlob, `Official fixture source changed: ${name}`);
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await writeFile(path.join(target, name), bytes, { flag: 'wx' });
  }
}

function environment(userConfig: string, globalConfig: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    TMPDIR: process.env['TMPDIR'],
    CI: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_registry: 'https://registry.npmjs.org',
  };
}

const processes = new NativeNextProcesses();

async function prepare(source: string, directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  await copyFixture(source, directory);
  const packageFile = path.join(directory, 'package.json');
  const originalJson: unknown = JSON.parse(await readFile(packageFile, 'utf8'));
  const original = record(originalJson);
  const sdkPackage = path.join(ROOT, 'package.json');
  const sdkJson: unknown = JSON.parse(await readFile(sdkPackage, 'utf8'));
  const manager = record(sdkJson)['packageManager'];
  assert.ok(
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
  assert.ok((await lstat(adapter)).isFile(), 'Build the SDK before this CI helper');
  await writeFile(
    path.join(directory, 'next.config.mjs'),
    `export default {adapterPath:${JSON.stringify(adapter)}};\n`,
    { flag: 'wx' },
  );
  assert.equal(
    (await processes.command(['--version'], directory, { env, capture: true })).trim(),
    PNPM_VERSION,
    'Use the SDK pinned package manager',
  );
  await processes.command(
    [
      'install',
      '--no-frozen-lockfile',
      '--registry=https://registry.npmjs.org',
      // pnpm 12 approves file dependencies by resolved identity, after the fixture blob check.
      '--allow-build=native-addon@file:native-addon',
    ],
    directory,
    { env },
  );
  const installedFile = path.join(directory, 'node_modules/next/package.json');
  const installedJson: unknown = JSON.parse(await readFile(installedFile, 'utf8'));
  const installed = record(installedJson);
  assert.equal(installed['version'], NEXT_VERSION, 'The fixture installed a different Next.js');
}

async function bodyOf(response: Response): Promise<string> {
  if (response.status !== HTTP_OK) {
    await response.body?.cancel();
    assert.equal(response.status, HTTP_OK, 'The native Function did not answer successfully');
  }
  const reader = response.body?.getReader();
  assert.ok(reader !== undefined);
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      assert.ok(length <= MAX_BODY, 'Oversized fixture response');
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
  assert.ok(start !== -1, 'Missing Next data script');
  const content = html.indexOf('>', start);
  const end = html.indexOf('</script>', content);
  assert.ok(content !== -1 && end !== -1, 'Malformed Next data script');
  return record(JSON.parse(html.slice(content + 1, end)));
}

interface PageProperties {
  readonly params: { readonly slug: string };
  readonly blog: true;
  readonly contextAware: true;
  readonly users: readonly {
    readonly id: number;
    readonly first_name: string;
    readonly last_name: string;
  }[];
}

function expected(slug: string): PageProperties {
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

async function waitForReady(child: ChildProcess): Promise<void> {
  const state = { failed: false };
  child.once('error', () => {
    state.failed = true;
  });
  const deadline = performance.now() + PROBE_MS;
  let ready = false;
  while (child.exitCode === null && !state.failed && performance.now() < deadline) {
    try {
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      const response = await fetch('http://127.0.0.1:8080/__upwind/ready', {
        headers: { 'x-upwind-control-token': TOKEN },
        signal: AbortSignal.timeout(remaining),
      });
      const answerJson: unknown = JSON.parse(await bodyOf(response));
      const answer = record(answerJson);
      ready =
        performance.now() <= deadline && response.status === HTTP_OK && answer['ready'] === true;
      if (ready) break;
    } catch {
      /* A cold Node process may not have bound its port yet. */
    }
    const remaining = Math.max(0, deadline - performance.now());
    await pause(Math.min(POLL_MS, remaining));
  }
  assert.ok(ready && !state.failed, 'The emitted Node Function did not become ready');
}

async function smoke(identity: NativeFixtureIdentity, env: NodeJS.ProcessEnv): Promise<void> {
  assert.ok(!processes.interrupted, 'The CI control was interrupted');
  const runtime = {
    v: 1,
    deploymentId: identity.deploymentId,
    functionName: identity.functionName,
    controlToken: TOKEN,
    capabilities: { services: {} },
  };
  const child = processes.start(path.join(BUNDLE_ROOT, 'upwind/server.mjs'), BUNDLE_ROOT, {
    ...env,
    NODE_ENV: 'production',
    NEXT_RUNTIME: 'nodejs',
    ARKOR_NODE_RUNTIME: JSON.stringify(runtime),
  });
  try {
    await waitForReady(child);
    const firstResponse = await request('/blog/first');
    const first = nextData(await bodyOf(firstResponse));
    assert.deepEqual(record(first['props'])['pageProps'], expected('first'));
    // Browser fallback fetches this exact Pages data route after receiving its initial shell.
    await bodyOf(await request('/blog/second'));
    const secondResponse = await request(
      `/_next/data/${encodeURIComponent(identity.buildId)}/blog/second.json`,
      true,
    );
    const secondJson: unknown = JSON.parse(await bodyOf(secondResponse));
    const second = record(secondJson);
    assert.deepEqual(second['pageProps'], expected('second'));
  } finally {
    await processes.stop(child);
  }
}

function cancel(): void {
  processes.interrupt();
}

async function finish(input: {
  readonly directory: string;
  readonly fixture: string;
  readonly runnerTemp: string;
  readonly failed: boolean;
  readonly validated: boolean;
}): Promise<void> {
  try {
    const closed = await processes.cleanup();
    if (closed && input.failed && input.validated) {
      try {
        const summary = await retainNativeNextDiagnostics(input.fixture, input.runnerTemp);
        console.warn(JSON.stringify({ kind: 'public-fixture-js-diagnostics', ...summary }));
      } catch {
        console.warn('Public fixture JavaScript diagnostics were unavailable');
      }
    }
    try {
      // eslint-disable-next-line security/detect-possible-timing-attacks -- A local cleanup ownership marker, never a remotely observable authentication check.
      if ((await readFile(path.join(BUNDLE_ROOT, OWNER_MARKER), 'utf8')) === TOKEN) {
        const names = await readdir(BUNDLE_ROOT);
        for (const name of names)
          await rm(path.join(BUNDLE_ROOT, name), { recursive: true, force: true });
      }
    } finally {
      await rm(input.directory, { recursive: true, force: true });
    }
    assert.ok(closed, 'CI process group cleanup failed');
  } catch (error) {
    if (!input.failed) throw error;
    console.warn('CI cleanup encountered a failure after the original control error');
  } finally {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
}

async function main(): Promise<void> {
  assert.equal(process.env['CI'], 'true', 'This helper runs only in isolated Linux CI');
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.node, NODE_VERSION);
  const report = record(process.report.getReport());
  const reportHeader = record(report['header']);
  assert.ok(
    typeof reportHeader['glibcVersionRuntime'] === 'string',
    'The CI runtime must use glibc',
  );
  assert.ok(
    process.env['NODE_OPTIONS'] === undefined,
    'Unset inherited Node loaders/options for this control',
  );
  const source = process.argv[2];
  const runnerTemp = process.env['RUNNER_TEMP'];
  assert.ok(
    source !== undefined && runnerTemp !== undefined,
    'Pass the fixed fixture path and RUNNER_TEMP',
  );
  assert.ok(
    (await lstat(BUNDLE_ROOT)).isDirectory() && (await readdir(BUNDLE_ROOT)).length === 0,
    'CI must provide an empty writable /bundle',
  );
  await writeFile(path.join(BUNDLE_ROOT, OWNER_MARKER), TOKEN, { flag: 'wx' });
  const temporaryRoot = await realpath(runnerTemp);
  const directory = await mkdtemp(path.join(temporaryRoot, 'upwind-native-next-'));
  const fixture = path.join(directory, 'fixture');
  let failed = false;
  let validated = false;
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  try {
    const config = path.join(directory, 'user.npmrc');
    const globalConfig = path.join(directory, 'global.npmrc');
    await writeFile(config, 'registry=https://registry.npmjs.org\n');
    await writeFile(globalConfig, 'registry=https://registry.npmjs.org\n');
    await mkdir(fixture);
    const env = environment(config, globalConfig);
    await prepare(await realpath(source), fixture, env);
    validated = true;
    await processes.command(['exec', 'next', 'build'], fixture, { env });
    const identity = await materializeNativeArtifact(fixture, BUNDLE_ROOT, NODE_VERSION);
    await smoke(identity, env);
    assert.ok(!processes.interrupted, 'The CI control was interrupted');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await finish({ directory, fixture, runnerTemp: temporaryRoot, failed, validated });
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
