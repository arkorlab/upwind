import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { writeApplication } from './check-application.ts';
import { checkLifecycle } from './check-lifecycle.ts';
import { fakeHost } from './fake-host.ts';
import { acceptsNpmConfig, acceptsNpmWorkspace, npmInstallArguments } from './install-policy.ts';

// The upstream js-yaml serialization, kept as input rather than produced by the policy under test.
const UPSTREAM_WORKSPACE = `blockExoticSubdeps: true
minimumReleaseAge: 2880
minimumReleaseAgeExclude:
  - '@mswjs/interceptors@0.42.5'
  - '@next/*'
  - '@turbo/*'
  - '@types/react@19.2.18'
  - '@types/react-dom@19.2.4'
  - '@vercel/*'
  - '@workflow/*'
  - babel-plugin-react-compiler
  - httpxy@0.5.5
  - next
  - react
  - react-dom
  - react-is
  - react-server-dom-*
  - satori@0.33.5
  - scheduler
  - turbo
`;

const DEFAULT_CONFIG = {
  before: null,
  force: false,
  global: false,
  'min-release-age': null,
  'min-release-age-exclude': [],
  'allow-git': 'all',
  'allow-remote': 'all',
  'allow-directory': 'all',
  'allow-file': 'all',
};

const WORKSPACE_HEADER_LINES = 3;
const WORKSPACE_ITEM_PREFIX = '  - ';
const EXPECTED_EXEMPTION_COUNT = 12;

const EXPECTED_NPM_ARGS = [
  'install',
  '--include=dev',
  '--no-audit',
  '--no-fund',
  '--package-lock=true',
  '--min-release-age=2',
  '--allow-git=root',
  '--allow-remote=root',
  '--allow-directory=root',
  '--allow-file=root',
  '--min-release-age-exclude=@next/*',
  '--min-release-age-exclude=@turbo/*',
  '--min-release-age-exclude=@vercel/*',
  '--min-release-age-exclude=@workflow/*',
  '--min-release-age-exclude=babel-plugin-react-compiler',
  '--min-release-age-exclude=next',
  '--min-release-age-exclude=react',
  '--min-release-age-exclude=react-dom',
  '--min-release-age-exclude=react-is',
  '--min-release-age-exclude=react-server-dom-*',
  '--min-release-age-exclude=scheduler',
  '--min-release-age-exclude=turbo',
];

interface ManagerCall {
  readonly command: string;
  readonly args: string[];
  readonly token: boolean;
  readonly tokenFile: boolean;
  readonly manager: boolean;
}

interface Scenario {
  readonly name: string;
  readonly manager: string | undefined;
  readonly fails?: boolean;
  readonly version?: string;
  readonly installExit?: number;
  readonly installSignal?: 'SIGTERM' | 'SIGPIPE';
  readonly configExit?: number;
  readonly config?: unknown;
  readonly workspace?: string;
  readonly symlinkWorkspace?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'default-pnpm', manager: undefined },
  { name: 'explicit-pnpm', manager: 'pnpm' },
  { name: 'npm', manager: 'npm' },
  { name: 'empty', manager: '', fails: true },
  { name: 'unknown', manager: 'other', fails: true },
  { name: 'unsupported-npm', manager: 'npm', version: '11.18.0', fails: true },
  { name: 'failed-probe', manager: 'npm', configExit: 7, fails: true },
  { name: 'failed-install', manager: 'npm', installExit: 7, fails: true },
  { name: 'terminated-install', manager: 'npm', installSignal: 'SIGTERM', fails: true },
  { name: 'broken-pipe-install', manager: 'npm', installSignal: 'SIGPIPE', fails: true },
  { name: 'symlink-workspace', manager: 'npm', symlinkWorkspace: true, fails: true },
  {
    name: 'custom-workspace',
    manager: 'npm',
    workspace: `${UPSTREAM_WORKSPACE}minimumReleaseAge: 4320\n`,
    fails: true,
  },
  {
    name: 'custom-age',
    manager: 'npm',
    config: { ...DEFAULT_CONFIG, 'min-release-age': 7 },
    fails: true,
  },
];

