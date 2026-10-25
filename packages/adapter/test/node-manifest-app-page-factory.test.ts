import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAst } from 'rolldown/parseAst';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { isNode, listOf } from '../src/lexical-scope.ts';
import {
  certifyNodeManifestAppPageFactory,
  isCertifiedNodeManifestAppPageFactory,
  type NodeManifestAppPageFactoryImport,
} from '../src/node-manifest-app-page-factory.ts';
import { identifier, stringOf, visitTree } from '../src/node-manifest-consumer-ast.ts';
import { assertNodeManifestConsumer } from '../src/node-manifest-consumers.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';

const FACTORY = 'createAppPageEntrypoint';
const CLASS_SPECIFIER = '../../server/route-modules/app-page/module.compiled';
const ROUTE = [
  'ctx.s(["__next_app__",()=>__next_app__,"handler",()=>handler,"routeModule",()=>routeModule]);',
  'var p=ctx.i(2);',
  `const own=p.${FACTORY}({tree,page:"/native/page",pathname:"/native",require:ctx.r.bind(ctx),loadChunk:ctx.l.bind(ctx),interopDefault});`,
  'const __next_app__=own.__next_app__;const handler=own.handler;const routeModule=own.routeModule;',
].join('\n');

function source(code: string) {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
async function fixture(directory: string) {
  const template = fileURLToPath(
    import.meta.resolve('next/dist/build/templates/app-page-runtime.js'),
  );
  const primary = await readFile(template, 'utf8');
  const require = createRequire(template);
  const root = path.resolve(path.dirname(template), '../../..');
  const parsed: unknown = parseAst(primary);
  if (!isNode(parsed)) throw new Error('Expected primary source program');
  const imports = new Map<string, NodeManifestAppPageFactoryImport>();
  for (const { node } of visitTree(parsed)) {
    if (
      node.type !== 'CallExpression' ||
      !identifier(node['callee']) ||
      node['callee'].name !== 'require'
    )
      continue;
    const specifier = stringOf(listOf(node, 'arguments')[0]);
    if (specifier === undefined) throw new Error('Expected static primary import');
    if (isBuiltin(specifier)) {
      imports.set(specifier, { specifier, builtin: specifier });
      continue;
    }
    const target = specifier.startsWith('next/')
      ? path.join(root, specifier.slice('next/'.length))
      : specifier;
    const file = await realpath(require.resolve(target));
    const bytes = await readFile(file);
    imports.set(specifier, {
      specifier,
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const constructor = imports.get(CLASS_SPECIFIER);
  if (constructor === undefined || 'builtin' in constructor)
    throw new Error('Expected primary class import');
  const distDir = path.join(directory, '.next');
  const chunk = path.join(distDir, 'server/chunks/app.js');
  const runtime = path.join(distDir, 'server/chunks/[turbopack]_runtime.js');
  const entry = path.join(distDir, 'server/app/native/page.js');
  const body = primary.replace(`require(${jsLiteral(CLASS_SPECIFIER)})`, 'ctx.i(3)');
  const code = `module.exports=[1,((ctx)=>{${ROUTE}}),2,(function(ctx,module,exports){${body}\n}),3,((ctx)=>{var p=ctx.x(${jsLiteral(CLASS_SPECIFIER)},()=>require(${jsLiteral(CLASS_SPECIFIER)}));ctx.n(p);})];`;
  await mkdir(path.dirname(chunk), { recursive: true });
  await writeFile(chunk, code);
  const projection = projectNodeManifestTurbopackFactory(source(code), 2);
  const actualImports = [...imports.values()].map((imported) =>
    imported.specifier === CLASS_SPECIFIER ? { ...imported, specifier: 'turbopack:3' } : imported,
  );
  return {
    template,
    primary,
    constructor,
    imports,
    distDir,
    chunk,
    runtime,
    entry,
    code,
    input: { file: chunk, projection, imports: actualImports },
  };
}

describe('fixed AppPage factory authority in an original Turbopack graph', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-app-page-factory-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('certifies the whole pinned body with actual physical imports and immutable selected-module identity', async () => {
    const own = await fixture(directory);
    const proof = await certifyNodeManifestAppPageFactory(own.input);
    const serialized = structuredClone(proof);

    expect({ file: proof.file, sha256: proof.sha256, moduleId: proof.moduleId }).toStrictEqual({
      file: own.chunk,
      sha256: source(own.code).sha256,
      moduleId: 2,
    });
    expect(isCertifiedNodeManifestAppPageFactory(proof, proof)).toBe(true);
    expect(
      [
        Object.isFrozen(proof),
        Object.isFrozen(proof.imports),
        ...proof.imports.map((entry) => Object.isFrozen(entry)),
      ].every(Boolean),
    ).toBe(true);
    expect(isCertifiedNodeManifestAppPageFactory({ ...proof }, proof)).toBe(false);
    expect(isCertifiedNodeManifestAppPageFactory(serialized, proof)).toBe(false);
  });

  it('grants only the existing sealed six-field route use without impersonating a published physical source', async () => {
    const own = await fixture(directory);
    const proof = await certifyNodeManifestAppPageFactory(own.input);
    const projection = projectNodeManifestTurbopackFactory(source(own.code), 1);
    const imported = {
      specifier: 'turbopack:2',
      file: proof.file,
      sha256: proof.sha256,
      kind: 'app-page-factory' as const,
      exportName: FACTORY,
      certifiedFactory: proof,
    };
    const input = {
      source: projection.source,
      imports: [imported],
      route: { page: '/native/page', pathname: '/native' },
      runtimeInputs: {
        require: '__upwind_turbopack_bound_r',
        loadChunk: '__upwind_turbopack_bound_l',
      },
    };

    expect(assertNodeManifestConsumer(input).requiresRuntimeNormalization).toBe(true);
    expect(() => {
      return assertNodeManifestConsumer({
        ...input,
        imports: [{ ...imported, certifiedFactory: { ...proof } }],
      });
    }).toThrow('unknown producer');
    expect(() =>
      assertNodeManifestConsumer({ ...input, route: { page: '/other', pathname: '/native' } }),
    ).toThrow('Unproved Next.js');
  });

  it.each([
    [
      'extra execution',
      'function createAppPageEntrypoint(',
      'sideEffect();function createAppPageEntrypoint(',
    ],
    [
      'different constructor',
      'new _modulecompiled.AppPageRouteModule(',
      'new _modulecompiled.OtherClass(',
    ],
    ['different result', 'return createAppPageEntrypoint;', 'return other;'],
  ])('refuses a changed fixed producer body: %s', async (_name, from, to) => {
    const own = await fixture(directory);
    const code = own.code.replace(from, () => to);
    await writeFile(own.chunk, code);
    const projection = projectNodeManifestTurbopackFactory(source(code), 2);

    await expect(certifyNodeManifestAppPageFactory({ ...own.input, projection })).rejects.toThrow(
      'Unproved Next.js',
    );
  });

  it('requires original physical bytes and actual closed import identities', async () => {
    const own = await fixture(directory);
    await writeFile(own.chunk, `${own.code}\n`);

    await expect(certifyNodeManifestAppPageFactory(own.input)).rejects.toThrow(
      'physical factory source',
    );

    await writeFile(own.chunk, own.code);

    await expect(
      certifyNodeManifestAppPageFactory({
        ...own.input,
        imports: own.input.imports.map((entry) => ({ ...entry, sha256: '0'.repeat(64) })),
      }),
    ).rejects.toThrow('constructor identity');
  });

  it('connects strict class namespace forwarding through the fixed factory and route to a boot terminal', async () => {
    const own = await fixture(directory);
    const originalRuntime = await readFile(
      new URL('fixtures/node-runtime/production.txt', import.meta.url),
      'utf8',
    );
    const runtime = originalRuntime
      .replace(
        'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
        'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
      )
      .replace(
        'var RELATIVE_ROOT_PATH = "../../../../../../..";',
        'var RELATIVE_ROOT_PATH = "..";',
      );
    const sources = [
      {
        id: own.entry,
        file: own.entry,
        source: source(
          'var R=require("../../chunks/[turbopack]_runtime.js")("server/app/native/page.js");R.c("server/chunks/app.js");module.exports=R.m(1).exports;',
        ),
        imports: [{ specifier: '../../chunks/[turbopack]_runtime.js', target: own.runtime }],
      },
      {
        id: own.runtime,
        file: own.runtime,
        source: source(runtime),
        imports: [{ specifier: own.chunk, target: own.chunk }],
      },
      {
        id: own.chunk,
        file: own.chunk,
        source: source(own.code),
        imports: [...own.imports.values()].map((entry) => {
          return {
            specifier: entry.specifier,
            target: 'builtin' in entry ? entry.builtin : entry.file,
          };
        }),
      },
      ...(await Promise.all(
        [...own.imports.values()]
          .filter((entry) => !('builtin' in entry))
          .map(async (entry) => {
            const code = await readFile(entry.file, 'utf8');
            return { id: entry.file, file: entry.file, source: source(code), imports: [] };
          }),
      )),
    ];
    const proof = await proveNodeManifestTurbopackConsumers({
      distDir: own.distDir,
      rootDir: directory,
      sources,
      entries: [{ file: own.entry, page: '/native/page', pathname: '/native' }],
      producer: {
        id: own.constructor.file,
        file: own.constructor.file,
        sha256: own.constructor.sha256,
        kind: 'app-page-class',
      },
    });

    expect(proof.terminals).toStrictEqual([
      { id: own.entry, file: own.entry, page: '/native/page', pathname: '/native' },
    ]);
    expect(proof.requiresSdkNormalization).toBe(true);

    const changed = own.code.replace(
      'module.exports=[',
      'module.exports=[4,((ctx)=>{var c=ctx.i(3);new c.AppPageRouteModule({distDir:"/outside"});}),',
    );
    await writeFile(own.chunk, changed);

    await expect(
      proveNodeManifestTurbopackConsumers({
        distDir: own.distDir,
        rootDir: directory,
        sources: sources.map((entry) =>
          entry.id === own.chunk ? { ...entry, source: source(changed) } : entry,
        ),
        entries: [{ file: own.entry, page: '/native/page', pathname: '/native' }],
        producer: {
          id: own.constructor.file,
          file: own.constructor.file,
          sha256: own.constructor.sha256,
          kind: 'app-page-class',
        },
      }),
    ).rejects.toThrow('Unproved Next.js');
  });
});
