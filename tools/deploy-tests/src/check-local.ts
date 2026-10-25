import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { type Target, TARGET_ENV } from './target.ts';

/**
 * The three hooks, run for real on this machine's targets: `fixtures/next-minimal` copied, then
 * installed, built and served by the deploy hook as the suite's harness would have it, asked over
 * HTTP, its markers read back through the logs hook, and its server stopped by the cleanup hook.
 *
 * What the fake host of `check.ts` cannot say: that a real build is served at all on Cloudflare's
 * runtime and on Node.js's — the server started apart from the hook, still answering once the hook
 * has exited, gone once the cleanup hook has run. No credential and no Next.js checkout: the fixture
 * installs a released Next.js, and the adapter is this checkout's `dist`
 * (`pnpm --filter @stayingupwind/adapter build` first).
 *
 *   node tools/deploy-tests/src/check-local.ts [--target cloudflare|node]
 */

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const SCRIPTS = path.join(import.meta.dirname, '..', 'scripts');
const FIXTURE = path.join(REPO, 'fixtures', 'next-minimal');
const TARGETS = ['cloudflare', 'node'] as const satisfies readonly Target[];
/** What the fixture's home page says. */
const HOME = '<p>next-minimal</p>';
/** A hook builds the fixture, installs first: minutes, not seconds. */
const HOOK_MS = 900_000;
/** How long a stopped server may take to let its port go. */
const GONE_MS = 30_000;
const POLL_MS = 500;
/** How long one request asking whether the server still answers may take. */
const ASK_MS = 2000;
const OK = 200;

function say(text: string): void {
  console.log(`check-local: ${text}`);
}

/** What the fixture's copy takes: its sources, and nothing a build or an install left. */
function isSource(source: string): boolean {
  return !['.arkor', '.next', '.upwind', 'node_modules'].includes(path.basename(source));
}

/** A hook, run in the application as the suite's harness runs it; what it printed on standard output. */
async function hook(name: string, appDir: string, target: Target): Promise<string> {
  // The script itself, by its own path, as the suite's harness starts it: it is executable and
  // carries a shebang.
  const child = spawn(path.join(SCRIPTS, name), [], {
    cwd: appDir,
    env: {
      ...process.env,
      [TARGET_ENV]: target,
      ADAPTER_DIR: REPO,
      // The suite's harness is this process: what it was started with is not the suite's.
      ADAPTER_TEST_HARNESS_PID: String(process.pid),
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, HOOK_MS);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, `${name} exited ${String(code)}`);
  } finally {
    clearTimeout(timer);
  }
  return stdout;
}

/** Whether the site still answers anything at all. */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ASK_MS) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function checkTarget(target: Target, root: string): Promise<void> {
  const appDir = path.join(root, target);
  cpSync(FIXTURE, appDir, { recursive: true, filter: (source) => isSource(source) });
  say(`${target}: deploying a copy of next-minimal`);
  try {
    const printed = await hook('e2e-deploy.sh', appDir, target);
    const lines = printed.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1, `the deploy hook printed more than a URL:\n${printed}`);
    const url = new URL(lines[0] ?? '');
    say(`${target}: served at ${url.href}`);

    const home = await fetch(url);
    assert.equal(home.status, OK, `/ was answered ${String(home.status)}`);
    assert.ok((await home.text()).includes(HOME), '/ is not the fixture');

    const logs = await hook('e2e-logs.sh', appDir, target);
    assert.match(logs, /^BUILD_ID: \S+$/mu, 'the logs name no build id');
    assert.match(logs, /^DEPLOYMENT_ID: dpl_\w+$/mu, 'the logs name no deployment');
    assert.match(
      logs,
      /^NEXT_SUPPORTS_IMMUTABLE_ASSETS: [01]$/mu,
      'the logs say nothing of assets',
    );

    await hook('e2e-cleanup.sh', appDir, target);
    const end = Date.now() + GONE_MS;
    while ((await answers(url.href)) && Date.now() < end) {
      await sleep(POLL_MS);
    }
    assert.ok(!(await answers(url.href)), 'the server still answers after the cleanup hook');
    assert.ok(!existsSync(path.join(appDir, '.adapter-server.pid')), 'the server is still named');
    say(`${target}: stopped by the cleanup hook`);
  } finally {
    await cleanedUp(appDir, target);
  }
}

/** Whatever happened before, nothing is left serving: the cleanup hook once more, its failure aside. */
async function cleanedUp(appDir: string, target: Target): Promise<void> {
  try {
    await hook('e2e-cleanup.sh', appDir, target);
  } catch {
    // The check's own failure, if any, is the one to report.
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { target: { type: 'string', multiple: true } },
    strict: true,
  });
  const asked = values.target ?? [...TARGETS];
  for (const target of asked) {
    if (!(TARGETS as readonly string[]).includes(target)) {
      throw new Error(`--target must be one of ${TARGETS.join(', ')}`);
    }
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'upwind-deploy-tests-local-'));
  try {
    for (const target of asked as Target[]) {
      await checkTarget(target, root);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  say('every hook did its part');
}

await main();
