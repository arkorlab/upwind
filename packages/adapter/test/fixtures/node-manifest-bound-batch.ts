import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appEntrySource } from '../../src/app-entry.ts';
import { jsLiteral } from '../../src/codegen.ts';
import type { NativeAddonEntryTrace } from '../../src/native-addons.ts';
import { certifyNodeManifestRuntimeCallers } from '../../src/node-manifest-runtime-callers.ts';
import type { NodeManifestTurbopackConsumerInput } from '../../src/node-manifest-turbopack-consumers.ts';
import { projectNodeManifestTurbopackFactory } from '../../src/node-manifest-turbopack.ts';
import {
  manifestTemplateSource,
  projectedTemplateFixture,
} from './node-manifest-turbopack-template.ts';

const SPECIFIER = 'next/dist/build/templates/app-page-runtime.js';
const PRODUCER_KINDS = {
  'app-page': 'app-page-factory',
  pages: 'pages-class',
  'pages-api': 'pages-api-class',
} as const;
const CHAIN = [
  'dist/server/load-manifest.external.js',
  'dist/compiled/next-server/app-page.runtime.prod.js',
  'dist/server/route-modules/app-page/module.compiled.js',
  'dist/build/templates/app-page-runtime.js',
] as const;

function digest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}

interface SourceIdentity {
  readonly file: string;
  readonly sha256: string;
}
interface SourceEdge {
  readonly specifier: string;
  readonly target: string;
}
interface FixtureInput {
  rootDir: string;
  distDir: string;
  entries: { id: string; filePath: string }[];
  analysisEntry: string;
  runtimeManifest: string;
  entryTraces: NativeAddonEntryTrace[];
  manifests: { name: string; contents: string; routeFile: string }[];
}
export interface BoundBatchFixture {
  readonly root: string;
  readonly publishedRoot: string;
  readonly evaluator: string;
  readonly compiled: string;
  readonly module: string;
  readonly producer: string;
  readonly runtime: string;
  readonly chunk: string;
  readonly entry: string;
  readonly manifest: string;
  readonly analysisEntry: string;
  readonly sources: Map<string, SourceIdentity>;
  readonly imports: Map<string, SourceEdge[]>;
  readonly input: FixtureInput;
  readonly graph: {
    sources: Map<string, SourceIdentity>;
    imports: Map<string, SourceEdge[]>;
    importers: Map<string, string[]>;
    roots: Set<string>;
    retained: Set<string>;
  };
  put(file: string, code: string | Uint8Array): Promise<string>;
}

