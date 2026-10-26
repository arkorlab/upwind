import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { bundleProject } from './bundle-project.ts';
import { deploymentEnvironment } from './fixture-env.ts';
import { withinHook } from './hook.ts';
import { CLOUDFLARE_SERVING, NODE_LISTENING } from './local-protocol.ts';

/**
 * A fixture served on this machine, for the targets that need no host (`target.ts`): on Cloudflare's
 * runtime, by a local stack on workerd (`serve-cloudflare.ts`), or on Node.js's, by the native server
 * `upwind start` runs. Either is a process of its own, started apart from the deploy hook so that it
 * outlives it — the suite's tests run after the hook has printed the URL and exited — and stopped by
 * the cleanup hook, through the file that names it.
 *
 * What the server is given is the application's environment, as a host would give a deployment of it
 * (`deploymentEnvironment`): its `.env` files and the suite's variables. Nothing of this machine's
 * beyond what a process needs to start — no variable of the suite's harness, nor of this tool.
 */

/** What the server says, as it runs: kept apart from the deploy hook's own account. */
export const RUNTIME_LOG = '.adapter-runtime.log';
/** The server's process, which leads a group of its own: what the cleanup hook stops. */
const PID_FILE = '.adapter-server.pid';
/** The application's environment, for the server alone. */
const ENV_FILE = '.adapter-env.json';
const PRIVATE_FILE_MODE = 0o600;
/** How long a server may take to say it serves: a stack starts workerd and bundles its Workers. */
const START_MS = 180_000;
/** How long a server may take to stop once asked, before it is made to. */
const STOP_MS = 15_000;
const POLL_MS = 250;
/** How long one connection of the readiness check may take. */
const ASK_MS = 5000;
/** How much of what a server said goes with a failure to start it. */
const TAIL_BYTES = 4000;

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const UPWIND_CLI = path.join(REPO, 'packages', 'upwind', 'src', 'cli.ts');
const SERVE_CLOUDFLARE = path.join(import.meta.dirname, 'serve-cloudflare.ts');

export interface LocalServeInput {
  readonly appDir: string;
  readonly target: 'cloudflare' | 'node';
  readonly log: (message: string) => void;
  /** When the suite's hook stops waiting (`hook.ts`). */
  readonly deadline: number | undefined;
}

/** What starts the server, and what it says before its address. */
function commandOf(
  target: 'cloudflare' | 'node',
  projectDir: string,
  envFile: string,
): { readonly args: string[]; readonly ready: string } {
  if (target === 'cloudflare') {
    return {
      args: [SERVE_CLOUDFLARE, path.join(projectDir, '.arkor'), envFile],
      ready: CLOUDFLARE_SERVING,
    };
  }
  return {
    args: [UPWIND_CLI, 'start', projectDir, '--port', '0', '--hostname', '127.0.0.1'],
    ready: NODE_LISTENING,
  };
}

/** The environment a server process starts with: what it needs to run, and the application's own. */
function serverEnvironment(
  target: 'cloudflare' | 'node',
  application: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    ...(process.env['PATH'] !== undefined && { PATH: process.env['PATH'] }),
    ...(process.env['HOME'] !== undefined && { HOME: process.env['HOME'] }),
  };
  // The native server reads the application's environment as its own process's; the stack hands
  // its Functions the file's, and its own process needs none of it.
  return target === 'node' ? { ...application, ...base } : base;
}

/** The address a server's output says it serves on, once it has said so: the rest of that line. */
function addressIn(output: string, ready: string): string | undefined {
  const line = output.split('\n').find((printed) => printed.startsWith(ready));
  const address = line?.slice(ready.length).trim();
  return address === undefined || address === '' ? undefined : address;
}

