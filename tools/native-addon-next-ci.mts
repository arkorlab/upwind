/**
 * CI only: build a fixed official native-addon fixture with the actual adapter, then run its
 * emitted Node Function on loopback. No Cloudflare service, credentials, browser or next start.
 * Usage: node tools/native-addon-next-ci.mts <pinned-next-checkout>/test/e2e/<fixture>, where
 * <fixture> is one of `FIXTURES`. The adapter is named by `NEXT_ADAPTER_PATH`, so a fixture's own
 * Next.js config stays as it is. Optional diagnostic: append --server-minification=off. This is
 * a separate build condition.
 * The Linux runner must provide an empty, writable /bundle, Node24.22.1 or Node26.13.0, pnpm12.15.0 and a C++
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
  rename,
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
import { fixtureOf, record, type Fixture } from './native-addon-next-fixtures.mts';
import { NativeNextProcesses, pause } from './native-addon-next-process.mts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEXT_VERSION = '16.4.3';
const NEXT_COMMIT = '29bbeab09981148ade186e8599ecdede15abc281';
const NODE_VERSION = process.versions.node;
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
type ServerMinification = 'default' | 'off';
const FIXTURE_CONFIG = 'next.config.js';
const FIXTURE_OWN_CONFIG = 'next.config.fixture.cjs';
function argumentsOf(values: readonly string[]): {
  readonly source: string;
  readonly serverMinification: ServerMinification;
} {
  assert.ok(
    [1, 2].includes(values.length),
    'Pass one fixture path and an optional diagnostic flag',
  );
  const source = values[0];
  const option = values[1];
  assert.ok(
    source !== undefined && source !== '' && !source.startsWith('-'),
    'Pass the fixed official fixture path first',
  );
  assert.ok(
    option === undefined || option === '--server-minification=off',
    'The only diagnostic flag is --server-minification=off',
  );
  return { source, serverMinification: option === undefined ? 'default' : 'off' };
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

async function copyFixture(source: string, target: string, fixture: Fixture): Promise<void> {
  assert.deepEqual(
    (await inventory(source)).toSorted(compareNames),
    Object.keys(fixture.pinned).toSorted(compareNames),
    'Official fixture inventory changed',
  );
  for (const [name, expectedBlob] of Object.entries(fixture.pinned)) {
    const bytes = await readFile(path.join(source, name));
    const blob = gitBlob(bytes);
    assert.equal(blob, expectedBlob, `Official fixture source changed: ${name}`);
    if (fixture.excluded.includes(name)) continue;
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await writeFile(path.join(target, name), bytes, { flag: 'wx' });
  }
  for (const [name, code] of Object.entries(fixture.added)) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await writeFile(path.join(target, name), code, { flag: 'wx' });
  }
}

function environment(userConfig: string, globalConfig: string, adapter: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    TMPDIR: process.env['TMPDIR'],
    NODE_ENV: 'development',
    CI: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_ADAPTER_PATH: adapter,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_registry: 'https://registry.npmjs.org',
  };
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** The diagnostic condition, over the copy: a fixture's own config is kept beneath it. */
async function disableServerMinification(directory: string): Promise<void> {
  const config = path.join(directory, FIXTURE_CONFIG);
  const own = await present(config);
  if (own) await rename(config, path.join(directory, FIXTURE_OWN_CONFIG));
  const base = own ? `require('./${FIXTURE_OWN_CONFIG}')` : '{}';
  await writeFile(
    config,
    `const base = ${base};\nmodule.exports = {...base, experimental: {...base.experimental, serverMinification: false}};\n`,
    { flag: 'wx' },
  );
}

const processes = new NativeNextProcesses();

async function prepare(
  source: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  build: { readonly fixture: Fixture; readonly serverMinification: ServerMinification },
): Promise<void> {
  const { fixture, serverMinification } = build;
  await copyFixture(source, directory, fixture);
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
          ...fixture.dependencies,
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
  if (serverMinification === 'off') await disableServerMinification(directory);
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

function request(
  pathname: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:8080${pathname}`, {
    headers: {
      ...headers,
      'x-upwind-control-token': TOKEN,
      'x-upwind-request-url': `https://native-ci.test${pathname}`,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_MS),
  });
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

async function smoke(
  identity: NativeFixtureIdentity,
  env: NodeJS.ProcessEnv,
  fixture: Fixture,
): Promise<readonly string[]> {
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
    return await fixture.smoke(identity, { request, body: bodyOf });
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
  assert.ok(
    NODE_VERSION === '24.22.1' || NODE_VERSION === '26.13.0',
    'Pinned producer Node required',
  );
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
  const { source, serverMinification } = argumentsOf(process.argv.slice(2));
  const fixture = fixtureOf(source);
  const adapter = path.join(ROOT, 'packages/adapter/dist/index.js');
  assert.ok((await lstat(adapter)).isFile(), 'Build the SDK before this CI helper');
  const conditions = {
    bundler: 'turbopack',
    serverMinification,
    diagnosticOnly: serverMinification === 'off',
  };
  const runnerTemp = process.env['RUNNER_TEMP'];
  assert.ok(runnerTemp !== undefined, 'Pass RUNNER_TEMP for the isolated control');
  assert.ok(
    (await lstat(BUNDLE_ROOT)).isDirectory() && (await readdir(BUNDLE_ROOT)).length === 0,
    'CI must provide an empty writable /bundle',
  );
  await writeFile(path.join(BUNDLE_ROOT, OWNER_MARKER), TOKEN, { flag: 'wx' });
  const temporaryRoot = await realpath(runnerTemp);
  const directory = await mkdtemp(path.join(temporaryRoot, 'upwind-native-next-'));
  const fixtureDirectory = path.join(directory, 'fixture');
  let failed = false;
  let validated = false;
  let paths: readonly string[] | undefined;
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  try {
    const config = path.join(directory, 'user.npmrc');
    const globalConfig = path.join(directory, 'global.npmrc');
    await writeFile(config, 'registry=https://registry.npmjs.org\n');
    await writeFile(globalConfig, 'registry=https://registry.npmjs.org\n');
    await mkdir(fixtureDirectory);
    const env = environment(config, globalConfig, adapter);
    await prepare(await realpath(source), fixtureDirectory, env, { fixture, serverMinification });
    validated = true;
    console.log(
      JSON.stringify({
        kind: 'native-next-build-conditions',
        nextVersion: NEXT_VERSION,
        nextCommit: NEXT_COMMIT,
        ...conditions,
      }),
    );
    await processes.command(['exec', 'next', 'build'], fixtureDirectory, {
      env: { ...env, NODE_ENV: 'production' },
    });
    const identity = await materializeNativeArtifact(fixtureDirectory, BUNDLE_ROOT, NODE_VERSION);
    paths = await smoke(identity, env, fixture);
    assert.ok(!processes.interrupted, 'The CI control was interrupted');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await finish({
      directory,
      fixture: fixtureDirectory,
      runnerTemp: temporaryRoot,
      failed,
      validated,
    });
  }
  console.log(
    JSON.stringify({
      complete: true,
      ...conditions,
      nextVersion: NEXT_VERSION,
      nextCommit: NEXT_COMMIT,
      fixture: path.basename(source),
      nativeFunctions: 1,
      paths,
      nativeContextAware: true,
    }),
  );
}

await main();
