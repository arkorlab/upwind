/* eslint-disable no-template-curly-in-string -- Fixtures retain JavaScript template expressions without evaluating them. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

async function fixture(directory: string) {
  // Read the installed published source without importing or evaluating any Next.js module.
  const published = fileURLToPath(
    import.meta.resolve('next/dist/server/load-manifest.external.js'),
  );
  const originalRoot = path.resolve(path.dirname(published), '../..');
  const originalCaller = path.join(originalRoot, 'dist/server/route-modules/route-module.js');
  const evaluatorBytes = await readFile(published);
  const callerBytes = await readFile(originalCaller);
  const root = path.join(directory, 'node_modules/next');
  const evaluator = path.join(root, 'dist/server/load-manifest.external.js');
  const caller = path.join(root, 'dist/server/route-modules/route-module.js');
  const distDir = path.join(directory, '.next');
  const manifest = path.join(distDir, `server/app/native/page${SUFFIX}`);
  await mkdir(path.dirname(evaluator), { recursive: true });
  await mkdir(path.dirname(caller), { recursive: true });
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(evaluator, evaluatorBytes);
  await writeFile(caller, callerBytes);
  await writeFile(path.join(root, 'package.json'), '{"name":"next","version":"16.4.3"}');
  await writeFile(manifest, withDeploymentId());
  return {
    evaluator,
    caller,
    root,
    manifest,
    distDir,
    source: evaluatorBytes.toString('utf8'),
    input: {
      distDir,
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
      sources: new Map([
        [caller, { file: caller, sha256: digest(callerBytes) }],
        [evaluator, { file: evaluator, sha256: digest(evaluatorBytes) }],
      ]),
      importers: new Map([[evaluator, [caller]]]),
      retained: new Set([caller, evaluator]),
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
    expect(() => assertClientReferenceManifest(source, PAGE)).not.toThrow(Error);
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
    expect(() => assertClientReferenceManifest(source, PAGE)).toThrow(
      'Unproved Next.js client manifest',
    );
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
      proof.files.map(async (source) => ({
        name: source.file,
        bytes: await readFile(source.file),
      })),
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
      'package.json',
      `page${SUFFIX}`,
    ]);
    expect(() =>
      assertNodeProofFiles({ files: proof.files, native: [] }, physical, new Map()),
    ).not.toThrow(Error);
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

    await expect(operation).rejects.toThrow(
      'Unproved Next.js client manifest unknown or changed caller',
    );
  });

  it('keeps Pages-only ownership without requiring an App directory', async () => {
    const current = await fixture(directory);
    await rm(path.join(current.distDir, 'server/app'), { recursive: true });
    const input = { distDir: current.distDir, manifests: [], entryTraces: [] };
    const proof = await proveNodeManifests(input, current.graph);
    const inspection = proof.inspectionCode(current.evaluator, current.source);

    expect(proof.files.map((source) => path.basename(source.file))).toStrictEqual(['package.json']);
    expect(dynamicNodeClosureRefusal(current.evaluator, inspection)).toBeUndefined();
  });

  it('rejects original-data changes before packaging and never masks a second VM operation', async () => {
    const current = await fixture(directory);
    const proof = await proveNodeManifests(current.input, current.graph);
    await writeFile(current.manifest, script('{"changed":true}'));
    const files = await Promise.all(
      proof.files.map(async (source) => ({
        name: source.file,
        bytes: await readFile(source.file),
      })),
    );
    const physical = { files, nameOf: (file: string) => file };
    const second = `${current.source}\n_vm.runInNewContext(other,contextObject);`;
    const unchangedUnknown = `${current.source}\nrequire("vm").runInThisContext(other);`;
    const inspection = proof.inspectionCode(current.evaluator, unchangedUnknown);

    expect(() =>
      assertNodeProofFiles({ files: proof.files, native: [] }, physical, new Map()),
    ).toThrow('absent or changed');
    expect(() => proof.inspectionCode(current.evaluator, second)).toThrow(
      'extra retained VM operation',
    );
    expect(dynamicNodeClosureRefusal(current.evaluator, inspection)).toBe(
      'an unproved Node module loader or code compiler',
    );
  });
});
