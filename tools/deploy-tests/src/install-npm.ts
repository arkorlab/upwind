import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, type Stats } from 'node:fs';

import {
  acceptsNpmConfig,
  acceptsNpmWorkspace,
  INSTALL_NPM_VERSION,
  npmInstallArguments,
} from './install-policy.ts';

const MAX_POLICY_BYTES = 65_536;
const PROBE_TIMEOUT_MS = 10_000;

class InstallPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallPolicyError';
  }
}

function workspace(): string | undefined {
  let stat: Stats;
  try {
    stat = lstatSync('pnpm-workspace.yaml');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw new InstallPolicyError('npm install cannot read the pnpm workspace policy');
  }
  if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) {
    throw new InstallPolicyError('npm install requires a regular, bounded pnpm workspace policy');
  }
  return readFileSync('pnpm-workspace.yaml', 'utf8');
}

function npmOutput(args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- npm is the harness-selected executable; the preflight verifies its exact supported version.
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    maxBuffer: MAX_POLICY_BYTES,
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new InstallPolicyError('npm install policy preflight failed');
  }
  return result.stdout;
}

function preflight(): void {
  if (npmOutput(['--version']).trim() !== INSTALL_NPM_VERSION) {
    throw new InstallPolicyError(`npm install requires npm ${INSTALL_NPM_VERSION}`);
  }
  if (!acceptsNpmWorkspace(workspace())) {
    throw new InstallPolicyError('npm install does not support this pnpm workspace policy');
  }
  let config: unknown;
  try {
    config = JSON.parse(npmOutput(['config', 'list', '--json'])) as unknown;
  } catch {
    throw new InstallPolicyError('npm install cannot read its effective security policy');
  }
  if (!acceptsNpmConfig(config)) {
    throw new InstallPolicyError('npm install refuses to override a custom security policy');
  }
}

try {
  preflight();
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- use the same harness-selected npm whose version and effective policy were checked above.
  const result = spawnSync('npm', npmInstallArguments(), { stdio: 'inherit' });
  if (result.signal === null) {
    process.exitCode = result.error === undefined ? (result.status ?? 1) : 1;
  } else {
    // An ignored signal must still stop the hook before build or deployment.
    process.exitCode = 1;
    process.kill(process.pid, result.signal);
  }
} catch (error) {
  // Never print npm config, captured output or a nested error: these may contain registry credentials.
  console.error(
    error instanceof InstallPolicyError ? error.message : 'npm install policy preflight failed',
  );
  process.exitCode = 1;
}
