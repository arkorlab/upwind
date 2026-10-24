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

/** Each stored file under the name Turbopack's trace gives it: its own path in the project. */
function storedAssets(project: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [path.relative(project, file).split(path.sep).join('/'), file]),
  );
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

  it('emits a pnpm-stored types package, with its manifest, under the node_modules/@types link TypeScript walks', async () => {
    const types = await declarationPackage(project, '@types/node', '26.1.0', {
      'index.d.ts': '/// <reference lib="es2020" />\n/// <reference path="globals.d.ts" />\n',
      'globals.d.ts': 'declare var process: unknown;\n',
      'ts5.6/index.d.ts': '/// <reference path="../globals.d.ts" />\n',
    });
    await aliasPackage(project, '@types/node', types.root);
    const link = path.join(project, 'node_modules', '@types', 'node');
    // A trace through the link lists each stored file, and the link as an entry of its own.
    const stored = storedAssets(project, [
      ...Object.values(types.files),
      path.join(types.root, 'package.json'),
    ]);
    const files = tracedFiles(
      [{ assets: { 'node_modules/@types/node': link } }, { assets: stored }],
      project,
      dist,
    );

    expect(files).toStrictEqual([
      { name: 'node_modules/@types/node/globals.d.ts', filePath: types.files['globals.d.ts'] },
      { name: 'node_modules/@types/node/index.d.ts', filePath: types.files['index.d.ts'] },
      {
        name: 'node_modules/@types/node/package.json',
        filePath: path.join(types.root, 'package.json'),
      },
      {
        name: 'node_modules/@types/node/ts5.6/index.d.ts',
        filePath: types.files['ts5.6/index.d.ts'],
      },
    ]);
  });

  it('aliases no types link that leaves the repository, renames its package or is listed under another name', async () => {
    const links = path.join(project, 'node_modules', '@types');
    const outside = await declarationPackage(root, '@types/node', '26.1.0', {
      'index.d.ts': 'outside the repository',
    });
    await aliasPackage(project, '@types/node', outside.root);
    // An npm alias (`"@types/react": "npm:types-react@…"`): the link does not name the package.
    const renamed = await declarationPackage(project, 'types-react', '19.0.0', {
      'index.d.ts': 'renamed',
    });
    await aliasPackage(project, '@types/react', renamed.root);
    const linked = await declarationPackage(project, '@types/shared', '1.0.0', {
      'index.d.ts': 'the one the name leads to',
    });
    const listed = await declarationPackage(project, '@types/shared', '2.0.0', {
      'index.d.ts': 'the one the entry leads to',
    });
    await aliasPackage(project, '@types/shared', linked.root);
    await aliasPackage(path.join(project, 'apps', 'site'), '@types/shared', listed.root);
    const stored = storedAssets(project, [
      renamed.files['index.d.ts']!,
      listed.files['index.d.ts']!,
    ]);
    const assets = {
      ...stored,
      'node_modules/@types/node': path.join(links, 'node'),
      'node_modules/@types/react': path.join(links, 'react'),
      'node_modules/@types/shared': path.join(project, 'apps/site/node_modules/@types/shared'),
    };

    expect(tracedFiles([{ assets }], project, dist)).toStrictEqual(
      Object.entries(stored)
        .map(([name, filePath]) => ({ name, filePath }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it("keeps a linked workspace types package under its own path as well as the link's", async () => {
    const workspace = path.join(project, 'packages', 'types-local');
    const file = path.join(workspace, 'index.d.ts');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: '@types/local' }));
    await writeFile(file, 'declare const local: string;');
    await aliasPackage(project, '@types/local', workspace);
    const assets = {
      'packages/types-local/index.d.ts': file,
      'node_modules/@types/local': path.join(project, 'node_modules', '@types', 'local'),
    };

    expect(tracedFiles([{ assets }], project, dist)).toStrictEqual([
      { name: 'node_modules/@types/local/index.d.ts', filePath: file },
      { name: 'packages/types-local/index.d.ts', filePath: file },
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

  it('uses an explicit repository root for nested application and hoisted package declarations', async () => {
    const nested = path.join(project, 'apps', 'site');
    const file = path.join(nested, 'types', 'entry.d.ts');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'project declaration');
    const fixture = await declarationPackage(project, 'typescript', '5.9.2', {
      'lib/lib.d.ts': 'hoisted declaration',
    });
    await aliasPackage(nested, 'typescript', fixture.root);
    const packageName = 'apps/site/node_modules/typescript/lib/lib.d.ts';
    const assets = {
      'apps/site/types/entry.d.ts': file,
      [packageName]: fixture.files['lib/lib.d.ts']!,
    };

    expect(() => tracedFiles([{ assets }], nested, path.join(nested, '.next'))).toThrow(
      'declaration',
    );
    expect(tracedFiles([{ assets }], nested, path.join(nested, '.next'), project)).toStrictEqual([
      { name: packageName, filePath: fixture.files['lib/lib.d.ts'] },
      { name: 'apps/site/types/entry.d.ts', filePath: file },
    ]);
  });

  it('requires lexical and real project containment in the declared repository', async () => {
    const file = path.join(project, 'entry.d.ts');
    await writeFile(file, 'declaration');
    const outside = path.join(root, 'other-repository');
    await mkdir(outside);
    const assets = { 'entry.d.ts': file };

    expect(() => tracedFiles([{ assets }], project, dist, outside)).toThrow('declaration');

    const linkedProject = path.join(project, 'linked-application');
    await symlink(outside, linkedProject, 'dir');

    expect(() =>
      tracedFiles([{ assets }], linkedProject, path.join(linkedProject, '.next'), project),
    ).toThrow('declaration');
  });

  it('rejects hoisted declaration targets outside the supplied repository', async () => {
    const nested = path.join(project, 'apps', 'site');
    await mkdir(nested, { recursive: true });
    const fixture = await declarationPackage(root, 'typescript', '5.9.2', {
      'lib/lib.d.ts': 'outside declaration',
    });
    await aliasPackage(nested, 'typescript', fixture.root);
    const assets = {
      'apps/site/node_modules/typescript/lib/lib.d.ts': fixture.files['lib/lib.d.ts']!,
    };

    expect(() => tracedFiles([{ assets }], nested, path.join(nested, '.next'), project)).toThrow(
      'declaration',
    );
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
      tracedFiles([{ assets: { asset: builtDeclaration } }], project, externalDist, root),
    ).toStrictEqual([
      { name: '.upwind-build/server/assets/template.d.ts', filePath: builtDeclaration },
    ]);
    expect(
      tracedFiles(
        [{ assets: { ignoredLogicalAlias: data, packageData, code } }],
        project,
        dist,
        root,
      ),
    ).toStrictEqual([{ name: 'data.json', filePath: data }]);
  });
});

/**
 * What an application reads through `node:fs` goes into its Worker at its path in the project,
 * where `process.cwd()`, `/bundle`, puts the application's own path to it. A page that read a
 * `data.json` next to itself, or a middleware that read `package.json`, failed on the Worker with
 * `no such file or directory` for a file the build had traced.
 */

const PROJECT = path.join(path.sep, 'repo', 'apps', 'site');
const DIST = path.join(PROJECT, '.next');

function at(...segments: string[]): string {
  return path.join(PROJECT, ...segments);
}

function output(files: string[], runtime?: 'edge' | 'nodejs') {
  return {
    ...(runtime !== undefined && { runtime }),
    assets: Object.fromEntries(files.map((file) => [path.relative('/repo', file), file])),
  };
}

describe('the files a Worker carries for the application to read', () => {
  it('are the data files the trace found in the project, by their paths in it', () => {
    const files = tracedFiles(
      [
        output([
          at('app', 'account', 'deployments', '[id]', 'data.json'),
          at('package.json'),
          at('public', 'notes.txt'),
        ]),
      ],
      PROJECT,
      DIST,
    );

    expect(files.map((file) => file.name)).toStrictEqual([
      'app/account/deployments/[id]/data.json',
      'package.json',
      'public/notes.txt',
    ]);
    expect(files[1]?.filePath).toBe(at('package.json'));
  });

  it('leave out code, packages, what the build wrote and what lies outside the project', () => {
    const files = tracedFiles(
      [
        output([
          at('lib', 'read.js'),
          at('lib', 'types.ts'),
          at('lib', 'font.wasm'),
          at('node_modules', 'pkg', 'data.json'),
          at('.next', 'server', 'app', 'page.js'),
          at('.next', 'required-server-files.json'),
          path.join(path.sep, 'repo', 'node_modules', 'next', 'package.json'),
          path.join(path.sep, 'repo', 'shared', 'data.json'),
        ]),
      ],
      PROJECT,
      DIST,
    );

    expect(files).toStrictEqual([]);
  });

  /**
   * `new URL('./data.json', import.meta.url)` in a server module: Turbopack copies the file into the
   * build output's `server/assets` and lists it among the output's `assets`, and the module reads
   * the copy. The one thing the build wrote that travels — whatever it is called, since it is read
   * as data and travels as data — and nothing else beside it in the build output does.
   */
  it('take a file a server module refers to by URL, whatever its extension', () => {
    const files = tracedFiles(
      [
        output([
          at('.next', 'server', 'assets', 'my-data.0xq5k_kxzo_4n.json'),
          at('.next', 'server', 'assets', 'template.2u76vq-hdeuu-.js'),
          at('.next', 'server', 'chunks', 'ssr', 'page.js'),
          at('.next', 'server', 'assets-elsewhere.json'),
        ]),
      ],
      PROJECT,
      DIST,
    );

    expect(files.map((file) => file.name)).toStrictEqual([
      '.next/server/assets/my-data.0xq5k_kxzo_4n.json',
      '.next/server/assets/template.2u76vq-hdeuu-.js',
    ]);
  });

  it('are what the outputs on the Node.js runtime read, each once', () => {
    const files = tracedFiles(
      [
        output([at('content', 'a.md'), at('content', 'b.md')]),
        output([at('content', 'a.md')], 'nodejs'),
        output([at('edge-only.md')], 'edge'),
      ],
      PROJECT,
      DIST,
    );

    expect(files.map((file) => file.name)).toStrictEqual(['content/a.md', 'content/b.md']);
  });

  it('keep a sibling of the build directory whose name only starts with its own', () => {
    const files = tracedFiles([output([at('..next-notes', 'n.txt')])], PROJECT, DIST);

    expect(files.map((file) => file.name)).toStrictEqual(['..next-notes/n.txt']);
  });
});
