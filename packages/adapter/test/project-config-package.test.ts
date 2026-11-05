import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const execFile = promisify(execFileCallback);
const directories: string[] = [];
const TYPECHECK_TIMEOUT_MS = 30_000;

/** CI builds before unit tests; stage those artifacts under the package's published export map. */
async function installedPackage(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'upwind-config-package-'));
  directories.push(root);
  const installed = path.join(root, 'node_modules/@stayingupwind/adapter');
  await mkdir(installed, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(PACKAGE, 'package.json'), 'utf8')) as {
    name: string;
    type: string;
    publishConfig: { exports: unknown };
  };
  await writeFile(
    path.join(installed, 'package.json'),
    JSON.stringify({
      name: manifest.name,
      type: manifest.type,
      exports: manifest.publishConfig.exports,
    }),
  );
  await cp(path.join(PACKAGE, 'dist'), path.join(installed, 'dist'), { recursive: true });
  // The installed loader reads its declared dependencies; its own exports still resolve from staging.
  await symlink(
    path.join(PACKAGE, 'node_modules'),
    path.join(installed, 'node_modules'),
    'junction',
  );
  await writeFile(path.join(root, 'upwind.json'), '{"custom":{"enabled":true}}');
  return root;
}

describe('the published project configuration loader', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it.each([
    ['NodeNext', 'NodeNext'],
    ['ESNext', 'Bundler'],
  ])('is importable and strictly typed under %s/%s', async (module, moduleResolution) => {
    const root = await installedPackage();
    await writeFile(
      path.join(root, 'smoke.mjs'),
      `import { findProjectConfigFile, readProjectConfigFile } from '@stayingupwind/adapter/project-config';
console.log(JSON.stringify({ file: await findProjectConfigFile('.'), result: await readProjectConfigFile('.') }));`,
    );
    const { stdout } = await execFile(process.execPath, ['smoke.mjs'], {
      cwd: root,
      timeout: TYPECHECK_TIMEOUT_MS,
    });

    expect(JSON.parse(stdout)).toStrictEqual({
      file: 'upwind.json',
      result: { file: 'upwind.json', value: { custom: { enabled: true } } },
    });

    await writeFile(
      path.join(root, 'consumer.mts'),
      `import { findProjectConfigFile, readProjectConfigFile, type ProjectConfigFile } from '@stayingupwind/adapter/project-config';
export const selected: string | undefined = await findProjectConfigFile('.');
const aliases: readonly string[] = ['custom.config.ts'];
export const result: ProjectConfigFile = await readProjectConfigFile('.', aliases);
// @ts-expect-error The caller must validate untrusted configuration values.
result.value.services;
// @ts-expect-error The project directory must be a string.
findProjectConfigFile(42);
// @ts-expect-error Host filenames must be strings.
readProjectConfigFile('.', [42]);
// @ts-expect-error The selected filename is readonly.
result.file = 'other.json';`,
    );
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module,
          moduleResolution,
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        files: ['consumer.mts'],
      }),
    );
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

    await expect(
      execFile(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], {
        cwd: root,
        timeout: TYPECHECK_TIMEOUT_MS,
      }),
    ).resolves.toMatchObject({ stdout: '', stderr: '' });
  });
});