function configDenyingExotic(key: string): Record<string, unknown> {
  return { ...DEFAULT_CONFIG, [key]: 'none' };
}

function policyChecks(holds: (message: string, condition: boolean) => void): void {
  const upstreamExceptions = UPSTREAM_WORKSPACE.split('\n')
    .slice(WORKSPACE_HEADER_LINES, -1)
    .map((line) => line.slice(WORKSPACE_ITEM_PREFIX.length).replaceAll("'", ''));
  const jsonWorkspace = `${JSON.stringify(
    {
      blockExoticSubdeps: true,
      minimumReleaseAge: 2880,
      minimumReleaseAgeExclude: upstreamExceptions,
    },
    null,
    2,
  )}\n`;
  holds(
    'npm accepts absent and the original Next.js YAML/JSON workspace, including CRLF',
    acceptsNpmWorkspace(undefined) &&
      acceptsNpmWorkspace(UPSTREAM_WORKSPACE) &&
      acceptsNpmWorkspace(jsonWorkspace) &&
      acceptsNpmWorkspace(UPSTREAM_WORKSPACE.replaceAll('\n', '\r\n')),
  );
  const rejectedWorkspaces = [
    '',
    'packages: [apps/*]\n',
    UPSTREAM_WORKSPACE.replace('2880', '4320'),
    `${UPSTREAM_WORKSPACE}allowBuilds: {}\n`,
    UPSTREAM_WORKSPACE.replace('true', 'false'),
    UPSTREAM_WORKSPACE.replace('  - next\n', '  - next\n  - next\n'),
  ];
  holds(
    'npm refuses custom, duplicate, changed or additional workspace settings',
    rejectedWorkspaces.every((source) => !acceptsNpmWorkspace(source)),
  );
  const rejectedConfigs = [
    undefined,
    {},
    { ...DEFAULT_CONFIG, before: '2026-01-01' },
    { ...DEFAULT_CONFIG, force: true },
    { ...DEFAULT_CONFIG, global: true },
    { ...DEFAULT_CONFIG, 'min-release-age': 7 },
    { ...DEFAULT_CONFIG, 'min-release-age-exclude': ['private-policy'] },
    ...['allow-git', 'allow-remote', 'allow-directory', 'allow-file'].map((key) =>
      configDenyingExotic(key),
    ),
  ];
  holds(
    'npm checks effective security settings before adding its command-line policy',
    acceptsNpmConfig(DEFAULT_CONFIG) &&
      rejectedConfigs.every((config) => !acceptsNpmConfig(config)),
  );
  argumentChecks(holds);
}

function argumentChecks(holds: (message: string, condition: boolean) => void): void {
  const args = npmInstallArguments();
  const exemptions = args.filter((arg) => arg.startsWith('--min-release-age-exclude='));
  const exactPolicy = {
    ...DEFAULT_CONFIG,
    'min-release-age': 2,
    'min-release-age-exclude': exemptions.map((arg) =>
      arg.slice('--min-release-age-exclude='.length),
    ),
    'allow-git': 'root',
    'allow-remote': 'root',
    'allow-directory': 'root',
    'allow-file': 'root',
  };
  holds('npm also accepts the already-applied supported policy', acceptsNpmConfig(exactPolicy));
  holds(
    'npm keeps a two-day window, root-only exotic dependencies and no widened version exceptions',
    JSON.stringify(args) === JSON.stringify(EXPECTED_NPM_ARGS) &&
      args.includes('--min-release-age=2') &&
      ['git', 'remote', 'directory', 'file'].every((kind) =>
        args.includes(`--allow-${kind}=root`),
      ) &&
      exemptions.length === EXPECTED_EXEMPTION_COUNT &&
      exemptions.every((arg) => !/interceptors|@types\/react|httpxy|satori/u.test(arg)),
  );
}

