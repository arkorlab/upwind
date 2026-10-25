import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appEntrySource } from '../src/app-entry.ts';
import { jsLiteral } from '../src/codegen.ts';
import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import { projectedTemplateFixture } from './fixtures/node-manifest-turbopack-template.ts';

const SPECIFIER = 'next/dist/build/templates/app-page-runtime.js';
const CHAIN = [
  'dist/server/load-manifest.external.js',
  'dist/compiled/next-server/app-page.runtime.prod.js',
  'dist/server/route-modules/app-page/module.compiled.js',
  'dist/build/templates/app-page-runtime.js',
] as const;

function digest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}

async function fixture(directory: string) {
  const published = fileURLToPath(
    import.meta.resolve('next/dist/server/load-manifest.external.js'),
  );
  const publishedRoot = path.resolve(path.dirname(published), '../..');
  const root = path.join(directory, 'node_modules/next');
  const sources = new Map<string, { readonly file: string; readonly sha256: string }>();
  const imports = new Map<string, { readonly specifier: string; readonly target: string }[]>();
  const put = async (file: string, code: string | Uint8Array): Promise<string> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, code);
    sources.set(file, { file, sha256: digest(code) });
    imports.set(file, []);
    return file;
  };
  const files: string[] = [];
  for (const relative of CHAIN) {
    const bytes = await readFile(path.join(publishedRoot, relative));
    files.push(await put(path.join(root, relative), bytes));
  }
  const [evaluator, compiled, module, producer] = files;
  if (
    evaluator === undefined ||
    compiled === undefined ||
    module === undefined ||
    producer === undefined
  )
    throw new Error('Missing authored source chain');
  await writeFile(path.join(root, 'package.json'), '{"name":"next","version":"16.4.3"}');
  const distDir = path.join(directory, '.next');
  const entry = path.join(distDir, 'server/app/native/page.js');
  const chunk = path.join(distDir, 'server/chunks/app.js');
  const runtime = path.join(distDir, 'server/chunks/[turbopack]_runtime.js');
  const manifest = path.join(distDir, 'server/app/native/page_client-reference-manifest.js');
  const runtimeSource = await readFile(
    new URL('fixtures/node-runtime/production.txt', import.meta.url),
    'utf8',
  );
  await put(
    runtime,
    runtimeSource
      .replace(
        'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
        'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
      )
      .replace(
        'var RELATIVE_ROOT_PATH = "../../../../../../..";',
        'var RELATIVE_ROOT_PATH = "..";',
      ),
  );
  await put(
    entry,
    'var R=require("../../chunks/[turbopack]_runtime.js")("server/app/native/page.js");R.c("server/chunks/app.js");R.m(1);module.exports=R.m(1).exports;',
  );
  await put(
    chunk,
    [
      'module.exports=[1,((ctx)=>{',
      'ctx.s(["__next_app__",()=>__next_app__,"handler",()=>handler,"routeModule",()=>routeModule]);',
      'var p=ctx.i(2);',
      'const own=p.createAppPageEntrypoint({tree,page:"/native/page",pathname:"/native",require:ctx.r.bind(ctx),loadChunk:ctx.l.bind(ctx),interopDefault});',
      'const __next_app__=own.__next_app__;const handler=own.handler;const routeModule=own.routeModule;',
      `}),2,((ctx)=>{var p=ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}));ctx.n(p);})];`,
    ].join('\n'),
  );
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(
    manifest,
    'globalThis.__RSC_MANIFEST=globalThis.__RSC_MANIFEST||{};globalThis.__RSC_MANIFEST["/native/page"]={};',
  );
  const entries = [{ id: '/native', filePath: entry }];
  const analysisEntry = path.join(directory, 'entry.cjs');
  await put(
    analysisEntry,
    appEntrySource(entries, { external: true, runtimeDistDir: distDir, nodeRequestMeta: true }),
  );
  imports.set(compiled, [{ specifier: evaluator, target: evaluator }]);
  imports.set(module, [{ specifier: compiled, target: compiled }]);
  imports.set(producer, [{ specifier: module, target: module }]);
  imports.set(chunk, [{ specifier: SPECIFIER, target: producer }]);
  imports.set(runtime, [{ specifier: chunk, target: chunk }]);
  imports.set(entry, [{ specifier: '../../chunks/[turbopack]_runtime.js', target: runtime }]);
  imports.set(analysisEntry, [{ specifier: entry, target: entry }]);
  const importers = new Map<string, string[]>([...sources.keys()].map((id) => [id, []]));
  for (const [from, edges] of imports)
    for (const edge of edges) importers.get(edge.target)?.push(from);
  return {
    runtime,
    chunk,
    entry,
    manifest,
    analysisEntry,
    sources,
    imports,
    input: {
      rootDir: directory,
      distDir,
      entries,
      analysisEntry,
      runtimeManifest: JSON.stringify({
        entrypoints: [{ id: '/native', kind: 'app-page', pathname: '/native' }],
      }),
      entryTraces: [{ id: '/native', assets: { manifest } }],
      manifests: [
        {
          name: '.next/server/app/native/page_client-reference-manifest.json',
          contents: '{}',
          routeFile: manifest,
        },
      ],
    },
    graph: {
      sources,
      imports,
      importers,
      roots: new Set([analysisEntry]),
      retained: new Set(sources.keys()),
    },
  };
}

