import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditTracedFiles } from '../src/dependencies.ts';
import { tracedFiles } from '../src/traced-files.ts';

interface PackageFixture {
  readonly root: string;
  readonly files: Readonly<Record<string, string>>;
}

async function declarationPackage(
  project: string,
  name: string,
  version: string,
  declarations: Readonly<Record<string, string>>,
): Promise<PackageFixture> {
  const directory = path.join(
    project,
    'node_modules',
    '.pnpm',
    `${name.replace('/', '+')}@${version}`,
    'node_modules',
    name,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version }));
  const files: Record<string, string> = {};
  for (const [relative, contents] of Object.entries(declarations)) {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
    files[relative] = file;
  }
  return { root: directory, files };
}

async function aliasPackage(project: string, name: string, directory: string): Promise<void> {
  const alias = path.join(project, 'node_modules', name);
  await mkdir(path.dirname(alias), { recursive: true });
  await symlink(directory, alias, 'dir');
}

describe('explicit declaration data traces', () => {
  let root: string;
  let project: string;
  let dist: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'upwind-declaration-traces-'));
    project = path.join(root, 'project');
    dist = path.join(project, '.next');
    await mkdir(dist, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps logical package paths and exact opaque bytes without collecting untraced files', async () => {
    const fixture = await declarationPackage(project, 'typescript', '5.9.2', {
      'lib/lib.es5.d.ts': 'declare const marker: unique symbol;\n',
      'lib/untraced.d.ts': 'not part of this output',
      'lib/typescript.js': 'not data',
    });
    await aliasPackage(project, 'typescript', fixture.root);
    const physical = fixture.files['lib/lib.es5.d.ts'];
    const assets = { 'node_modules/typescript/lib/lib.es5.d.ts': physical! };
    const files = tracedFiles([{ assets }, { assets }], project, dist);

    expect(files).toStrictEqual([
      { name: 'node_modules/typescript/lib/lib.es5.d.ts', filePath: physical },
    ]);
    await expect(readFile(files[0]!.filePath, 'utf8')).resolves.toBe(
      'declare const marker: unique symbol;\n',
    );
    expect(tracedFiles([{ runtime: 'edge', assets }], project, dist)).toStrictEqual([]);
  });

  it.each(['.d.ts', '.d.mts', '.d.cts'])(
    'admits only an explicitly traced %s declaration',
    async (extension) => {
      const relative = `types/entry${extension}`;
      const file = path.join(project, relative);
      await mkdir(path.dirname(file));
      await writeFile(file, 'export declare const value: string;');

      expect(tracedFiles([{ assets: { [relative]: file } }], project, dist)).toStrictEqual([
        { name: relative, filePath: file },
      ]);
    },
  );

  it('preserves scoped package names and separates declaration ownership between Functions', async () => {
    const first = await declarationPackage(project, 'typescript', '5.9.2', {
      'lib/lib.d.ts': 'first',
    });
    const second = await declarationPackage(project, 'typescript', '5.8.3', {
      'lib/lib.d.ts': 'second',
    });
    const scoped = await declarationPackage(project, '@types/node', '24.19.2', {
      'index.d.ts': 'node types',
    });
    await aliasPackage(project, 'typescript', first.root);
    await aliasPackage(project, '@types/node', scoped.root);
    const secondName = path
      .relative(project, second.files['lib/lib.d.ts']!)
      .split(path.sep)
      .join('/');
    const firstAssets = { 'node_modules/typescript/lib/lib.d.ts': first.files['lib/lib.d.ts']! };
    const secondAssets = {
      [secondName]: second.files['lib/lib.d.ts']!,
      'node_modules/@types/node/index.d.ts': scoped.files['index.d.ts']!,
    };

    expect(tracedFiles([{ assets: firstAssets }], project, dist)).toStrictEqual([
      { name: 'node_modules/typescript/lib/lib.d.ts', filePath: first.files['lib/lib.d.ts'] },
    ]);
    expect(tracedFiles([{ assets: secondAssets }], project, dist)).toStrictEqual([
      { name: secondName, filePath: second.files['lib/lib.d.ts'] },
      { name: 'node_modules/@types/node/index.d.ts', filePath: scoped.files['index.d.ts'] },
    ]);
  });

  it.each([
    '../outside.d.ts',
    '/absolute.d.ts',
    String.raw`types\entry.d.ts`,
    'types//entry.d.ts',
    'types/./entry.d.ts',
    'types/entry\0.d.ts',
    '.upwind-build/entry.d.ts',
    '.arkor/entry.d.ts',
    'types/colon:entry.d.ts',
  ])('rejects the unsafe logical declaration key %j', async (logical) => {
    const file = path.join(project, 'entry.d.ts');
    await writeFile(file, 'safe file');

    expect(() => tracedFiles([{ assets: { [logical]: file } }], project, dist)).toThrow(
      'declaration',
    );
  });

  it('rejects a trace whose logical file names another physical declaration', async () => {
    await writeFile(path.join(project, 'one.d.ts'), 'one');
    const other = path.join(project, 'two.d.ts');
    await writeFile(other, 'two');

    expect(() => tracedFiles([{ assets: { 'one.d.ts': other } }], project, dist)).toThrow(
      'declaration',
    );
  });

  it('rejects package symlinks escaping the project and mismatched package identities', async () => {
    const outside = await declarationPackage(root, 'typescript', '5.9.2', {
      'lib/lib.d.ts': 'outside',
    });
    await aliasPackage(project, 'typescript', outside.root);
    const assets = { 'node_modules/typescript/lib/lib.d.ts': outside.files['lib/lib.d.ts']! };

    expect(() => tracedFiles([{ assets }], project, dist)).toThrow('declaration');

    await rm(path.join(project, 'node_modules', 'typescript'));
    const other = await declarationPackage(project, 'different', '1.0.0', {
      'lib/lib.d.ts': 'wrong package',
    });
    await aliasPackage(project, 'typescript', other.root);

    expect(() => {
      return tracedFiles(
        [{ assets: { 'node_modules/typescript/lib/lib.d.ts': other.files['lib/lib.d.ts']! } }],
        project,
        dist,
      );
    }).toThrow('declaration');
  });

  it('rejects a declaration symlink leaving its legitimate package inside the project', async () => {
    const fixture = await declarationPackage(project, 'typescript', '5.9.2', {});
    const outsidePackage = path.join(project, 'outside-package.d.ts');
    await writeFile(outsidePackage, 'project declaration');
    await mkdir(path.join(fixture.root, 'lib'));
    const link = path.join(fixture.root, 'lib', 'lib.d.ts');
    await symlink(outsidePackage, link);
    await aliasPackage(project, 'typescript', fixture.root);

    expect(() =>
      tracedFiles([{ assets: { 'node_modules/typescript/lib/lib.d.ts': link } }], project, dist),
    ).toThrow('escapes its package');
  });

  it('refuses missing and nonregular declaration targets', async () => {
    const missing = path.join(project, 'missing.d.ts');
    const directory = path.join(project, 'directory.d.ts');
    await mkdir(directory);

    expect(() => tracedFiles([{ assets: { 'missing.d.ts': missing } }], project, dist)).toThrow(
      'declaration',
    );
    expect(() => tracedFiles([{ assets: { 'directory.d.ts': directory } }], project, dist)).toThrow(
      'declaration',
    );
  });

  it('rejects two traces claiming one logical name for different physical files', async () => {
    const one = path.join(project, 'one.d.ts');
    const two = path.join(project, 'two.d.ts');
    await writeFile(one, 'one');
    await writeFile(two, 'two');

    expect(() => {
      return tracedFiles(
        [{ assets: { 'one.d.ts': one } }, { assets: { 'one.d.ts': two } }],
        project,
        dist,
      );
    }).toThrow('declaration');
    expect(() => {
      return tracedFiles(
        [{ assets: { 'one.d.ts': two } }, { assets: { 'one.d.ts': one } }],
        project,
        dist,
      );
    }).toThrow('declaration');
  });

  it('keeps the existing Function code/data collision refusal', async () => {
    const file = path.join(project, 'entry.d.ts');
    await writeFile(file, 'declaration');
    const other = path.join(project, 'other.d.ts');
    await writeFile(other, 'unrelated declaration');
    const files = tracedFiles(
      [{ assets: { 'entry.d.ts': file, 'other.d.ts': other } }],
      project,
      dist,
    );

    expect(() => {
      auditTracedFiles('app', [{ name: 'entry.d.ts' }], files);
    }).toThrow('carries a module');
    expect(() => {
      auditTracedFiles('app', [{ name: 'entry.d.ts' }], files.toReversed());
    }).toThrow('carries a module');
  });

  it('refuses an unproved monorepo root interpretation instead of inventing an alias', async () => {
    const nested = path.join(project, 'apps', 'site');
    const file = path.join(nested, 'types', 'entry.d.ts');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'project declaration');

    expect(() => {
      return tracedFiles(
        [{ assets: { 'apps/site/types/entry.d.ts': file } }],
        nested,
        path.join(nested, '.next'),
      );
    }).toThrow('declaration');
  });

  it('preserves ordinary data names and excludes code and untraced package data', async () => {
    const data = path.join(project, 'data.json');
    const packageData = path.join(project, 'node_modules', 'package', 'data.json');
    const code = path.join(project, 'source.ts');
    await writeFile(data, '{}');

    const externalDist = path.join(root, 'external-dist');
    const builtDeclaration = path.join(externalDist, 'server', 'assets', 'template.d.ts');
    await mkdir(path.dirname(builtDeclaration), { recursive: true });
    await writeFile(builtDeclaration, 'built server asset');

    expect(
      tracedFiles([{ assets: { asset: builtDeclaration } }], project, externalDist),
    ).toStrictEqual([
      { name: '.upwind-build/server/assets/template.d.ts', filePath: builtDeclaration },
    ]);
    expect(
      tracedFiles([{ assets: { ignoredLogicalAlias: data, packageData, code } }], project, dist),
    ).toStrictEqual([{ name: 'data.json', filePath: data }]);
  });
});
