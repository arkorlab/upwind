import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, assert, describe, expect, it } from 'vitest';

import { FUNCTION_COMPATIBILITY_DATE, FUNCTION_COMPATIBILITY_FLAGS } from '../src/function.ts';
import {
  bundleLinkedExternals,
  linkedImportsPlugin,
  linkedModuleBanner,
} from '../src/linked-externals.ts';

const IDS = ['@scope/linked-one-1111111111111111', '@scope/linked-two-2222222222222222'];
const roots: string[] = [];
const runtimes: Miniflare[] = [];

async function emitted() {
  const root = await mkdtemp(path.join(tmpdir(), 'upwind-linked-urls-'));
  roots.push(root);
  const distDir = path.join(root, '.next');
  const modules = path.join(distDir, 'node_modules');
  await mkdir(path.join(distDir, 'server', 'chunks'), { recursive: true });
  await mkdir(modules, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(modules, 'shared.mjs'),
    "import value from './value.cjs'; export const { marker, filename, dirname, bound } = value; export const url = import.meta.url;",
  );
  await writeFile(
    path.join(modules, 'value.cjs'),
    `const { basename } = require('node:path');
function localPaths(__filename, __dirname) { return { filename: __filename, dirname: __dirname }; }
module.exports = { marker: basename('/linked/ready'), filename: __filename, dirname: __dirname, bound: localPaths('local-file', 'local-dir') };`,
  );
  for (const id of IDS) {
    const directory = path.join(modules, id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: id, type: 'module', exports: './index.js' }),
    );
    await writeFile(
      path.join(directory, 'index.js'),
      "export { marker, filename, dirname, bound, url as sharedUrl } from '../../shared.mjs'; export const url = import.meta.url;",
    );
  }
  const result = await bundleLinkedExternals({
    projectDir: root,
    files: [],
    distDir,
    workDir: root,
    kind: 'app',
    ids: IDS,
  });
  assert.ok(result !== undefined);
  const files = await Promise.all(
    result.modules.map(async (module) => {
      const contents = await readFile(module.file, 'utf8');
      return { ...module, contents };
    }),
  );
  return files;
}

type Emitted = Awaited<ReturnType<typeof emitted>>;

