/** CI-only independent compiler producer. Its output is unqualified DATA, never a trusted catalog. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicPagesCorpus, sha256 } from './native-pages-handler-profile/format.mts';
import {
  FIXTURE_FILES,
  IMAGE,
  IMAGE_ID,
  NEXT_SOURCE,
  PACKAGE_MANAGER,
  SWC_INTEGRITY,
} from './native-pages-handler-profile/inputs.mts';
import {
  pagesHandlerProfileInputs,
  type PagesHandlerProfileInputs,
} from './native-pages-handler-profile/options.mts';
import { command } from './native-pages-handler-profile/process.mts';

const INPUTS = fileURLToPath(new URL('native-pages-handler-profile/', import.meta.url));
const NEXT_HANDLER = 'node_modules/next/dist/server/route-modules/pages/pages-handler.js';
const FILE_MODE = 0o700;
const NODE_VERSION = '24.22.1';
const PNPM_VERSION = '12.15.0';
const GLOBAL_CONFIG = 'empty-global-config';
const USER_CONFIG = 'empty-user-config';

function hostEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    CI: '1',
    HOME: home,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    PATH: process.env['PATH'],
    npm_config_globalconfig: path.join(home, GLOBAL_CONFIG),
    npm_config_registry: 'https://registry.npmjs.org',
    npm_config_userconfig: path.join(home, USER_CONFIG),
  };
}

async function inputIdentity(profile: PagesHandlerProfileInputs): Promise<string> {
  const inventory: string[] = [];
  for (const file of profile.files) {
    const bytes = await readFile(path.join(INPUTS, file.source));
    assert.equal(sha256(bytes), file.sha256, 'Fixed public compiler fixture changed');
    inventory.push(`${file.target}:${file.sha256}`);
  }
  return sha256(inventory.join('\n'));
}

async function prepare(
  root: string,
  cohort: string,
  profile: PagesHandlerProfileInputs,
): Promise<{ project: string; environment: NodeJS.ProcessEnv }> {
  const directory = path.join(root, cohort);
  const home = path.join(directory, 'home');
  const project = path.join(directory, 'project');
  await mkdir(home, { mode: FILE_MODE, recursive: true });
  await writeFile(path.join(home, GLOBAL_CONFIG), '');
  await writeFile(path.join(home, USER_CONFIG), '');
  await mkdir(project, { mode: FILE_MODE });
  for (const file of profile.files) {
    const target = path.join(project, file.target);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(INPUTS, file.source), target, { errorOnExist: true, force: false });
  }
  const environment = hostEnvironment(home);
  await command(
    'pnpm',
    [
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--store-dir',
      path.join(directory, 'store'),
    ],
    project,
    environment,
  );
  const packageJson: unknown = JSON.parse(
    await readFile(path.join(project, 'node_modules/next/package.json'), 'utf8'),
  );
  assert.ok(
    typeof packageJson === 'object' &&
      packageJson !== null &&
      'version' in packageJson &&
      packageJson.version === '16.4.3',
    'Installed public Next version changed',
  );
  const originalHandler = await readFile(path.join(project, NEXT_HANDLER));
  assert.equal(sha256(originalHandler), NEXT_SOURCE, 'Published getHandler source changed');
  return { environment, project };
}

function compileArguments(project: string, name: string): string[] {
  return [
    'run',
    '--name',
    name,
    '--platform',
    'linux/amd64',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '6g',
    '--cpus',
    '4',
    '--pids-limit',
    '512',
    '--user',
    `${process.getuid?.()}:${process.getgid?.()}`,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=2147483648,mode=1777',
    '--mount',
    `type=bind,src=${project},dst=/work`,
    '--workdir',
    '/work',
    '--env',
    'CI=1',
    '--env',
    'NODE_ENV=production',
    '--env',
    'HOME=/tmp',
    '--env',
    'NEXT_TELEMETRY_DISABLED=1',
    '--env',
    'TZ=UTC',
    '--env',
    'LANG=C.UTF-8',
    IMAGE_ID,
    'node',
    'node_modules/next/dist/bin/next',
    'build',
    '--turbopack',
  ];
}

async function compile(
  root: string,
  cohort: string,
  cleanup: string[],
  profile: PagesHandlerProfileInputs,
): Promise<readonly unknown[]> {
  const { environment, project } = await prepare(root, cohort, profile);
  const name = `pages-handler-profile-${path.basename(root)}-${cohort}`;
  cleanup.push(name);
  await command('docker', compileArguments(project, name), root, environment);
  const used = await command(
    'docker',
    ['inspect', '--format', '{{.Image}}', name],
    root,
    environment,
  );
  assert.equal(used, IMAGE_ID, 'Independent compilation used a different image');
  return publicPagesCorpus(project);
}

async function produce(temporary: string, profile: PagesHandlerProfileInputs): Promise<void> {
  assert.equal(process.versions.node, NODE_VERSION, 'Pinned producer Node required');
  assert.ok(
    process.platform === 'linux' && process.arch === 'x64',
    'Pinned Linux compiler platform required',
  );
  const fixture = await inputIdentity(profile);
  const root = await mkdtemp(path.join(temporary, 'pages-handler-public-'));
  const environment = hostEnvironment(root);
  const cleanup: string[] = [];
  try {
    await writeFile(path.join(root, GLOBAL_CONFIG), '');
    await writeFile(path.join(root, USER_CONFIG), '');
    assert.equal(
      await command('pnpm', ['--version'], root, environment),
      PNPM_VERSION,
      'Pinned package manager required',
    );
    await command('docker', ['pull', '--platform', 'linux/amd64', IMAGE], root, environment);
    assert.equal(
      await command(
        'docker',
        ['image', 'inspect', '--format', '{{.Id}}', IMAGE],
        root,
        environment,
      ),
      IMAGE_ID,
      'Pinned image identity changed',
    );
    const first = await compile(root, 'first', cleanup, profile);
    const second = await compile(root, 'second', cleanup, profile);
    assert.equal(
      JSON.stringify(first),
      JSON.stringify(second),
      'Two clean public compilations differ; no normalization is permitted',
    );
    const output = path.join(temporary, profile.outputName);
    await mkdir(output);
    await writeFile(
      path.join(output, 'UNQUALIFIED.json'),
      `${JSON.stringify({
        files: first,
        inputs: {
          fixture,
          image: IMAGE_ID.slice('sha256:'.length),
          lock: FIXTURE_FILES['pnpm-lock.yaml'],
          next: NEXT_SOURCE,
          packageManager: sha256(PACKAGE_MANAGER),
          swc: sha256(SWC_INTEGRITY),
        },
        schema: 1,
        semanticClosure: 'unmapped:getHandler',
        status: 'UNQUALIFIED',
      })}\n`,
      { flag: 'wx' },
    );
    console.info(
      'Independent public compilations agree; getHandler semantic closure remains UNQUALIFIED.',
    );
  } finally {
    for (const name of cleanup) {
      try {
        await command('docker', ['rm', '--force', name], root, environment);
      } catch {
        console.warn('Independent compiler container cleanup failed');
      }
    }
    try {
      await rm(root, { force: true, recursive: true });
    } catch {
      console.warn('Independent compiler temporary cleanup failed');
    }
  }
}

const profile = pagesHandlerProfileInputs(process.argv.slice(2));
const temporary = process.env['RUNNER_TEMP'];
assert.ok(
  typeof temporary === 'string' && path.isAbsolute(temporary),
  'A runner temporary directory is required',
);
await produce(temporary, profile);