interface ScenarioResult {
  readonly dir: string;
  readonly scenario: Scenario;
  readonly calls: ManagerCall[];
  readonly failure: unknown;
  readonly output: { stdout: string; stderr: string } | undefined;
}

type Check = (message: string, condition: boolean) => void;

function checkFailure(result: ScenarioResult, registered: string | undefined, holds: Check): void {
  const { dir, failure, scenario } = result;
  holds(
    `${scenario.name}: failure stops before build and deployment`,
    failure instanceof Error &&
      !existsSync(path.join(dir, '.adapter-build.log')) &&
      !existsSync(path.join(dir, '.adapter-build-output.log')) &&
      !existsSync(path.join(dir, 'lifecycle.txt')) &&
      registered === undefined,
  );
  const installs = result.calls.filter((call) => call.args[0] === 'install');
  const attempted = scenario.installExit !== undefined || scenario.installSignal !== undefined;
  const expectedInstalls = attempted ? 1 : 0;
  holds(`${scenario.name}: no unexpected install ran`, installs.length === expectedInstalls);
  checkInterrupted(result, holds);
}

function checkInterrupted(result: ScenarioResult, holds: Check): void {
  const signal = result.scenario.installSignal;
  if (signal === undefined) return;
  const ready = path.join(result.dir, 'manager-signal-ready');
  const installs = result.calls.filter((call) => call.args[0] === 'install');
  holds(
    `${result.scenario.name}: the one npm install reached the reset signal and did not survive it`,
    existsSync(ready) &&
      readFileSync(ready, 'utf8') === `${signal.slice('SIG'.length)}\n` &&
      !existsSync(path.join(result.dir, 'manager-signal-survived')) &&
      installs.length === 1 &&
      installs[0]?.command === 'npm' &&
      JSON.stringify(installs[0]?.args) === JSON.stringify(EXPECTED_NPM_ARGS),
  );
}

function checkSuccess(result: ScenarioResult, hostPort: number, holds: Check): void {
  const { dir, scenario, calls, failure, output } = result;
  const installs = calls.filter((call) => call.args[0] === 'install');
  const expectedArgs =
    scenario.manager === 'npm'
      ? EXPECTED_NPM_ARGS
      : ['install', '--no-frozen-lockfile', '--prod=false'];
  holds(
    `${scenario.name}: only the selected installer runs once`,
    failure === undefined &&
      installs.length === 1 &&
      JSON.stringify(installs[0]?.args) === JSON.stringify(expectedArgs) &&
      installs[0]?.command === (scenario.manager ?? 'pnpm'),
  );
  const build = readFileSync(path.join(dir, '.adapter-build.log'), 'utf8');
  checkLifecycle(dir, build, holds);
  holds(
    `${scenario.name}: build still uses pnpm and stdout stays the URL`,
    calls.some((call) => call.command === 'pnpm' && call.args.includes('run')) &&
      output?.stdout.trim() === `http://127.0.0.1:${String(hostPort)}`,
  );
}