function printedIn(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function tailOf(file: string): string {
  const all = printedIn(file);
  return all.length > TAIL_BYTES ? `…${all.slice(-TAIL_BYTES)}` : all;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for the server to say where it serves, or to end first. */
async function servedAt(
  child: ChildProcess,
  logFile: string,
  ready: string,
  end: number,
): Promise<string> {
  while (Date.now() < end) {
    const address = addressIn(printedIn(logFile), ready);
    if (address !== undefined) {
      return address;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the server ended before it served:\n${tailOf(logFile)}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`the server did not say it serves in time:\n${tailOf(logFile)}`);
}

/** Whether a connection to the address is taken, before `ASK_MS`: nothing is asked over it. */
function accepts(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({
      host: url.hostname.replace(/^\[(.*)\]$/u, '$1'),
      port: Number(url.port),
      timeout: ASK_MS,
    });
    const settle = (taken: boolean): void => {
      socket.destroy();
      resolve(taken);
    };
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('timeout', () => {
      settle(false);
    });
    socket.once('error', () => {
      settle(false);
    });
  });
}

/**
 * Wait until the server takes a connection. A connection and no request: a request is one of the
 * suite's to make, and the first the application sees is one of its tests' — a suite counts its
 * renders (`root-layout-render-once`), or which runtime registered its instrumentation first
 * (`instrumentation-hook`), and a `GET /` of this tool's ran the root layout and the middleware ahead
 * of them.
 */
async function accepting(url: string, end: number): Promise<void> {
  const address = new URL(url);
  while (Date.now() < end) {
    if (await accepts(address)) {
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${url} did not take a connection in time`);
}

/** Serve the fixture here; its URL, once it answers. */
export async function serveLocally(input: LocalServeInput): Promise<string> {
  const { appDir, target } = input;
  const projectDir = await bundleProject(appDir, process.env['NEXT_DEPLOYMENT_ID'], target);
  const { entries, said } = await deploymentEnvironment(projectDir, process.env);
  input.log(`the environment: ${said}`);
  const application = Object.fromEntries(
    entries.flatMap(({ name, value }) => (value === null ? [] : [[name, value] as const])),
  );
  const envFile = path.join(appDir, ENV_FILE);
  writeFileSync(envFile, JSON.stringify(application), { mode: PRIVATE_FILE_MODE });
  const { args, ready } = commandOf(target, projectDir, envFile);
  const logFile = path.join(appDir, RUNTIME_LOG);
  // Each server's own log, begun afresh: a server started again in the same directory would otherwise
  // find the address an earlier one said, and wait on a port nothing serves any more (greptile).
  const output = openSync(logFile, 'w');
  let child: ChildProcess;
  try {
    // A group of its own (`detached`), so that the cleanup hook stops what it started — workerd under
    // the stack, the server under `upwind start` — and not the harness that started the hook.
    child = spawn(process.execPath, args, {
      cwd: appDir,
      detached: true,
      env: serverEnvironment(target, application),
      stdio: ['ignore', output, output],
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`the server could not be started:\n${tailOf(logFile)}`);
  }
  writeFileSync(path.join(appDir, PID_FILE), String(child.pid));
  input.log(
    `serving on ${target === 'cloudflare' ? "Cloudflare's runtime, by a local stack" : 'Node.js, by `upwind start`'} (process ${String(child.pid)})`,
  );
  const end = withinHook(Date.now() + START_MS, input.deadline);
  try {
    const url = new URL(await servedAt(child, logFile, ready, end)).origin;
    await accepting(url, end);
    input.log(`served at ${url}`);
    return url;
  } catch (error) {
    await stopLocally(appDir);
    throw error;
  }
}

/** Stop the server serving the fixture here, if there is one: asked first, then made to. */
export async function stopLocally(appDir: string): Promise<void> {
  const file = path.join(appDir, PID_FILE);
  if (!existsSync(file)) {
    return;
  }
  const pid = Number(readFileSync(file, 'utf8'));
  rmSync(file, { force: true });
  rmSync(path.join(appDir, ENV_FILE), { force: true });
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  signalGroup(pid, 'SIGTERM');
  const end = Date.now() + STOP_MS;
  while (Date.now() < end && alive(pid)) {
    await sleep(POLL_MS);
  }
  // Whatever of the group is left — workerd under a stack that did not let it go — is ended now.
  signalGroup(pid, 'SIGKILL');
}
