import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CHECKS, cliOf, copyFixture, homeOf, packAll, succeed } from './check-deploy-build.ts';

/**
 * `upwind preview` as an application outside this workspace runs it: the packages packed as a
 * release packs them — the CLI as its built `dist/`, with the stack it serves on and the Workers it
 * ships bundled into it — and `fixtures/next-minimal` copied and installed from them with npm, then
 * built with `upwind build`. Then:
 *
 * - `upwind preview --check`, which asks every route and file of the build once, as a deployment's
 *   edge has to answer it, and the paths `deploy.checks` names;
 * - `upwind preview`, served on a free port, asked over HTTP for the home page and each of those
 *   paths, then stopped with SIGINT: it has to end on its own, and its port with it.
 *
 * Nothing here holds a credential, so it runs wherever a pull request runs.
 *
 *   node scripts/check-preview.ts --out <dir>
 */

const VERSION = 'v1';

function say(text: string): void {
  console.log(`check-preview: ${text}`);
}
/** How long a check may take: every route and file of the build, asked one after another. */
const CHECK_MS = 600_000;
/** How long a preview may take to start serving; its stack bundles nothing, but workerd starts. */
const START_MS = 120_000;
/** How long a stopped preview may take to end. */
const STOP_MS = 30_000;
/** What a preview says once it serves, with where. */
const SERVING = /^upwind: serving \S+ at (\S+)/mu;
/** What a preview says of a build made without the runtime cache's host, which `upwind build` puts in. */
const NO_CACHE_HOST = "built without the runtime cache's host";
const OK = 200;
const SERVER_ERROR = 500;

/** Ask the build once: it has to pass, and say nothing of a missing cache host. */
function checkOnce(dir: string): void {
  const result = spawnSync(process.execPath, [cliOf(dir), 'preview', dir, '--check'], {
    cwd: dir,
    encoding: 'utf8',
    env: process.env,
    timeout: CHECK_MS,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `upwind preview --check exited ${String(result.status)}`);
  assert.ok(
    !`${result.stdout}${result.stderr}`.includes(NO_CACHE_HOST),
    'the build has no runtime cache host',
  );
}

/** Serve the build, ask it, and stop it with SIGINT: it ends, and its port is let go. */
async function serveAndStop(dir: string): Promise<void> {
  // The CLI itself, not a launcher before it, so that the signal reaches the process that serves.
  const child = spawn(process.execPath, [cliOf(dir), 'preview', dir, '-p', '0'], {
    cwd: dir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  try {
    const site = await servedAt(child.stdout, exited);
    say(`serving at ${site.href}`);
    const home = await fetch(site);
    assert.equal(home.status, OK, `/ was answered ${String(home.status)}`);
    assert.ok((await home.text()).includes(homeOf(VERSION)), '/ is not the build that was made');
    for (const asked of CHECKS) {
      const response = await fetch(new URL(asked, site), { redirect: 'manual' });
      await response.body?.cancel();
      assert.ok(response.status < SERVER_ERROR, `${asked} was answered ${String(response.status)}`);
    }
    child.kill('SIGINT');
    const [code, signal] = await within(exited, STOP_MS, 'the preview did not end on SIGINT');
    assert.equal(signal, null, `the preview ended on ${String(signal)}, not on its own`);
    assert.equal(code, 0, `the preview exited ${String(code)} on SIGINT`);
    await assert.rejects(fetch(site), 'the preview still answers once it ended');
    say('stopped on SIGINT, and its port with it');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}

/** Where the preview says it serves, read from what it prints; it may not end first. */
async function servedAt(stdout: NodeJS.ReadableStream, exited: Promise<unknown>): Promise<URL> {
  const output = { printed: '' };
  const found = new Promise<URL>((resolve) => {
    stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output.printed += chunk.toString('utf8');
      const match = SERVING.exec(output.printed);
      if (match?.[1] !== undefined) {
        resolve(new URL(match[1]));
      }
    });
  });
  return within(
    Promise.race([found, endedFirst(exited, output)]),
    START_MS,
    'the preview did not serve in time',
  );
}

/** A preview that ended, which it should not have before it served. */
async function endedFirst(
  exited: Promise<unknown>,
  output: { readonly printed: string },
): Promise<never> {
  await exited;
  throw new Error(`the preview ended before it served:\n${output.printed}`);
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const { promise: late, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    reject(new Error(what));
  }, ms);
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
  if (values.out === undefined) {
    throw new Error('usage: check-preview.ts --out <dir>');
  }
  const out = path.resolve(values.out);
  process.env['NEXT_TELEMETRY_DISABLED'] = '1';
  await packAll(out);
  const dir = await copyFixture(out, VERSION);
  say('installing and building');
  succeed('npm', ['install', '--no-audit', '--no-fund'], dir);
  succeed(process.execPath, [cliOf(dir), 'build', dir], dir);
  say('checking the build once');
  checkOnce(dir);
  say('serving it');
  await serveAndStop(dir);
}

await main();