interface DirectRuntimeFixture {
  readonly root: string;
  readonly publishedRoot: string;
  readonly module: string;
  readonly compiled: string;
  readonly evaluator: string;
  readonly code: string;
  readonly external: readonly { readonly specifier: string; readonly target: string }[];
  put(file: string, code: string | Uint8Array): Promise<string>;
}

async function selectDirectRuntime(
  own: Awaited<ReturnType<typeof fixture>>,
  context: DirectRuntimeFixture,
  runtime: string | undefined,
): Promise<void> {
  if (runtime === undefined) return;
  const wrapper = path.join(context.root, context.module);
  const selected = path.join(context.root, runtime);
  const bytes = await readFile(path.join(context.publishedRoot, runtime));
  await context.put(selected, bytes);
  const code = context.code.replaceAll(jsLiteral(wrapper), () => jsLiteral(selected));
  await context.put(own.chunk, code);
  own.imports.set(
    own.chunk,
    context.external.map((imported) =>
      imported.target === wrapper ? { specifier: selected, target: selected } : imported,
    ),
  );
  own.sources.delete(wrapper);
  own.imports.delete(wrapper);
  const old = path.join(context.root, context.compiled);
  if (old !== selected) {
    own.sources.delete(old);
    own.imports.delete(old);
  }
  own.imports.set(selected, [{ specifier: context.evaluator, target: context.evaluator }]);
}