export async function boundBatchFixture(directory: string): Promise<BoundBatchFixture> {
  const published = await realpath(
    fileURLToPath(import.meta.resolve('next/dist/server/load-manifest.external.js')),
  );
  const publishedRoot = path.resolve(path.dirname(published), '../..');
  const root = path.join(directory, 'node_modules/next');
  const sources = new Map<string, { readonly file: string; readonly sha256: string }>();
  const imports = new Map<string, { readonly specifier: string; readonly target: string }[]>();
  const put = async (file: string, code: string | Uint8Array): Promise<string> => {
    const relative = path.relative(directory, file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Source fixture output outside root');
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
    new URL('node-runtime/production.txt', import.meta.url),
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
  const entryTraces: NativeAddonEntryTrace[] = [{ id: '/native', assets: { manifest } }];
  return {
    root,
    publishedRoot,
    put,
    evaluator,
    compiled,
    module,
    producer,
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
      entryTraces,
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

export async function addBoundBatchTemplate(
  own: Awaited<ReturnType<typeof boundBatchFixture>>,
  kind: 'pages' | 'pages-api',
): Promise<{
  readonly file: string;
  readonly kind: 'pages' | 'pages-api';
  readonly page: string;
  readonly pathname: string;
}> {
  const template = await projectedTemplateFixture(kind);
  const module = path.join(own.root, `dist/server/route-modules/${kind}/module.compiled.js`);
  const compiled = path.join(own.root, `dist/compiled/next-server/${kind}.runtime.prod.js`);
  for (const file of [module, compiled]) {
    const relative = path.relative(own.root, file);
    const published = path.join(own.publishedRoot, relative);
    await own.put(file, await readFile(published));
  }
  const templateFile = path.join(own.root, `dist/build/templates/${kind}.js`);
  await mkdir(path.dirname(templateFile), { recursive: true });
  await writeFile(
    templateFile,
    await readFile(path.join(own.publishedRoot, `dist/build/templates/${kind}.js`)),
  );
  let code = template.projection.original.code;
  const external: { readonly specifier: string; readonly target: string }[] = [];
  for (const imported of template.imports) {
    if (imported.specifier.startsWith('turbopack:')) continue;
    const relative = path.relative(own.publishedRoot, imported.file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Unexpected external primary source');
    const file = path.join(own.root, relative);
    await own.put(file, await readFile(imported.file));
    code = code.replaceAll(jsLiteral(imported.specifier), () => jsLiteral(file));
    external.push({ specifier: file, target: file });
  }
  const projected = projectNodeManifestTurbopackFactory(manifestTemplateSource(code), 1);
  const callback = code.slice(projected.factory.start, projected.factory.end);
  const ids = new Set(
    template.projection.imports.flatMap((entry) =>
      entry.targetId === undefined ? [] : [entry.targetId],
    ),
  );
  const slots = [...ids]
    .map((id) => `${jsLiteral(id)},ctx=>{ctx.s(["default",()=>value]);const value={};},`)
    .join('');
  const chunk = await readFile(own.chunk, 'utf8');
  await own.put(
    own.chunk,
    chunk.replace('module.exports=[', () => `module.exports=[${slots}10,${callback},`),
  );
  own.imports.set(own.chunk, [{ specifier: SPECIFIER, target: own.producer }, ...external]);
  own.imports.set(compiled, [{ specifier: own.evaluator, target: own.evaluator }]);
  own.imports.set(module, [{ specifier: compiled, target: compiled }]);
  const relative = `server/pages${template.route.page}.js`;
  const entry = path.join(own.input.distDir, relative);
  const runtimeSpecifier = path
    .relative(path.dirname(entry), own.runtime)
    .split(path.sep)
    .join('/');
  await own.put(
    entry,
    `var R=require(${jsLiteral(runtimeSpecifier)})(${jsLiteral(relative)});R.c("server/chunks/app.js");R.m(10);module.exports=R.m(10).exports;`,
  );
  own.imports.set(entry, [{ specifier: runtimeSpecifier, target: own.runtime }]);
  own.input.entries.push({ id: template.route.pathname, filePath: entry });
  own.input.runtimeManifest = JSON.stringify({
    entrypoints: [
      { id: '/native', kind: 'app-page', pathname: '/native' },
      { id: template.route.pathname, kind, pathname: template.route.pathname },
    ],
  });
  await own.put(
    own.analysisEntry,
    appEntrySource(own.input.entries, {
      external: true,
      runtimeDistDir: own.input.distDir,
      nodeRequestMeta: true,
    }),
  );
  own.imports.set(
    own.analysisEntry,
    own.input.entries.map((item) => ({ specifier: item.filePath, target: item.filePath })),
  );
  own.graph.importers.clear();
  for (const file of own.sources.keys()) own.graph.importers.set(file, []);
  for (const [from, edges] of own.imports)
    for (const edge of edges) own.graph.importers.get(edge.target)?.push(from);
  own.graph.retained = new Set(own.sources.keys());
  return { file: entry, ...template.route, kind };
}

export async function boundBatchConsumerInput(
  own: Awaited<ReturnType<typeof boundBatchFixture>>,
  other: Awaited<ReturnType<typeof addBoundBatchTemplate>>,
  kind: 'app-page' | 'pages' | 'pages-api',
): Promise<NodeManifestTurbopackConsumerInput> {
  const routes = [
    { file: own.entry, page: '/native/page', pathname: '/native', kind: 'app-page' as const },
    other,
  ];
  const sources = await Promise.all(
    [...own.sources].map(async ([id, entry]) => {
      return {
        id,
        file: entry.file,
        source: { code: await readFile(entry.file, 'utf8'), sha256: entry.sha256 },
        imports: own.imports.get(id) ?? [],
      };
    }),
  );
  const runtimeCallers = await certifyNodeManifestRuntimeCallers({
    rootDir: own.input.rootDir,
    distDir: own.input.distDir,
    entries: own.input.entries.map((entry) => {
      return {
        id: entry.id,
        canonicalFilePath: entry.filePath,
      };
    }),
    routes,
    entryTraces: own.input.entryTraces,
    sources,
    retained: own.graph.retained,
  });
  const producer =
    kind === 'app-page'
      ? own.producer
      : path.join(own.root, `dist/server/route-modules/${kind}/module.compiled.js`);
  const source = own.sources.get(producer);
  if (source === undefined) throw new Error('Expected a pinned source producer');
  const producerKind = PRODUCER_KINDS[kind];
  return {
    rootDir: own.input.rootDir,
    distDir: own.input.distDir,
    sources,
    entries: routes.filter((route) => route.kind === kind),
    runtimeCallers,
    runtimeProfiles: routes.map((route) => {
      return {
        file: route.file,
        pathname: route.pathname,
        kind: route.kind,
      };
    }),
    producer: { id: producer, file: producer, sha256: source.sha256, kind: producerKind },
  };
}