function pnpmOnPath(): string {
  const directories = (process.env['PATH'] ?? '').split(path.delimiter);
  for (const dir of directories) {
    const candidate = path.join(dir, 'pnpm');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('the hook check requires pnpm on PATH');
}

function commandStubs(dir: string, pnpm: string): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const shared = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const options = JSON.parse(readFileSync('manager-options.json', 'utf8'));
const command = process.argv[1].endsWith('/npm') ? 'npm' : 'pnpm';
appendFileSync('manager-calls.jsonl', JSON.stringify({
  command, args,
  token: process.env.ARKOR_API_TOKEN !== undefined,
  tokenFile: process.env.ARKOR_API_TOKEN_FILE !== undefined,
  manager: process.env.ADAPTER_TEST_INSTALL_MANAGER !== undefined,
}) + '\n');
`;
  const npm = String.raw`${shared}
if (args[0] === '--version') console.log(options.version ?? '11.19.1');
else if (JSON.stringify(args) === JSON.stringify(['config', 'list', '--json'])) {
  console.log(JSON.stringify(options.config));
  console.error('probe output must stay private');
  process.exitCode = options.configExit ?? 0;
} else if (args[0] === 'install' && options.installSignal !== undefined) {
  // GNU env resets inherited SIGPIPE ignoring before exec; Node itself ignores SIGPIPE by default.
  // execve keeps the npm child's PID, so the installer must observe a signal, not a wrapper exit.
  const signal = options.installSignal.slice('SIG'.length);
  process.execve('/usr/bin/env', [
    'env', '--default-signal=' + signal, '/bin/sh', '-c',
    'printf "%s\n" "$1" >manager-signal-ready; kill -s "$1" "$$"; printf survived >manager-signal-survived',
    'npm-install-signal', signal,
  ], process.env);
  throw new Error('the signalled npm install returned from execve');
} else if (args[0] === 'install') process.exitCode = options.installExit ?? 0;
else throw new Error('unexpected npm command');
`;
  const pnpmScript = `${shared}
if (args[0] !== 'install') {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(${JSON.stringify(pnpm)}, args, { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
`;
  writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\n${npm}`, { mode: 0o700 });
  writeFileSync(path.join(bin, 'pnpm'), `#!${process.execPath}\n${pnpmScript}`, { mode: 0o700 });
  return bin;
}

function callsFrom(dir: string): ManagerCall[] {
  const file = path.join(dir, 'manager-calls.jsonl');
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as ManagerCall);
}

/** Inert install commands; the successful builds still use the existing pnpm lifecycle check. */
export async function installManagerScenarios(input: {
  readonly deploymentId: string;
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deploy: (
    dir: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly said: (error: unknown) => string | undefined;
  readonly holds: (message: string, condition: boolean) => void;
}): Promise<void> {
  policyChecks(input.holds);
  const pnpm = pnpmOnPath();
  for (const scenario of SCENARIOS) {
    const dir = path.join(input.workDir, `manager-${scenario.name}`);
    writeApplication(dir);
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), scenario.workspace ?? UPSTREAM_WORKSPACE);
    if (scenario.symlinkWorkspace === true) {
      const workspace = path.join(dir, 'pnpm-workspace.yaml');
      rmSync(workspace);
      writeFileSync(path.join(dir, 'policy.yaml'), UPSTREAM_WORKSPACE);
      symlinkSync('policy.yaml', workspace);
    }
    writeFileSync(
      path.join(dir, 'manager-options.json'),
      JSON.stringify({ ...scenario, config: scenario.config ?? DEFAULT_CONFIG }),
    );
    const bin = commandStubs(dir, pnpm);
    const host = await fakeHost(input.deploymentId);
    let failure: unknown;
    let output: { stdout: string; stderr: string } | undefined;
    try {
      try {
        output = await input.deploy(dir, {
          ...input.env,
          PATH: `${bin}${path.delimiter}${input.env['PATH'] ?? ''}`,
          ADAPTER_TEST_INSTALL_MANAGER: scenario.manager,
          ARKOR_API_URL: `http://127.0.0.1:${String(host.port)}`,
        });
      } catch (error) {
        failure = error;
      }
      const calls = callsFrom(dir);
      const result = { dir, scenario, calls, failure, output };
      input.holds(
        `${scenario.name}: install commands see neither credentials nor the manager control`,
        calls.every((call) => !call.token && !call.tokenFile && !call.manager),
      );
      if (scenario.fails === true) {
        checkFailure(result, host.registered(), input.holds);
      } else {
        checkSuccess(result, host.port, input.holds);
      }
      input.holds(
        `${scenario.name}: config probe output stays private`,
        !(output?.stderr ?? input.said(failure) ?? '').includes('probe output must stay private'),
      );
    } finally {
      host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
