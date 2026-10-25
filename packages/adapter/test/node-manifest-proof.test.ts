/* eslint-disable vitest/no-conditional-in-test -- Table conditions prepare adversarial inputs; every row makes the same unconditional proof/refusal assertions. */
/* eslint-disable no-template-curly-in-string -- Fixtures retain JavaScript template expressions without evaluating them. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appEntrySource } from '../src/app-entry.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import { assertClientReferenceManifest, proveNodeManifests } from '../src/node-manifest-proof.ts';
import { assertNodeProofFiles, proveNodeFunction } from '../src/node-proof.ts';

const PAGE = '/native/page';
const SUFFIX = '_client-reference-manifest.js';
const DATA =
  '{"clientModules":{"example":{"id":"1","chunks":["static/a.js",["static/b.js",1,2]],"async":false}},"ssrModuleMapping":{},"value":-1,"empty":null}';

function script(data = DATA, page = PAGE): string {
  const key = JSON.stringify(page);
  return `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[${key}]=${data};`;
}

function withDeploymentId(): string {
  return (
    script() +
    [
      'for (const key in globalThis.__RSC_MANIFEST["/native/page"].clientModules) {',
      ' const val = { ...globalThis.__RSC_MANIFEST["/native/page"].clientModules[key] }',
      ' globalThis.__RSC_MANIFEST["/native/page"].clientModules[key] = val',
      ' val.chunks = val.chunks.map((c) =>',
      " typeof c === 'string' ? `${c}?dpl=${process.env.NEXT_DEPLOYMENT_ID}`",
      ' : [`${c[0]}?dpl=${process.env.NEXT_DEPLOYMENT_ID}`, c[1], c[2]])',
      '}',
    ].join('\n')
  );
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const SOURCE_CHAIN = [
  'dist/server/load-manifest.external.js',
  'dist/compiled/next-server/app-page.runtime.prod.js',
  'dist/server/route-modules/app-page/module.compiled.js',
  'dist/build/templates/app-page-runtime.js',
] as const;

function routeSource(producer: string): string {
  return [
    `import {createAppPageEntrypoint} from ${JSON.stringify(producer)};`,
    'const entrypoint=createAppPageEntrypoint({tree,page:"/native/page",pathname:"/native",require:__next_app_require__,loadChunk:__next_app_load_chunk__,interopDefault});',
    'export const __next_app__=entrypoint.__next_app__;',
    'export const routeModule=entrypoint.routeModule;',
    'export const handler=entrypoint.handler;',
  ].join('\n');
}

async function fixture(directory: string) {
  // Read published source without importing or evaluating a Next.js module.
  const evaluatorFile = fileURLToPath(
    import.meta.resolve('next/dist/server/load-manifest.external.js'),
  );
  const originalRoot = path.resolve(path.dirname(evaluatorFile), '../..');
  const root = path.join(directory, 'node_modules/next');
  const chain = SOURCE_CHAIN.map((relative) => path.join(root, relative));
  const sources = new Map<string, { file: string; sha256: string }>();
  for (const relative of SOURCE_CHAIN) {
    const bytes = await readFile(path.join(originalRoot, relative));
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    sources.set(file, { file, sha256: digest(bytes) });
  }
  const evaluator = chain[0]!;
  const caller = chain[1]!;
  const producer = chain[3]!;
  const distDir = path.join(directory, '.next');
  const route = path.join(distDir, 'server/app/native/page.js');
  const manifest = path.join(distDir, `server/app/native/page${SUFFIX}`);
  const analysisEntry = path.join(directory, 'entry.cjs');
  const entries = [{ id: '/native', filePath: route }];
  const rootCode = [
    appEntrySource(entries, { external: true, runtimeDistDir: distDir, nodeRequestMeta: true }),
  ].join('\n');
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"name":"next","version":"16.4.3"}');
  await writeFile(manifest, withDeploymentId());
  await writeFile(route, routeSource(producer));
  await writeFile(analysisEntry, rootCode);
  sources.set(route, { file: route, sha256: digest(routeSource(producer)) });
  sources.set(analysisEntry, { file: analysisEntry, sha256: digest(rootCode) });
  const complete = [...chain, route, analysisEntry];
  const importers = new Map<string, string[]>();
  const imports = new Map<string, { specifier: string; target: string }[]>();
  for (const [index, child] of complete.entries()) {
    const parent = complete[index + 1];
    importers.set(child, parent === undefined ? [] : [parent]);
    if (parent !== undefined) imports.set(parent, [{ specifier: child, target: child }]);
  }
  return {
    evaluator,
    caller,
    producer,
    route,
    analysisEntry,
    root,
    manifest,
    distDir,
    source: await readFile(evaluator, 'utf8'),
    input: {
      distDir,
      entries,
      analysisEntry,
      runtimeManifest: JSON.stringify({
        entrypoints: [{ id: '/native', kind: 'app-page', pathname: '/native' }],
      }),
      manifests: [
        {
          name: '.next/server/app/native/page_client-reference-manifest.json',
          contents: '{}',
          routeFile: manifest,
        },
      ],
      entryTraces: [{ id: '/native', assets: { manifest } }],
    },
    graph: {
      sources,
      importers,
      imports,
      roots: new Set([analysisEntry]),
      retained: new Set(complete),
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const REFUSALS = [
  'version',
  'evaluator',
  'caller',
  'unknown-caller',
  'unowned',
  'outside',
  'duplicate',
  'missing',
] as const;
type Refusal = (typeof REFUSALS)[number];

async function changeFixture(current: Fixture, scenario: Refusal): Promise<void> {
  switch (scenario) {
    case 'version': {
      await writeFile(
        path.join(current.root, 'package.json'),
        '{"name":"next","version":"16.4.4"}',
      );
      break;
    }
    case 'evaluator': {
      const source = `${current.source}\nexports.extra=()=>require("vm").runInThisContext("unknown");`;
      await writeFile(current.evaluator, source);
      current.graph.sources.set(current.evaluator, {
        file: current.evaluator,
        sha256: digest(source),
      });
      break;
    }
    case 'caller': {
      current.graph.sources.set(current.caller, {
        file: current.caller,
        sha256: digest('changed caller'),
      });
      break;
    }
    case 'unknown-caller': {
      const caller = path.join(current.root, 'user-loader.js');
      current.graph.sources.set(caller, { file: caller, sha256: digest('user loader') });
      current.graph.importers.set(current.evaluator, [caller]);
      break;
    }
    case 'unowned': {
      current.input.entryTraces = [];
      break;
    }
    case 'outside': {
      const manifest = path.join(current.distDir, `outside${SUFFIX}`);
      await writeFile(manifest, script());
      current.input.entryTraces = [{ id: '/native', assets: { manifest } }];
      current.input.manifests = [{ name: 'outside.json', contents: '{}', routeFile: manifest }];
      break;
    }
    case 'duplicate': {
      current.input.manifests.push(...current.input.manifests);
      break;
    }
    case 'missing': {
      current.input.manifests = [];
      break;
    }
  }
}

describe('sealed Next.js client-manifest data', () => {
  it.each([
    ['plain data', script()],
    ['deployment suffix', withDeploymentId()],
    ['empty data', script('{}')],
  ])('recognizes the generated %s template without evaluating it', (_title, source) => {
    expect(() => {
      assertClientReferenceManifest(source, PAGE);
    }).not.toThrow(Error);
  });

  it.each([
    ['getter', script('{get secret(){return 1}}')],
    ['call', script('{"x":require("unknown")}')],
    ['spread', script('{...unknown}')],
    ['computed key', script('{["x"]:1}')],
    ['function', script('{"x":()=>1}')],
    ['prototype', script('{"__proto__":{}}')],
    ['array hole', script('{"x":[,]}')],
    ['nonfinite number', script('{"x":1e999}')],
    ['extra operation', `${script()}globalThis.extra=process.mainModule;`],
    ['another route', script(DATA, '/unowned/page')],
    [
      'another environment input',
      withDeploymentId().replaceAll('NEXT_DEPLOYMENT_ID', 'UNKNOWN_INPUT'),
    ],
    ['changed suffix operation', withDeploymentId().replace('val.chunks.map', 'val.chunks.filter')],
  ])('refuses %s in a generated-manifest position', (_title, source) => {
    expect(() => {
      assertClientReferenceManifest(source, PAGE);
    }).toThrow('Unproved Next.js client manifest');
  });
});

describe('original Node manifest operation proof', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-node-manifest-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('certifies only the reviewed operation and binds its unchanged physical data', async () => {
    const current = await fixture(directory);
    const proof = await proveNodeManifests(current.input, current.graph);
    const inspection = proof.inspectionCode(current.evaluator, current.source);
    const files = await Promise.all(
      proof.files.map(async (source) => {
        return {
          name: source.file,
          bytes: await readFile(source.file),
        };
      }),
    );
    const physical = { files, nameOf: (file: string) => file };
    const unchanged = await readFile(current.evaluator, 'utf8');
    const unknown = "const vm=require('vm');vm.runInNewContext(content,contextObject);";
    const other = proof.inspectionCode('/user/loader.js', unknown);

    expect([
      dynamicNodeClosureRefusal(current.evaluator, current.source),
      dynamicNodeClosureRefusal(current.evaluator, inspection),
    ]).toStrictEqual(['an unproved Node module loader or code compiler', undefined]);
    expect([unchanged, other]).toStrictEqual([current.source, unknown]);
    expect(proof.files.map((source) => path.basename(source.file))).toStrictEqual([
      'app-page.runtime.prod.js',
      'module.compiled.js',
      'app-page-runtime.js',
      'page.js',
      'load-manifest.external.js',
      'package.json',
      `page${SUFFIX}`,
    ]);
    expect(() => {
      assertNodeProofFiles({ files: proof.files, native: [] }, physical, new Map());
    }).not.toThrow(Error);
  });

  it.each(REFUSALS)('refuses an unproved %s boundary', async (scenario) => {
    const current = await fixture(directory);
    await changeFixture(current, scenario);
    const operation = proveNodeManifests(current.input, current.graph);

    await expect(operation).rejects.toThrow('Unproved Next.js client manifest');
  });

  it('rejects a user evaluator import through the real original-graph collector', async () => {
    const current = await fixture(directory);
    const entry = path.join(current.distDir, 'server/entry.cjs');
    const binary = path.join(current.distDir, 'server/addon.node');
    const helper = path.join(current.root, 'dist/shared/lib/deep-freeze.js');
    await mkdir(path.dirname(helper), { recursive: true });
    await writeFile(helper, 'exports.deepFreeze=Object.freeze;');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(
      entry,
      [
        "exports.native=()=>require('./addon.node');",
        `exports.manifest=require(${JSON.stringify(current.evaluator)});`,
      ].join('\n'),
    );
    const operation = proveNodeFunction({
      kind: 'app',
      projectDir: directory,
      outDir: path.join(directory, '.upwind'),
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [{ id: '/native', assets: { entry, binary, manifest: current.manifest } }],
      manifests: current.input.manifests,
      patch: {
        projectDir: directory,
        distDir: current.distDir,
        chunks: [],
        instrumentation: undefined,
        wasm: [],
      },
    });

    await expect(operation).rejects.toThrow('Unproved Next.js client manifest');
  });

  it('leaves graphs without the evaluator unchanged without requiring App output', async () => {
    const current = await fixture(directory);
    await rm(path.join(current.distDir, 'server/app'), { recursive: true });
    const input = { distDir: current.distDir, manifests: [], entryTraces: [] };
    const proof = await proveNodeManifests(input, {
      sources: new Map(),
      importers: new Map(),
      retained: new Set(),
    });
    const unknown = 'vm.runInNewContext(content, contextObject)';

    expect(proof.files).toStrictEqual([]);
    expect(proof.normalization).toBeUndefined();
    expect(proof.inspectionCode('/user.js', unknown)).toBe(unknown);
  });

  it('does not approve a route class merely because its direct caller is reviewed', async () => {
    const current = await fixture(directory);
    current.graph.importers.set(current.caller, []);

    await expect(proveNodeManifests(current.input, current.graph)).rejects.toThrow(
      'unclosed consumer chain',
    );
  });

  it('returns an immutable copy of all generated-entry normalization inputs', async () => {
    const current = await fixture(directory);
    const proof = await proveNodeManifests(current.input, current.graph);
    const sealed = proof.normalization;
    current.input.entries[0]!.id = '/changed';

    expect(sealed).toStrictEqual({
      entries: [{ id: '/native', filePath: current.route, canonicalFilePath: current.route }],
      distDir: current.distDir,
      canonicalDistDir: current.distDir,
    });
    expect([
      Object.isFrozen(sealed),
      Object.isFrozen(sealed?.entries),
      Object.isFrozen(sealed?.entries[0]),
    ]).toStrictEqual([true, true, true]);
  });

  it.each([
    'missing-metadata',
    'wrong-pathname',
    'edge-route',
    'renamed-page',
    'changed-root',
    'non-entry-root',
    'unresolved-edge',
    'export-escape',
  ] as const)('refuses the %s consumer-chain boundary', async (scenario) => {
    const current = await fixture(directory);
    let replacement: { file: string; code: string } | undefined;
    switch (scenario) {
      case 'missing-metadata': {
        current.input.runtimeManifest = '{}';
        break;
      }
      case 'wrong-pathname': {
        current.input.runtimeManifest = JSON.stringify({
          entrypoints: [{ id: '/native', kind: 'app-page', pathname: '/other' }],
        });
        break;
      }
      case 'edge-route': {
        current.input.runtimeManifest = JSON.stringify({
          entrypoints: [{ id: '/native', kind: 'app-page', pathname: '/native', runtime: 'edge' }],
        });
        break;
      }
      case 'non-entry-root': {
        current.graph.roots.clear();
        break;
      }
      case 'unresolved-edge': {
        current.graph.imports.delete(current.route);
        break;
      }
      case 'changed-root': {
        replacement = { file: current.analysisEntry, code: 'module.exports={};' };
        break;
      }
      case 'renamed-page': {
        replacement = {
          file: current.route,
          code: routeSource(current.producer).replace('/native/page', '/other/page'),
        };
        break;
      }
      default: {
        replacement = {
          file: current.route,
          code: `${routeSource(current.producer)}\nexport const escaped=routeModule;`,
        };
      }
    }
    if (replacement !== undefined) {
      await writeFile(replacement.file, replacement.code);
      current.graph.sources.set(replacement.file, {
        file: replacement.file,
        sha256: digest(replacement.code),
      });
    }

    await expect(proveNodeManifests(current.input, current.graph)).rejects.toThrow(
      'Unproved Next.js',
    );
  });

  it('refuses an unknown re-export wrapper between the certified route and SDK root', async () => {
    const current = await fixture(directory);
    const wrapper = path.join(directory, 'wrapper.js');
    const code = `export * from ${JSON.stringify(current.route)};`;
    await writeFile(wrapper, code);
    current.graph.sources.set(wrapper, { file: wrapper, sha256: digest(code) });
    current.graph.retained.add(wrapper);
    current.graph.importers.set(current.route, [wrapper]);
    current.graph.importers.set(wrapper, [current.analysisEntry]);
    current.graph.imports.set(wrapper, [{ specifier: current.route, target: current.route }]);
    current.graph.imports.set(current.analysisEntry, [{ specifier: wrapper, target: wrapper }]);

    await expect(proveNodeManifests(current.input, current.graph)).rejects.toThrow(
      'unknown consumer or export escape',
    );
  });

  it('follows the reviewed load-components wrapper to its arbitrary-path consumer', async () => {
    const current = await fixture(directory);
    const bytes = await readFile(
      fileURLToPath(import.meta.resolve('next/dist/server/load-components.js')),
    );
    const wrapper = path.join(current.root, 'dist/server/load-components.js');
    await writeFile(wrapper, bytes);
    current.graph.sources.set(wrapper, { file: wrapper, sha256: digest(bytes) });
    current.graph.retained.add(wrapper);
    current.graph.importers.set(current.evaluator, [current.caller, wrapper]);
    current.graph.importers.set(wrapper, [current.route]);
    current.graph.imports.set(wrapper, [
      { specifier: './load-manifest.external', target: current.evaluator },
    ]);
    const imports = current.graph.imports.get(current.route)!;
    imports.push({ specifier: wrapper, target: wrapper });
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- This is an imported JS identifier in authored source, not a template substitution.
    const code = `${routeSource(current.producer)}\nimport {evalManifestWithRetries} from ${JSON.stringify(wrapper)};\nexport const evaluate=evalManifestWithRetries;`;
    await writeFile(current.route, code);
    current.graph.sources.set(current.route, { file: current.route, sha256: digest(code) });

    await expect(proveNodeManifests(current.input, current.graph)).rejects.toThrow(
      'Unproved Next.js',
    );
  });

  it('needs no exception or normalization when only data-loading evaluator code remains', async () => {
    const current = await fixture(directory);
    const graph = {
      ...current.graph,
      rendered: new Map([[current.evaluator, 'exports.loadManifest=JSON.parse;']]),
    };
    const proof = await proveNodeManifests(current.input, graph);

    expect(proof.files).toStrictEqual([]);
    expect(proof.normalization).toBeUndefined();
    expect(proof.inspectionCode(current.evaluator, 'original()')).toBe('original()');
  });

  it('requires the certified route manifest even when both supplied inventories omit it', async () => {
    const current = await fixture(directory);
    current.input.entryTraces = [];
    current.input.manifests = [];

    await expect(proveNodeManifests(current.input, current.graph)).rejects.toThrow(
      'missing sealed route manifest',
    );
  });

  it('does not trust stale graph digests after a physical consumer changes', async () => {
    const current = await fixture(directory);
    await writeFile(current.caller, 'exports.AppPageRouteModule=class {};');

    await expect(proveNodeManifests(current.input, current.graph)).rejects.toThrow(
      'consumer source changed',
    );
  });

  it('rejects original-data changes before packaging and never masks a second VM operation', async () => {
    const current = await fixture(directory);
    const proof = await proveNodeManifests(current.input, current.graph);
    await writeFile(current.manifest, script('{"changed":true}'));
    const files = await Promise.all(
      proof.files.map(async (source) => {
        return {
          name: source.file,
          bytes: await readFile(source.file),
        };
      }),
    );
    const physical = { files, nameOf: (file: string) => file };
    const second = `${current.source}\n_vm.runInNewContext(other,contextObject);`;
    const unchangedUnknown = `${current.source}\nrequire("vm").runInThisContext(other);`;
    const inspection = proof.inspectionCode(current.evaluator, unchangedUnknown);

    expect(() => {
      assertNodeProofFiles({ files: proof.files, native: [] }, physical, new Map());
    }).toThrow('absent or changed');
    expect(() => proof.inspectionCode(current.evaluator, second)).toThrow(
      'extra retained VM operation',
    );
    expect(dynamicNodeClosureRefusal(current.evaluator, inspection)).toBe(
      'an unproved Node module loader or code compiler',
    );
  });
});