async function inWorker(files: Emitted, withFallback: boolean): Promise<unknown> {
  const source = `export default {
    async fetch() {
      try {
        const first = await import(${JSON.stringify(`./${IDS[0]}`)});
        const second = await import(${JSON.stringify(`./${IDS[1]}`)});
        return Response.json([first, second]);
      } catch (error) {
        return Response.json({ error: error?.code });
      }
    }
  };`;
  const modules = files.map((file) => {
    const banner = linkedModuleBanner(file.name);
    assert.ok(file.contents.includes(banner));
    return {
      type: 'ESModule' as const,
      path: path.posix.join('/bundle', file.name),
      contents: withFallback ? file.contents : file.contents.replace(banner, ''),
    };
  });
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'linked-urls',
      compatibilityDate: FUNCTION_COMPATIBILITY_DATE,
      compatibilityFlags: [...FUNCTION_COMPATIBILITY_FLAGS],
      modulesRoot: '/bundle',
      modules: [{ type: 'ESModule', path: '/bundle/test.mjs', contents: source }, ...modules],
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      outboundService() {
        throw new Error('Linked module tests cannot use outbound network');
      },
    }),
  );
  runtimes.push(runtime);
  const response = await runtime.dispatchFetch('https://linked.test/', {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  return value;
}

describe('linked external module URLs', () => {
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('loads scoped entries and their shared require helper under the legacy Worker registry', async () => {
    const files = await emitted();
    const shared = files.filter((file) => file.name.startsWith('__linked/'));

    expect(shared).toHaveLength(1);

    const sharedFile = shared[0];
    assert.ok(sharedFile !== undefined);

    expect(sharedFile.contents).toContain('createRequire(import.meta.url)');

    await expect(inWorker(files, false)).resolves.toStrictEqual({ error: 'ERR_INVALID_ARG_VALUE' });

    const sharedUrl = pathToFileURL(path.posix.join('/bundle', sharedFile.name), {
      windows: false,
    }).href;
    const filename = path.posix.join('/bundle', sharedFile.name);
    const dirname = path.posix.dirname(filename);

    await expect(inWorker(files, true)).resolves.toStrictEqual(
      IDS.map((id) => {
        return {
          marker: 'ready',
          filename,
          dirname,
          bound: { filename: 'local-file', dirname: 'local-dir' },
          sharedUrl,
          url: `file:///bundle/${id}`,
        };
      }),
    );
  }, 20_000);

  it('preserves native module URLs when Node supplies them', async () => {
    const files = await emitted();
    const first = files.find((file) => file.name === IDS[0]);
    const shared = files.find((file) => file.name.startsWith('__linked/'));
    assert.ok(first !== undefined && shared !== undefined);
    const nativeUrl = pathToFileURL(first.file).href;
    const loaded: unknown = await import(nativeUrl);

    expect(loaded).toMatchObject({
      marker: 'ready',
      filename: shared.file,
      dirname: path.dirname(shared.file),
      bound: { filename: 'local-file', dirname: 'local-dir' },
      sharedUrl: pathToFileURL(shared.file).href,
      url: nativeUrl,
    });
  });

  it.each([
    [
      '@scope/pkg-0123456789abcdef/a "#?%.js',
      'file:///bundle/@scope/pkg-0123456789abcdef/a%20%22%23%3F%25.js',
      '/bundle/@scope/pkg-0123456789abcdef',
    ],
    [
      '__linked/line\n<script>.js',
      'file:///bundle/__linked/line%0A%3Cscript%3E.js',
      '/bundle/__linked',
    ],
  ])(
    'encodes the final virtual filename %s without introducing source syntax',
    (name, expected, dirname) => {
      const state = { meta: {} };
      // eslint-disable-next-line sonarjs/code-eval -- only the adapter-generated banner runs with a fixed metadata object.
      runInNewContext(linkedModuleBanner(name).replaceAll('import.meta', 'meta'), state);

      expect(state.meta).toStrictEqual({ url: expected, filename: `/bundle/${name}`, dirname });
    },
  );
});

/**
 * A package the build leaves to the runtime as an ES module, as `esm-externals` has one: linked
 * under `.next/node_modules` by its name and a hash, with an `import` export the runtime loads and
 * a `require` one it must not, and awaiting at its top level.
 */

const LINKED = 'esm-package2-f0c287beaea44dce';
const ID = `${LINKED}/entry`;

describe('a package the build links for the runtime to import', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function project(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'adapter-linked-'));
    directories.push(dir);
    const pkg = path.join(dir, 'node_modules', 'esm-package2');
    await mkdir(pkg, { recursive: true });
    await writeFile(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        type: 'module',
        name: 'esm-package',
        exports: { './entry': { import: './correct.js', require: './wrong.cjs' } },
      }),
    );
    await writeFile(
      path.join(pkg, 'correct.js'),
      "import { sep } from 'node:path';\nexport const separator = sep;\nawait 1;\n" +
        "if (Math.random() < 0) import('fail');\nexport default 'World';\n",
    );
    await writeFile(path.join(pkg, 'wrong.cjs'), "module.exports = 'Wrong';\n");
    await mkdir(path.join(dir, '.next', 'node_modules'), { recursive: true });
    await mkdir(path.join(dir, '.next', 'server', 'chunks'), { recursive: true });
    await symlink(
      '../../node_modules/esm-package2',
      path.join(dir, '.next', 'node_modules', LINKED),
    );
    return dir;
  }

  it('is carried as an ES module under the name the chunk imports it by', async () => {
    const dir = await project();
    const linked = await bundleLinkedExternals({
      projectDir: dir,
      files: [],
      distDir: path.join(dir, '.next'),
      workDir: path.join(dir, 'work'),
      kind: 'app',
      ids: [ID, 'unlinked-0123456789abcdef/entry'],
    });

    expect(linked?.modules.map((module) => module.name)).toStrictEqual([ID]);

    const source = await readFile(linked?.modules[0]?.file ?? '', 'utf8');

    // The `import` export, and its top-level await, which a CommonJS bundle could not carry.
    expect(source).toContain('await 1');
    expect(source).toContain('World');
    expect(source).not.toContain('Wrong');
    expect(linked?.trace.externals).toContain('node:path');
    // A module nobody installed, imported where no request reaches: left to fail as under Node.js.
    expect(linked?.trace.externals).not.toContain('fail');
    expect(linked?.trace.unresolved).toStrictEqual(['fail']);
  });

  it('is nothing to carry when no name is linked', async () => {
    const dir = await project();

    await expect(
      bundleLinkedExternals({
        projectDir: dir,
        files: [],
        distDir: path.join(dir, '.next'),
        workDir: path.join(dir, 'work'),
        kind: 'app',
        ids: ['unlinked-0123456789abcdef/entry'],
      }),
    ).resolves.toBeUndefined();
  });
});

/** What the plugin collects from one chunk's code, run as Rolldown runs its hook. */
function namesIn(code: string): string[] {
  const names: string[] = [];
  const { transform } = linkedImportsPlugin((id) => {
    names.push(id);
  });
  const handler = typeof transform === 'object' ? transform.handler : transform;
  (handler as unknown as (code: string) => void)(code);
  return names;
}

describe('the names a chunk imports linked packages by', () => {
  it('are the hashed names alone: not a built-in, not an application method called `y`', () => {
    expect(
      namesIn(
        `var d=await a.y("${ID}");var f=await e.y("node:fs");chart.y("value");` +
          'var s=b.y("@scope/pkg-0123456789abcdef");',
      ),
    ).toStrictEqual([ID, '@scope/pkg-0123456789abcdef']);
  });
});
