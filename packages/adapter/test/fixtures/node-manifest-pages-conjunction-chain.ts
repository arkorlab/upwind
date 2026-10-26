import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { appEntrySource } from '../../src/app-entry.ts';
import { jsLiteral } from '../../src/codegen.ts';
import { createNodeManifestBoundBatch } from '../../src/node-manifest-bound-batch.ts';
import { certifyNodeManifestRuntimeCallers } from '../../src/node-manifest-runtime-callers.ts';
import type { NodeManifestTurbopackConsumerInput } from '../../src/node-manifest-turbopack-consumers.ts';
import { projectNodeManifestTurbopackFactory } from '../../src/node-manifest-turbopack.ts';
import { addBoundBatchTemplate, boundBatchFixture } from './node-manifest-bound-batch.ts';
import { manifestTemplateSource as source } from './node-manifest-turbopack-template.ts';

const CLASS_ID = 77;
const SECOND_PAGE = '/other/[slug]';

/** Authored inert source only: Next modules and generated route entries are never evaluated. */
async function createFixture(directory: string) {
  const own = await boundBatchFixture(directory);
  const first = await addBoundBatchTemplate(own, 'pages');
  const producer = path.join(own.root, 'dist/server/route-modules/pages/module.compiled.js');
  const wrapperTable = path.join(own.input.distDir, 'server/chunks/pages-wrapper.js');
  const original = await readFile(own.chunk, 'utf8');
  const originalImports = [...(own.imports.get(own.chunk) ?? [])];
  const projection = projectNodeManifestTurbopackFactory(source(original), 10);
  const callback = original.slice(projection.factory.start, projection.factory.end);
  const external = `runtimeContext.x(${jsLiteral(producer)},()=>require(${jsLiteral(producer)}))`;
  const replaced = callback.replace(external, () => `runtimeContext.i(${CLASS_ID})`);
  if (callback === replaced) throw new Error('Expected the authored template constructor port');
  const secondCallback = replaced.replaceAll(first.page, () => SECOND_PAGE);
  const wrapper = (strict: boolean, mode: string) =>
    `ctx=>{${strict ? '"use strict";' : ''}const ns=ctx.x(${jsLiteral(producer)},()=>require(${jsLiteral(producer)})${mode});ctx.n(ns);}`;
  const changed = original.slice(0, projection.factory.start) + replaced + original.slice(projection.factory.end);
  await own.put(own.chunk, changed.replace('module.exports=[', () => `module.exports=[${CLASS_ID},${wrapper(true, '')},11,${secondCallback},`));
  own.imports.set(own.chunk, originalImports);
  await own.put(wrapperTable, `module.exports=[${CLASS_ID},${wrapper(false, ',false')}];`);
  own.imports.set(wrapperTable, [{ specifier: producer, target: producer }]);
  own.imports.get(own.runtime)?.push({ specifier: wrapperTable, target: wrapperTable });
  const second = { file: path.join(own.input.distDir, `server/pages${SECOND_PAGE}.js`), kind: 'pages' as const, page: SECOND_PAGE, pathname: SECOND_PAGE };
  const relative = path.relative(own.input.distDir, second.file).split(path.sep).join('/');
  const runtimeSpecifier = path.relative(path.dirname(second.file), own.runtime).split(path.sep).join('/');
  await own.put(second.file, `var R=require(${jsLiteral(runtimeSpecifier)})(${jsLiteral(relative)});R.c("server/chunks/pages-wrapper.js");R.c("server/chunks/app.js");module.exports=R.m(11).exports;`);
  own.imports.set(second.file, [{ specifier: runtimeSpecifier, target: own.runtime }]);
  own.input.entries.push({ id: second.pathname, filePath: second.file });
  own.input.runtimeManifest = JSON.stringify({ entrypoints: [
    { id: '/native', kind: 'app-page', pathname: '/native' },
    { id: first.pathname, kind: 'pages', pathname: first.pathname },
    { id: second.pathname, kind: 'pages', pathname: second.pathname },
  ] });
  await own.put(own.analysisEntry, appEntrySource(own.input.entries, { external: true, runtimeDistDir: own.input.distDir, nodeRequestMeta: true }));
  own.imports.set(own.analysisEntry, own.input.entries.map((entry) => ({ specifier: entry.filePath, target: entry.filePath })));
  const routes = [{ file: own.entry, page: '/native/page', pathname: '/native', kind: 'app-page' as const }, first, second];

  function link() {
    own.graph.importers.clear();
    for (const id of own.sources.keys()) own.graph.importers.set(id, []);
    for (const [from, edges] of own.imports)
      for (const edge of edges) own.graph.importers.get(edge.target)?.push(from);
    own.graph.retained = new Set(own.sources.keys());
  }
  link();
  async function consumerInput(): Promise<NodeManifestTurbopackConsumerInput> {
    const sources = await Promise.all([...own.sources].map(async ([id, entry]) => ({ id, file: entry.file, source: source(await readFile(entry.file, 'utf8')), imports: own.imports.get(id) ?? [] })));
    const runtimeCallers = await certifyNodeManifestRuntimeCallers({
      rootDir: directory,
      distDir: own.input.distDir,
      entries: own.input.entries.map((entry) => ({ id: entry.id, canonicalFilePath: entry.filePath })),
      routes,
      entryTraces: own.input.entryTraces,
      sources,
      retained: own.graph.retained,
    });
    const identity = own.sources.get(producer);
    if (identity === undefined) throw new Error('Expected the authored pinned producer');
    return { rootDir: directory, distDir: own.input.distDir, sources, runtimeCallers, runtimeProfiles: routes.map((route) => ({ file: route.file, pathname: route.pathname, kind: route.kind })), entries: [first, second], boundBatch: createNodeManifestBoundBatch(), producer: { id: producer, file: producer, sha256: identity.sha256, kind: 'pages-class' } };
  }
  return { ...own, first, second, producer, wrapperTable, constructorId: CLASS_ID, consumerInput, link };
}

export async function pagesConjunctionChainFixture(directory: string): Promise<Awaited<ReturnType<typeof createFixture>>> {
  return await createFixture(directory);
}