async function templateFixture(
  directory: string,
  kind: 'pages' | 'app-route' | 'pages-api',
  directRuntime?: string,
) {
  const own = await fixture(directory);
  const projected = await projectedTemplateFixture(kind);
  const published = await realpath(
    fileURLToPath(import.meta.resolve('next/dist/server/load-manifest.external.js')),
  );
  const publishedRoot = path.resolve(path.dirname(published), '../..');
  const root = path.join(directory, 'node_modules/next');
  const evaluator = path.join(root, 'dist/server/load-manifest.external.js');
  for (const file of own.sources.keys()) {
    if (file === own.entry || (file !== evaluator && file.startsWith(`${root}/`))) {
      own.sources.delete(file);
      own.imports.delete(file);
    }
  }
  const put = async (file: string, code: string | Uint8Array): Promise<string> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, code);
    own.sources.set(file, { file, sha256: digest(code) });
    own.imports.set(file, []);
    return file;
  };
  const module = `dist/server/route-modules/${kind}/module.compiled.js`;
  const compiled = `dist/compiled/next-server/${kind}.runtime.prod.js`;
  for (const relative of [module, compiled]) {
    const bytes = await readFile(path.join(publishedRoot, relative));
    await put(path.join(root, relative), bytes);
  }
  const template = path.join(root, `dist/build/templates/${kind}.js`);
  await mkdir(path.dirname(template), { recursive: true });
  await writeFile(
    template,
    await readFile(path.join(publishedRoot, `dist/build/templates/${kind}.js`)),
  );
  let code = projected.projection.original.code;
  const external: { readonly specifier: string; readonly target: string }[] = [];
  for (const imported of projected.imports) {
    if (imported.specifier.startsWith('turbopack:')) continue;
    const relative = path.relative(publishedRoot, imported.file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Unexpected external primary source');
    const target = path.join(root, relative);
    const bytes = await readFile(imported.file);
    await put(target, bytes);
    code = code.replaceAll(jsLiteral(imported.specifier), () => jsLiteral(target));
    external.push({ specifier: target, target });
  }
  const localIds = new Set(
    projected.projection.imports.flatMap((imported) =>
      imported.targetId === undefined ? [] : [imported.targetId],
    ),
  );
  const slots = [...localIds]
    .map((id) => `${id},((ctx)=>{ctx.s(["default",()=>value]);const value={};}),`)
    .join('');
  code = code.replace('module.exports=[', () => `module.exports=[${slots}`);
  await put(own.chunk, code);
  own.imports.set(own.chunk, external);
  const relative =
    kind === 'app-route' ? 'server/app/stream/route.js' : `server/pages${projected.route.page}.js`;
  const entry = path.join(own.input.distDir, relative);
  const runtimeSpecifier = path
    .relative(path.dirname(entry), own.runtime)
    .split(path.sep)
    .join('/');
  await put(
    entry,
    `var R=require(${jsLiteral(runtimeSpecifier)})(${jsLiteral(relative)});R.c("server/chunks/app.js");R.m(1);module.exports=R.m(1).exports;`,
  );
  const entries = [{ id: projected.route.pathname, filePath: entry }];
  own.input.entries = entries;
  own.input.manifests = [];
  own.input.entryTraces = [];
  own.input.runtimeManifest = JSON.stringify({
    entrypoints: [{ id: projected.route.pathname, pathname: projected.route.pathname, kind }],
  });
  await put(
    own.analysisEntry,
    appEntrySource(entries, {
      external: true,
      runtimeDistDir: own.input.distDir,
      nodeRequestMeta: true,
    }),
  );
  own.imports.set(path.join(root, compiled), [{ specifier: evaluator, target: evaluator }]);
  own.imports.set(path.join(root, module), [
    { specifier: path.join(root, compiled), target: path.join(root, compiled) },
  ]);
  own.imports.set(entry, [{ specifier: runtimeSpecifier, target: own.runtime }]);
  own.imports.set(own.analysisEntry, [{ specifier: entry, target: entry }]);
  await selectDirectRuntime(
    own,
    { root, publishedRoot, module, compiled, evaluator, code, external, put },
    directRuntime,
  );
  own.graph.importers.clear();
  for (const file of own.sources.keys()) own.graph.importers.set(file, []);
  for (const [from, edges] of own.imports)
    for (const edge of edges) own.graph.importers.get(edge.target)?.push(from);
  own.graph.retained = new Set(own.sources.keys());
  own.entry = entry;
  return own;
}

