import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDirectories,
  copyBuildContext,
  excludedBuildPath,
  packageInstall,
} from '../src/aws/build-context.ts';
import { buildScript, dockerfile } from '../src/aws/build-source.ts';
import { assertFargateImage } from '../src/aws/build-verify.ts';
import type { FargateBuildReceipt } from '../src/aws/types.ts';

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'upwind-aws-build-test-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Fargate target-platform build', () => {
  it('copies workspace sources while excluding host dependencies and deployment credentials', async () => {
    const source = await temporary();
    const destination = path.join(await temporary(), 'context');
    await mkdir(path.join(source, 'packages/shared'), { recursive: true });
    await mkdir(path.join(source, 'app/coverage'), { recursive: true });
    await mkdir(path.join(source, 'packages/coverage'), { recursive: true });
    await mkdir(path.join(source, '.aws'));
    await mkdir(path.join(source, 'packages/shared/node_modules'));
    await writeFile(path.join(source, 'packages/shared/index.ts'), 'export const value = 1;');
    await writeFile(
      path.join(source, 'app/coverage/page.tsx'),
      'export default function Page() {}',
    );
    await writeFile(path.join(source, 'packages/coverage/index.ts'), 'export const coverage = 1;');
    await writeFile(path.join(source, '.aws/credentials'), 'aws-secret');
    await writeFile(path.join(source, 'packages/shared/.env.production'), 'TOKEN=secret');
    await writeFile(path.join(source, '.npmrc'), '//registry/:_authToken=secret');
    await copyBuildContext(source, destination);
    expect(await readFile(path.join(destination, 'packages/shared/index.ts'), 'utf8')).toContain(
      'value',
    );
    expect(await readFile(path.join(destination, 'app/coverage/page.tsx'), 'utf8')).toContain(
      'Page',
    );
    expect(await readFile(path.join(destination, 'packages/coverage/index.ts'), 'utf8')).toContain(
      'coverage',
    );
    await expect(readFile(path.join(destination, '.aws/credentials'))).rejects.toThrow();
    await expect(readFile(path.join(destination, '.npmrc'))).rejects.toThrow();
    await expect(
      readFile(path.join(destination, 'packages/shared/.env.production')),
    ).rejects.toThrow();
    expect(excludedBuildPath('apps/site/node_modules/native.node')).toBe(true);
    expect(excludedBuildPath('apps/site/app/page.tsx')).toBe(false);
  });

  it('refuses workspace paths or symlinks outside the selected context', async () => {
    const source = await temporary();
    const outside = await temporary();
    await symlink(outside, path.join(source, 'outside'));
    await expect(copyBuildContext(source, path.join(await temporary(), 'copy'))).rejects.toThrow(
      'external symlink',
    );
    await expect(buildDirectories(source, outside)).rejects.toThrow('must contain');
  });

  it('requires frozen lockfile installs with the declared package-manager version', async () => {
    const source = await temporary();
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@12.15.0' }),
    );
    await writeFile(path.join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    expect(await packageInstall(source)).toMatchObject({
      command: ['corepack', 'pnpm@12.15.0', 'install', '--frozen-lockfile'],
    });
    await writeFile(path.join(source, 'package-lock.json'), '{}');
    await expect(packageInstall(source)).rejects.toThrow('exactly one');
  });

  it('keeps declared build variables out of image arguments, layers, and runtime environment', () => {
    const baseImageDigest = `node@sha256:${'b'.repeat(64)}`;
    const recipe = dockerfile({ baseImageDigest, project: 'apps/site', deploymentId: 'dpl_test' });
    expect(recipe.match(new RegExp(`FROM ${baseImageDigest}`, 'gu'))).toHaveLength(2);
    expect(recipe).toContain('--mount=type=secret,id=upwind-build-env,required=true');
    expect(recipe).toContain('--mount=type=secret,id=upwind-npmrc');
    expect(recipe).not.toContain('ARG ');
    expect(recipe).not.toContain('COPY .');
    expect(recipe).toContain('USER node');
    const script = buildScript({
      project: 'apps/site',
      deploymentId: 'dpl_test',
      install: {
        manager: 'pnpm',
        specification: 'pnpm@12.15.0',
        command: ['corepack', 'pnpm@12.15.0', 'install', '--frozen-lockfile'],
      },
      prepare: ['pnpm', '--filter', '@example/shared', 'build'],
    });
    expect(script).toContain('/run/secrets/upwind-build-env');
    expect(script).toContain("env.NPM_CONFIG_USERCONFIG = '/run/secrets/upwind-npmrc'");
    expect(script).toContain('UPWIND_AWS_BUILD');
    expect(script).toContain('shell: false');
    expect(script).toContain("'/workspace'");
  });

  it('rejects an archive image that has a different deployment, platform, or base digest', () => {
    const receipt = {
      imageId: `sha256:${'a'.repeat(64)}`,
      deploymentId: 'dpl_test',
      platform: 'linux/arm64',
      baseImageDigest: `node@sha256:${'b'.repeat(64)}`,
    } as FargateBuildReceipt;
    const image = {
      Id: receipt.imageId,
      Os: 'linux',
      Architecture: 'arm64',
      Config: {
        Labels: {
          'io.stayingupwind.deployment': receipt.deploymentId,
          'io.stayingupwind.base': receipt.baseImageDigest,
        },
      },
    };
    expect(() => assertFargateImage(receipt, JSON.stringify(image))).not.toThrow();
    expect(() =>
      assertFargateImage(receipt, JSON.stringify({ ...image, Architecture: 'amd64' })),
    ).toThrow('does not match');
    expect(() =>
      assertFargateImage(receipt, JSON.stringify({ ...image, Config: { Labels: {} } })),
    ).toThrow('does not match');
  });

  it('copies the native output from a constant path without expanding the workspace path', () => {
    const project = 'apps/$site\nfolder';
    const recipe = dockerfile({
      baseImageDigest: `node@sha256:${'b'.repeat(64)}`,
      project,
      deploymentId: 'dpl_test',
    });
    expect(recipe).toContain('COPY --from=build --chown=node:node /upwind/native/ /app/');
    expect(recipe).not.toContain('$site');
    const script = buildScript({
      project,
      deploymentId: 'dpl_test',
      install: { manager: 'npm', specification: 'npm', command: ['npm', 'ci'] },
    });
    expect(script).toContain(`const project = ${JSON.stringify(`/workspace/${project}`)};`);
    expect(script).toContain("cpSync(path.join(project, '.arkor/node'), '/upwind/native'");
    expect(script).toContain('verbatimSymlinks: true');
  });

  it('exports a single image manifest without provenance or SBOM index attachments', async () => {
    const source = await readFile(new URL('../src/aws/build.ts', import.meta.url), 'utf8');
    expect(source).toContain("'--provenance=false'");
    expect(source).toContain("'--sbom=false'");
  });
});
