import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `build` half of `check-deploy.ts`, in a job that holds no credentials, and what both halves
 * share: the packages an application installs, packed the way a release packs them — by pnpm, which
 * folds each package's `publishConfig` in, so the CLI installed is its built `dist/` (the deploy and
 * host code and the Workers it ships bundled into it, the still-private packages among them) and the
 * adapter its built `exports` — and `fixtures/next-minimal` copied three times, each copy saying its
 * own name on its home page, installed from those packs with npm, as an application outside this
 * workspace installs a release, and built with `upwind deploy --build-only`.
 *
 * The packs are the four `ci.yaml`'s generated application installs, and installed the same way:
 * the CLI and the adapter as the project's own dependencies, and the core and the runtime, which
 * both of those name by version, overridden with the packs this checkout made.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE = path.join(ROOT, 'fixtures', 'next-minimal');
const PACKAGES = ['core', 'runtime', 'adapter', 'upwind'] as const;
export const VERSIONS = ['v1', 'v2', 'v3'] as const;
export type Version = (typeof VERSIONS)[number];

/** What a build's home page says, which is how a request tells the deployments apart. */
const FIXTURE_HOME = '<p>next-minimal</p>';
export const BLOG_PAGE = '/blog/first';
/** The paths a deploy checks before it switches (`deploy.checks`): one of each kind it can tell. */
export const CHECKS = ['/', '/hello', BLOG_PAGE, '/api/ping'];
/** The project's settings beside its name, which the `run` half gives it. */
export const CONFIG_FILE = 'upwind.json';
/** A command takes at most this long, twenty minutes; a deploy waits on Cloudflare at several steps. */
const COMMAND_TIMEOUT_MS = 1_200_000;

export function say(text: string): void {
  console.log(`check-deploy: ${text}`);
}

export function homeOf(version: Version): string {
  return `upwind ci ${version}`;
}

/** A command, its output passed through; what it exited with, and what it printed where asked. */
export function command(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly capture?: boolean },
): { readonly status: number; readonly stdout: string } {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: options.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  // Nothing at all where the output went straight through, whatever the type says.
  const printed: unknown = result.stdout;
  const stdout = typeof printed === 'string' ? printed : '';
  if (options.capture === true) {
    process.stdout.write(stdout);
  }
  return { status: result.status ?? 1, stdout };
}

export function succeed(file: string, args: readonly string[], cwd: string): void {
  const { status } = command(file, args, { cwd });
  assert.equal(status, 0, `${path.basename(file)} ${args.join(' ')} exited ${String(status)}`);
}

/** What of the fixture a copy takes: its sources, and nothing a build or an install left. */
function isSource(source: string): boolean {
  const name = path.basename(source);
  return !['.arkor', '.next', '.upwind', 'node_modules', 'package-lock.json'].includes(name);
}

/**
 * A pack, as a copy's manifest names it: relative, so that the job that deploys installs the same
 * tree from the same packs wherever its artifact is downloaded to (`npm ci` against the lockfile the
 * install here writes).
 */
function packOf(name: string): string {
  return `file:../packages/${name}.tgz`;
}

/** The fixture, copied as one version: its home page saying which, installed from the packs. */
async function copyFixture(out: string, version: Version): Promise<string> {
  const dir = path.join(out, version);
  await cp(FIXTURE, dir, { recursive: true, filter: (source) => isSource(source) });
  const page = path.join(dir, 'app', 'page.js');
  const source = await readFile(page, 'utf8');
  assert.ok(source.includes(FIXTURE_HOME), `${page} no longer says ${FIXTURE_HOME}`);
  await writeFile(
    page,
    source.replace(FIXTURE_HOME, () => `<p>${homeOf(version)}</p>`),
  );
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        name: 'upwind-ci',
        devDependencies: { upwind: packOf('upwind'), '@stayingupwind/adapter': packOf('adapter') },
        // The adapter and the CLI name these by version; the packs are what this checkout made.
        overrides: {
          '@stayingupwind/core': packOf('core'),
          '@stayingupwind/runtime': packOf('runtime'),
        },
      },
      undefined,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(dir, CONFIG_FILE),
    `${JSON.stringify({ deploy: { checks: CHECKS } }, undefined, 2)}\n`,
  );
  return dir;
}

/** Pack the packages, then copy, install and build each version. */
export async function buildAll(out: string): Promise<void> {
  const packs = path.join(out, 'packages');
  await mkdir(packs, { recursive: true });
  for (const name of PACKAGES) {
    succeed(
      'pnpm',
      [
        '--dir',
        path.join(ROOT, 'packages', name),
        'pack',
        '--out',
        path.join(packs, `${name}.tgz`),
      ],
      ROOT,
    );
  }
  for (const version of VERSIONS) {
    const dir = await copyFixture(out, version);
    say(`installing and building ${version}`);
    succeed('npm', ['install', '--no-audit', '--no-fund'], dir);
    // The build stops where a deploy would reach the account, which this job could not.
    succeed(process.execPath, [cliOf(dir), 'deploy', dir, '--build-only'], dir);
  }
}

export function cliOf(dir: string): string {
  return path.join(dir, 'node_modules', 'upwind', 'dist', 'cli.js');
}
