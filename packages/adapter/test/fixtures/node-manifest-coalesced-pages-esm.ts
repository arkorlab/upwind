import { readFile } from 'node:fs/promises';

import { jsLiteral } from '../../src/codegen.ts';
import { certifyNodeManifestCoalescedPages } from '../../src/node-manifest-coalesced-pages.ts';
import { nodeManifestCoalescedImports } from '../../src/node-manifest-template-imports.ts';
import type { NodeManifestTurbopackConsumerInput } from '../../src/node-manifest-turbopack-consumers.ts';
import {
  nodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackGraphFactory,
} from '../../src/node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackTemplateInput } from '../../src/node-manifest-turbopack-templates.ts';
import { COALESCED_CHUNK, coalescedPagesFixture } from './node-manifest-coalesced-pages.ts';
import { pagesEsmFixture } from './node-manifest-pages-esm.ts';
import { manifestTemplateSource as source } from './node-manifest-turbopack-template.ts';

const CONSTRUCTOR = 'next/dist/compiled/next-server/pages-turbo.runtime.prod.js';
interface Fixture {
  readonly input: NodeManifestTurbopackConsumerInput;
  readonly graph: NodeManifestTurbopackBootGraph;
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly template: NodeManifestTurbopackTemplateInput;
}

/** Authored original cache protocol and ESM wrapper text, never an executed fixture. */
export async function coalescedPagesEsmFixture(
  options: {
    readonly kind?: 'var' | 'let' | 'const';
    readonly afterRead?: string;
    readonly namespaceMethod?: 'i' | 'r';
  } = {},
): Promise<Fixture> {
  const own = await pagesEsmFixture({ kind: options.kind ?? 'var' });
  const base = await coalescedPagesFixture();
  const constructor = own.imports.find((entry) => entry.file.endsWith('/pages/module.compiled.js'));
  if (constructor === undefined) throw new TypeError('Expected the authored constructor port');
  const old = `context.x(${jsLiteral(constructor.specifier)},()=>require(${jsLiteral(constructor.specifier)}))`;
  const replacement = `context.x(${jsLiteral(CONSTRUCTOR)},()=>require(${jsLiteral(CONSTRUCTOR)}))`;
  const kind = options.kind ?? 'var';
  let code = own.projection.original.code
    .replace(old, () => replacement)
    .replace(
      'userland=context.i(102)',
      () => `userland=context.${options.namespaceMethod ?? 'i'}(42)`,
    )
    .replace(
      `${kind} moduleNs=`,
      () => `context.s(["default",0,function Page(){return "native";}],42);${kind} moduleNs=`,
    );
  if (options.afterRead !== undefined)
    code = code.replace(`${kind} defaultValue=`, () => `${options.afterRead}${kind} defaultValue=`);
  const slots = [100, 101]
    .map((id) => `${id},ctx=>{const value={};ctx.s(["default",0,value]);},`)
    .join('');
  const chunk = source(code.replace('module.exports=[', () => `module.exports=[${slots}`));
  const imports = own.imports
    .filter((entry) => !entry.specifier.startsWith('turbopack:'))
    .map((entry) => {
      return entry === constructor
        ? {
            specifier: CONSTRUCTOR,
            file: base.input.producer.file,
            sha256: base.input.producer.sha256,
          }
        : entry;
    });
  const input = {
    ...base.input,
    sources: [
      ...base.input.sources.slice(0, 2),
      {
        id: COALESCED_CHUNK,
        file: COALESCED_CHUNK,
        source: chunk,
        imports: imports.map((entry) => ({ specifier: entry.specifier, target: entry.file })),
      },
      ...(await Promise.all(
        imports.map(async (entry) => {
          return {
            id: entry.file,
            file: entry.file,
            source: source(await readFile(entry.file, 'utf8')),
            imports: [],
          };
        }),
      )),
    ],
  };
  const entry = input.entries[0];
  if (entry === undefined) throw new TypeError('Expected the owned authored Pages entry');
  const graph = nodeManifestTurbopackEntryGraph({
    distDir: input.distDir,
    entry,
    sources: input.sources,
  });
  const factory = graph.factories.find((candidate) => candidate.projection.moduleId === 1);
  if (factory === undefined) throw new TypeError('Expected the authored coalesced Pages factory');
  const actualImports = nodeManifestCoalescedImports({
    factory,
    sources: input.sources,
    target: (id) => graph.factories.find((candidate) => candidate.id === id)?.physicalId ?? id,
  });
  const route = { ...own.route, kind: 'pages' as const };
  const profile = certifyNodeManifestCoalescedPages({
    owner: input,
    graph,
    factory,
    imports: actualImports,
    route,
  });
  const template: NodeManifestTurbopackTemplateInput = {
    projection: factory.projection,
    imports: actualImports.map((imported) => {
      if ('builtin' in imported) throw new TypeError('Unexpected authored builtin template port');
      return imported;
    }),
    route,
    coalesced: { profile, owner: input },
  };
  return { input, graph, factory, template };
}