describe('sealed Turbopack producers through the real manifest proof entry', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-tpack-proof-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('closes all actual boot importers before emitting compiler source and immutable root metadata', async () => {
    const own = await fixture(directory);
    const proof = await proveNodeManifests(own.input, own.graph);

    expect({
      root: proof.normalization?.runtimeRootDir,
      frozen: Object.isFrozen(proof.normalization),
      entriesFrozen: Object.isFrozen(proof.normalization?.entries),
      entryFrozen: Object.isFrozen(proof.normalization?.entries[0]),
      compilers: proof.approvedCompilerSources,
    }).toStrictEqual({
      root: directory,
      frozen: true,
      entriesFrozen: true,
      entryFrozen: true,
      compilers: [own.sources.get(own.runtime)],
    });
    expect(proof.codeSources.map((source) => source.file)).toStrictEqual(
      expect.arrayContaining([own.entry, own.chunk, own.runtime]),
    );
    expect(proof.codeSources.some((source) => source.file === own.manifest)).toBe(false);
    expect(proof.inspectionCode(own.runtime, 'eval("unknown")')).toBe('eval("unknown")');
  });

  it('requires independently supplied absolute compiler root coordinates', async () => {
    const own = await fixture(directory);
    own.input.rootDir = 'relative-untrusted';

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'missing trusted compiler root',
    );
  });

  it('closes the full manifest proof with an ordinary scalar-exporting factory in the same table', async () => {
    const own = await fixture(directory);
    const code = (await readFile(own.chunk, 'utf8')).replace(
      'module.exports=[',
      'module.exports=[3,((ctx)=>{ctx.v(42);}),',
    );
    await writeFile(own.chunk, code);
    own.sources.set(own.chunk, { file: own.chunk, sha256: digest(code) });
    const proof = await proveNodeManifests(own.input, own.graph);

    expect(proof.normalization?.runtimeRootDir).toBe(directory);
    expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
  });

  it('closes a string-ID protected route while retaining a distinct numeric factory in the same table', async () => {
    const own = await fixture(directory);
    const code = (await readFile(own.chunk, 'utf8'))
      .replace('module.exports=[1,', 'module.exports=[1,((ctx)=>{ctx.v(42);}),"1",')
      .replace('ctx.i(2)', 'ctx.i("2")')
      .replace('}),2,', '}),"2",');
    await writeFile(own.chunk, code);
    own.sources.set(own.chunk, { file: own.chunk, sha256: digest(code) });
    const entry = (await readFile(own.entry, 'utf8')).replaceAll('R.m(1)', 'R.m("1")');
    await writeFile(own.entry, entry);
    own.sources.set(own.entry, { file: own.entry, sha256: digest(entry) });
    const proof = await proveNodeManifests(own.input, own.graph);

    expect(proof.normalization?.runtimeRootDir).toBe(directory);
    expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
  });

  it('refuses a raw protected consumer sharing an otherwise certified physical factory table', async () => {
    const own = await fixture(directory);
    const body = `var p=require(${jsLiteral(SPECIFIER)});ctx.v(p);`;
    const code = (await readFile(own.chunk, 'utf8')).replace(
      'module.exports=[',
      () => `module.exports=[3,((ctx)=>{${body}}),`,
    );
    await writeFile(own.chunk, code);
    own.sources.set(own.chunk, { file: own.chunk, sha256: digest(code) });

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('Unproved Next.js');
  });

  it.each(['pages', 'app-route', 'pages-api'] as const)(
    'connects the published projected %s body through every physical importer to the SDK root',
    async (kind) => {
      const own = await templateFixture(directory, kind);
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.normalization?.runtimeRootDir).toBe(directory);
      expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
      expect(proof.codeSources.map((source) => source.file)).toStrictEqual(
        expect.arrayContaining([own.entry, own.chunk]),
      );
    },
  );

  it('refuses a private Pages API handler without the exact Node requestMeta facade', async () => {
    const own = await templateFixture(directory, 'pages-api');
    const code = appEntrySource(own.input.entries, {
      external: true,
      runtimeDistDir: own.input.distDir,
    });
    await writeFile(own.analysisEntry, code);
    own.sources.set(own.analysisEntry, { file: own.analysisEntry, sha256: digest(code) });

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'unproved SDK entry terminal',
    );
  });

  it.each([
    ['pages', 'dist/compiled/next-server/pages.runtime.prod.js'],
    ['pages', 'dist/compiled/next-server/pages-turbo.runtime.prod.js'],
    ['pages-api', 'dist/compiled/next-server/pages-api.runtime.prod.js'],
    ['pages-api', 'dist/compiled/next-server/pages-api-turbo.runtime.prod.js'],
    ['app-route', 'dist/compiled/next-server/app-route.runtime.prod.js'],
    ['app-route', 'dist/compiled/next-server/app-route-turbo.runtime.prod.js'],
    ['app-route', 'dist/compiled/next-server/app-route-experimental.runtime.prod.js'],
    ['app-route', 'dist/compiled/next-server/app-route-turbo-experimental.runtime.prod.js'],
  ] as const)(
    'closes a %s constructor directly from selected runtime %s',
    async (kind, runtime) => {
      const own = await templateFixture(directory, kind, runtime);
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.normalization?.runtimeRootDir).toBe(directory);
      expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
    },
  );

  it.each([
    ['different constructor family', 'dist/compiled/next-server/app-route.runtime.prod.js'],
    ['unreviewed AppPage class path', 'dist/compiled/next-server/app-page.runtime.prod.js'],
  ])(
    'refuses direct runtime with %s even when its bytes are a known Next source',
    async (_name, runtime) => {
      const own = await templateFixture(directory, 'pages', runtime);

      await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('Unproved Next.js');
    },
  );

  it('refuses a second physical importer that escapes the SDK normalization terminal', async () => {
    const own = await fixture(directory);
    const other = path.join(directory, 'other.cjs');
    const code = `module.exports=require(${jsLiteral(own.entry)});`;
    await writeFile(other, code);
    own.sources.set(other, { file: other, sha256: digest(code) });
    own.imports.set(other, [{ specifier: own.entry, target: own.entry }]);
    own.graph.importers.get(own.entry)?.push(other);
    own.graph.importers.set(other, []);
    own.graph.retained.add(other);

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'unknown consumer or export escape',
    );
  });
});
