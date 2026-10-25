import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  proveNodeManifestTurbopackConsumers,
  type NodeManifestTurbopackConsumerInput,
} from '../src/node-manifest-turbopack-consumers.ts';

const DIST = '/project/.next';
const ENTRY = `${DIST}/server/app/native/page.js`;
const CHUNK = `${DIST}/server/chunks/app.js`;
const RUNTIME = `${DIST}/server/chunks/[turbopack]_runtime.js`;
const SPECIFIER = 'next/dist/build/templates/app-page-runtime.js';
const PRODUCER = `/project/node_modules/${SPECIFIER}`;
const CALLER = [
  'ctx.s(["__next_app__",()=>__next_app__,"handler",()=>handler,"routeModule",()=>routeModule]);',
  'var producer=ctx.i(2);',
  'const entrypoint=producer.createAppPageEntrypoint({tree,page:"/native/page",pathname:"/native",require:ctx.r.bind(ctx),loadChunk:ctx.l.bind(ctx),interopDefault});',
  'const __next_app__=entrypoint.__next_app__;const routeModule=entrypoint.routeModule;const handler=entrypoint.handler;',
].join('\n');

function source(code: string): { readonly code: string; readonly sha256: string } {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

async function fixture(): Promise<NodeManifestTurbopackConsumerInput> {
  const runtime = await readFile(
    new URL('fixtures/node-runtime/production.txt', import.meta.url),
    'utf8',
  );
  const code = runtime
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
  const producerFile = fileURLToPath(
    import.meta.resolve('next/dist/build/templates/app-page-runtime.js'),
  );
  const producer = source(await readFile(producerFile, 'utf8'));
  return {
    distDir: DIST,
    rootDir: '/project',
    entries: [{ file: ENTRY, page: '/native/page', pathname: '/native' }],
    producer: { id: PRODUCER, file: PRODUCER, sha256: producer.sha256 },
    sources: [
      {
        id: ENTRY,
        file: ENTRY,
        source: source(
          'var R=require("../../chunks/[turbopack]_runtime.js")("server/app/native/page.js");R.c("server/chunks/app.js");R.m(1);module.exports=R.m(1).exports;',
        ),
        imports: [{ specifier: '../../chunks/[turbopack]_runtime.js', target: RUNTIME }],
      },
      {
        id: RUNTIME,
        file: RUNTIME,
        source: source(code),
        imports: [{ specifier: CHUNK, target: CHUNK }],
      },
      {
        id: CHUNK,
        file: CHUNK,
        source: source(
          `module.exports=[1,((ctx)=>{${CALLER}}),2,((ctx)=>{var p=ctx.x(${JSON.stringify(SPECIFIER)},()=>require(${JSON.stringify(SPECIFIER)}));ctx.n(p);})];`,
        ),
        imports: [{ specifier: SPECIFIER, target: PRODUCER }],
      },
      { id: PRODUCER, file: PRODUCER, source: producer, imports: [] },
    ],
  };
}

function replaceFile(
  input: NodeManifestTurbopackConsumerInput,
  file: string,
  change: (code: string) => string,
): NodeManifestTurbopackConsumerInput {
  return {
    ...input,
    sources: input.sources.map((record) =>
      record.file === file ? { ...record, source: source(change(record.source.code)) } : record,
    ),
  };
}

describe('next Turbopack protected producer chains', () => {
  it('proves the runtime, individual factory and sealed route, leaving the actual SDK root obligation open', async () => {
    const input = await fixture();
    const proof = await proveNodeManifestTurbopackConsumers(input);

    expect({
      terminals: proof.terminals,
      normalization: proof.requiresSdkNormalization,
      files: proof.files.map((file) => file.file),
    }).toStrictEqual({
      terminals: [{ id: ENTRY, file: ENTRY, page: '/native/page', pathname: '/native' }],
      normalization: true,
      files: [ENTRY, RUNTIME, CHUNK],
    });
  });

  it('allows only a canonical namespace facade between the route factory and its boot terminal', async () => {
    let input = await fixture();
    input = replaceFile(input, CHUNK, (code) =>
      code.replace('module.exports=[', 'module.exports=[3,((ctx)=>{var p=ctx.i(1);ctx.n(p);}),'),
    );
    input = replaceFile(input, ENTRY, (code) =>
      code.replace('module.exports=R.m(1)', 'module.exports=R.m(3)'),
    );

    const proof = await proveNodeManifestTurbopackConsumers(input);

    expect(proof.terminals).toStrictEqual([
      { id: ENTRY, file: ENTRY, page: '/native/page', pathname: '/native' },
    ]);
  });

  it.each([
    [
      'unsealed consumer',
      (input: NodeManifestTurbopackConsumerInput) =>
        replaceFile(input, CHUNK, (code) =>
          code.replace('module.exports=[', () => `module.exports=[3,((ctx)=>{${CALLER}}),`),
        ),
    ],
    [
      'handler call outside normalization',
      (input: NodeManifestTurbopackConsumerInput) =>
        replaceFile(input, CHUNK, (code) =>
          code.replace(
            'module.exports=[',
            'module.exports=[3,((ctx)=>{var p=ctx.i(1);p.handler(request,response,context);}),',
          ),
        ),
    ],
    [
      'producer reaches route terminal',
      (input: NodeManifestTurbopackConsumerInput) =>
        replaceFile(input, ENTRY, (code) =>
          code.replace('module.exports=R.m(1)', 'module.exports=R.m(2)'),
        ),
    ],
    [
      'changed runtime semantics',
      (input: NodeManifestTurbopackConsumerInput) =>
        replaceFile(input, RUNTIME, (code) => `${code}\nContext.prototype.i=evil;`),
    ],
    [
      'unsealed page constant',
      (input: NodeManifestTurbopackConsumerInput) => ({
        ...input,
        entries: [{ file: ENTRY, page: '/other/page', pathname: '/native' }],
      }),
    ],
    [
      'duplicate sealed entry',
      (input: NodeManifestTurbopackConsumerInput) => ({
        ...input,
        entries: [...input.entries, { file: ENTRY, page: '/native/page', pathname: '/native' }],
      }),
    ],
    [
      'custom untraced runtime callback',
      (input: NodeManifestTurbopackConsumerInput) =>
        replaceFile(input, CHUNK, (code) =>
          code.replace('require:ctx.r.bind(ctx)', 'require:customRequire'),
        ),
    ],
    [
      'extra bound callback in a real consumer',
      (input: NodeManifestTurbopackConsumerInput) =>
        replaceFile(input, CHUNK, (code) =>
          code.replace('var producer=', 'const leak={require:ctx.r.bind(ctx)};var producer='),
        ),
    ],
    [
      'callbacks bound outside the verified factory argument',
      (input: NodeManifestTurbopackConsumerInput) =>
        replaceFile(input, CHUNK, (code) =>
          code
            .replace(
              'var producer=',
              'const ignored={require:ctx.r.bind(ctx),loadChunk:ctx.l.bind(ctx)};var producer=',
            )
            .replace(
              'require:ctx.r.bind(ctx),loadChunk:ctx.l.bind(ctx),interopDefault',
              'require:customRequire,loadChunk:customLoadChunk,interopDefault',
            ),
        ),
    ],
  ])('refuses %s even though the original physical files remain present', async (_name, change) => {
    const input = change(await fixture());

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow('Unproved Next.js');
  });

  it.each([
    ['runtime API', RUNTIME],
    ['factory table', CHUNK],
    ['producer', PRODUCER],
  ])('refuses an unknown physical caller of the %s', async (_name, target) => {
    const input = await fixture();
    const other = '/project/unknown.js';
    const altered = {
      ...input,
      sources: [
        ...input.sources,
        {
          id: other,
          file: other,
          source: source(`module.exports=require(${JSON.stringify(target)});`),
          imports: [{ specifier: target, target }],
        },
      ],
    };

    await expect(proveNodeManifestTurbopackConsumers(altered)).rejects.toThrow(
      'Unproved Next.js Turbopack manifest chain',
    );
  });

  it('inspects a deferred runtime table that accesses a protected route without directly importing its producer', async () => {
    const input = await fixture();
    const deferred = `${DIST}/server/chunks/deferred.js`;
    const altered = {
      ...input,
      sources: [
        ...input.sources.map((record) => {
          return record.id === RUNTIME
            ? {
                ...record,
                imports: [...record.imports, { specifier: deferred, target: deferred }],
              }
            : record;
        }),
        {
          id: deferred,
          file: deferred,
          source: source(
            'module.exports=[3,((ctx)=>{var page=ctx.i(1);page.routeModule.loadManifests("/outside","/tmp");})];',
          ),
          imports: [],
        },
      ],
    };

    await expect(proveNodeManifestTurbopackConsumers(altered)).rejects.toThrow(
      'route class/handler used outside normalization',
    );
  });

  it('refuses an untainted factory that exports a bound runtime loader with no static protected-module edge', async () => {
    let input = await fixture();
    input = replaceFile(input, CHUNK, (code) =>
      code.replace(
        'module.exports=[',
        'module.exports=[3,((ctx)=>{ctx.s(["leak",()=>leak]);const leak={require:ctx.r.bind(ctx)};}),',
      ),
    );

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow(
      'bound runtime callback escapes a sealed consumer',
    );
  });
});
