import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type Context, createContext, runInContext, runInNewContext } from 'node:vm';

import { rolldown } from 'rolldown';
import { beforeAll, describe, expect, it } from 'vitest';

import { nativeEdgeGraphPlugin } from '../src/native/graph.ts';
import { rekeyManifestsGraph } from '../src/patches/graph-manifests.ts';

const require = createRequire(import.meta.url);
const singletonFile = require.resolve('next/dist/server/app-render/manifests-singleton.js');
const nextRequire = createRequire(singletonFile);

type GraphName = 'node' | 'edge';
interface Singleton {
  setManifestsSingleton(input: {
    readonly page: string;
    readonly clientReferenceManifest: {
      readonly entryCSSFiles: { readonly main: readonly string[] };
    };
    readonly serverActionsManifest: {
      readonly encryptionKey: string;
      readonly node: Record<string, never>;
      readonly edge: Record<string, never>;
    };
  }): void;
  getClientReferenceManifest(): { readonly entryCSSFiles: { readonly main: readonly string[] } };
  getServerActionsManifest(): { readonly encryptionKey: string };
}

interface Graph {
  readonly api: Singleton;
  readonly storage: AsyncLocalStorage<{ readonly route: string; readonly page: string }>;
}

/** Evaluate two actual Next.js module copies in the same realm, with their own work stores. */
function loadGraph(source: string, context: Context): Graph {
  type Factory = (
    exports: Record<string, unknown>,
    require: (name: string) => unknown,
    module: { exports: Record<string, unknown> },
  ) => void;

  const storage = new AsyncLocalStorage<{ readonly route: string; readonly page: string }>();
  const unitStorage = new AsyncLocalStorage<unknown>();
  const load = (specifier: string): unknown => {
    const name = path.basename(specifier).replace(/\.js$/u, '');
    if (name === 'work-async-storage.external') return { workAsyncStorage: storage };
    if (name === 'work-unit-async-storage.external') return { workUnitAsyncStorage: unitStorage };
    return nextRequire(specifier) as unknown;
  };
  const module = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line sonarjs/code-eval -- This evaluates the installed Next.js module in a test-owned shared realm.
  const factory = runInContext(
    `(function(exports, require, module) {\n${source}\n})`,
    context,
  ) as Factory;
  factory(module.exports, load, module);
  return { api: module.exports as unknown as Singleton, storage };
}

function registeredGraphs(
  nodeSource: string,
  edgeSource: string,
  first: GraphName,
): Record<GraphName, Graph> {
  const context = createContext({
    process: { env: { NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs' } },
  });
  const graphs = { node: loadGraph(nodeSource, context), edge: loadGraph(edgeSource, context) };
  const order: readonly GraphName[] = first === 'node' ? ['node', 'edge'] : ['edge', 'node'];
  for (const name of order) {
    graphs[name].api.setManifestsSingleton({
      page: `/${name}/page`,
      clientReferenceManifest: { entryCSSFiles: { main: [`${name}.css`] } },
      serverActionsManifest: { encryptionKey: `${name}-key`, node: {}, edge: {} },
    });
  }
  return graphs;
}

function render(graph: Graph, name: GraphName) {
  return graph.storage.run({ route: `/${name}`, page: `/${name}/page` }, async () => {
    await Promise.resolve();
    return {
      css: graph.api.getClientReferenceManifest().entryCSSFiles.main,
      key: graph.api.getServerActionsManifest().encryptionKey,
    };
  });
}

describe('native mixed Node and Edge manifest graphs', () => {
  let source: string;
  let edge: string;

  beforeAll(async () => {
    source = await readFile(singletonFile, 'utf8');
    // Keep the module's dependencies external so each evaluated graph receives its own work
    // storage, while using the real current Next.js proxy and registration implementation.
    await using bundle = await rolldown({
      input: singletonFile,
      platform: 'node',
      external: (_specifier, importer) => importer !== undefined,
      plugins: [nativeEdgeGraphPlugin()],
    });
    const { output } = await bundle.generate({ format: 'cjs', codeSplitting: false });
    const chunk = output.find((item) => item.type === 'chunk');
    if (chunk?.type !== 'chunk') throw new Error('the Edge module was not generated');
    edge = chunk.code;
  });

  it('reproduces the actual Next.js proxy failure when both graphs share their key', async () => {
    const graphs = registeredGraphs(source, source, 'node');

    await expect(render(graphs.edge, 'edge')).rejects.toThrow('without a work store');
  });

  it.each(['node', 'edge'] as const)(
    'keeps both render stores and action manifests when %s registers first',
    async (first) => {
      const graphs = registeredGraphs(source, edge, first);

      await expect(
        Promise.all([render(graphs.node, 'node'), render(graphs.edge, 'edge')]),
      ).resolves.toStrictEqual([
        { css: ['node.css'], key: 'node-key' },
        { css: ['edge.css'], key: 'edge-key' },
      ]);
      await expect(readFile(singletonFile, 'utf8')).resolves.toBe(source);
    },
  );

  it('changes real key calls while preserving application strings quoting the expression', () => {
    const original = [
      'const example = "Symbol.for(\'next.server.manifests\')";',
      'const key = Symbol.for ( "next.server.manifests" );',
      'module.exports = { example, key: Symbol.keyFor(key) };',
    ].join('\n');
    const rewritten = rekeyManifestsGraph(original, 'fixture.js', 'fixture.edge.manifests');
    const module = { exports: {} };
    // eslint-disable-next-line sonarjs/code-eval -- This is test-owned source that exposes the resulting key and literal string.
    runInNewContext(rewritten, { module });

    expect({ ...module.exports }).toStrictEqual({
      example: "Symbol.for('next.server.manifests')",
      key: 'fixture.edge.manifests',
    });
  });
});
