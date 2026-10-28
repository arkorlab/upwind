import { readFile } from 'node:fs/promises';

import { jsLiteral } from '../../src/codegen.ts';
import { type NodeManifestTurbopackConsumerInput } from '../../src/node-manifest-turbopack-consumers.ts';
import type { NodeManifestTurbopackModuleId } from '../../src/node-manifest-turbopack.ts';
import {
  manifestTemplateSource,
  projectedTemplateFixture,
} from './node-manifest-turbopack-template.ts';

export const CONTEXT_DIST = '/project/.next';
export const CONTEXT_ENTRY = `${CONTEXT_DIST}/server/pages/blog/[slug].js`;
export const CONTEXT_CHUNK = `${CONTEXT_DIST}/server/chunks/contexts.js`;
export const CONTEXT_RUNTIME = `${CONTEXT_DIST}/server/chunks/[turbopack]_runtime.js`;
export const CONTEXT_ID = 50;
export const ORDINARY_ID = 52;
const WRAPPER = 'dist/server/route-modules/pages/module.compiled.js';

export function changeContextGraphSource(
  input: NodeManifestTurbopackConsumerInput,
  file: string,
  change: (code: string) => string,
): NodeManifestTurbopackConsumerInput {
  return {
    ...input,
    sources: input.sources.map((record) => {
      return record.file === file
        ? { ...record, source: manifestTemplateSource(change(record.source.code)) }
        : record;
    }),
  };
}

export async function pagesContextGraph(
  options: {
    readonly form?: 'i' | 'r' | 'x';
    readonly forwardId?: NodeManifestTurbopackModuleId;
  } = {},
): Promise<NodeManifestTurbopackConsumerInput> {
  const template = await projectedTemplateFixture('pages');
  const producer = template.imports.find((entry) => entry.file.endsWith(WRAPPER));
  if (producer === undefined) throw new Error('Expected the pinned Pages producer');
  const physical = template.imports.filter((entry) => !entry.specifier.startsWith('turbopack:'));
  const records = await Promise.all(
    physical.map(async (entry) => {
      const source = manifestTemplateSource(await readFile(entry.file, 'utf8'));
      if (source.sha256 !== entry.sha256) throw new Error('Changed primary import');
      return { id: entry.file, file: entry.file, source, imports: [] };
    }),
  );
  const slots = template.imports.filter((entry) => entry.specifier.startsWith('turbopack:'));
  const slotFactories = slots
    .map((entry) => {
      const dependency = template.projection.imports.find(
        (own) => own.specifier === entry.specifier,
      );
      if (dependency?.targetId === undefined) throw new Error('Expected a literal slot target');
      const read = entry.file.endsWith('/VAR_USERLAND.js') ? `ctx.i(${CONTEXT_ID});` : '';
      return `${jsLiteral(dependency.targetId)},ctx=>{${read}ctx.v({});},`;
    })
    .join('');
  const forwardId = options.forwardId ?? 51;
  const external = `ctx.x(${jsLiteral(producer.specifier)},()=>require(${jsLiteral(producer.specifier)}))`;
  const form = options.form ?? 'r';
  const imported = form === 'x' ? external : `ctx.${form}(${jsLiteral(forwardId)})`;
  const selector = `${CONTEXT_ID},(ctx,module,exports)=>{module.exports=${imported}.vendored['contexts'].RouterContext;},`;
  const forwarder = `${jsLiteral(forwardId)},(ctx,module,exports)=>{module.exports=${external};},`;
  const ordinary = `${ORDINARY_ID},ctx=>{ctx.v(42);},`;
  const code = template.projection.original.code.replace(
    'module.exports=[',
    () => `module.exports=[${slotFactories}${selector}${forwarder}${ordinary}`,
  );
  const runtime = (await readFile(new URL('node-runtime/production.txt', import.meta.url), 'utf8'))
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
  return {
    distDir: CONTEXT_DIST,
    rootDir: '/project',
    entries: [{ file: CONTEXT_ENTRY, ...template.route }],
    producer: {
      id: producer.file,
      file: producer.file,
      sha256: producer.sha256,
      kind: 'pages-class',
    },
    sources: [
      {
        id: CONTEXT_ENTRY,
        file: CONTEXT_ENTRY,
        source: manifestTemplateSource(
          'var R=require("../../chunks/[turbopack]_runtime.js")("server/pages/blog/[slug].js");R.c("server/chunks/contexts.js");module.exports=R.m(1).exports;',
        ),
        imports: [{ specifier: '../../chunks/[turbopack]_runtime.js', target: CONTEXT_RUNTIME }],
      },
      {
        id: CONTEXT_RUNTIME,
        file: CONTEXT_RUNTIME,
        source: manifestTemplateSource(runtime),
        imports: [{ specifier: CONTEXT_CHUNK, target: CONTEXT_CHUNK }],
      },
      {
        id: CONTEXT_CHUNK,
        file: CONTEXT_CHUNK,
        source: manifestTemplateSource(code),
        imports: physical.map((entry) => ({ specifier: entry.specifier, target: entry.file })),
      },
      ...records,
    ],
  };
}

export function addContextRoute(
  input: NodeManifestTurbopackConsumerInput,
): NodeManifestTurbopackConsumerInput {
  const file = `${CONTEXT_DIST}/server/pages/contexts.js`;
  return {
    ...input,
    entries: [...input.entries, { file, kind: 'pages', page: '/contexts', pathname: '/contexts' }],
    sources: [
      ...input.sources,
      {
        id: file,
        file,
        source: manifestTemplateSource(
          `var R=require("../chunks/[turbopack]_runtime.js")("server/pages/contexts.js");R.c("server/chunks/contexts.js");module.exports=R.m(${CONTEXT_ID}).exports;`,
        ),
        imports: [{ specifier: '../chunks/[turbopack]_runtime.js', target: CONTEXT_RUNTIME }],
      },
    ],
  };
}

export function withForeignContext(
  input: NodeManifestTurbopackConsumerInput,
): NodeManifestTurbopackConsumerInput {
  const original = input.sources.find((record) => record.id === input.producer.id);
  if (original === undefined) throw new Error('Expected actual producer source');
  const foreign = `/foreign/node_modules/next/${WRAPPER}`;
  const changed = changeContextGraphSource(input, CONTEXT_CHUNK, (code) => {
    return code.replace(
      `module.exports=ctx.r(51).vendored`,
      'module.exports=ctx.x("foreign-pages",()=>require("foreign-pages")).vendored',
    );
  });
  return {
    ...changed,
    producer: { ...input.producer, id: foreign, file: foreign },
    sources: [
      ...changed.sources.map((record) => {
        return record.id === CONTEXT_CHUNK
          ? {
              ...record,
              imports: [...record.imports, { specifier: 'foreign-pages', target: foreign }],
            }
          : record;
      }),
      { ...original, id: foreign, file: foreign },
    ],
  };
}
