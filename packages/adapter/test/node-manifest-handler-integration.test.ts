import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { certifyNodeManifestCompilerRoot } from '../src/node-manifest-compiler-root.ts';
import { NODE_MANIFEST_HANDLER_PROFILES } from '../src/node-manifest-handler-catalog.ts';
import * as handlerContext from '../src/node-manifest-handler-context.ts';
import * as handlerMetadata from '../src/node-manifest-handler-metadata.ts';
import { prepareNodeManifestHandlerCompilerRoot } from '../src/node-manifest-handler-root.ts';
import * as handlerSources from '../src/node-manifest-handler-sources.ts';
import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import { withNodeManifestRegistrationPassAsync } from '../src/node-manifest-registration-pass.ts';
import { createNodeManifestRegistrationViews } from '../src/node-manifest-registration-views.ts';
import { prepareNodeManifestRuntimeGraphs } from '../src/node-manifest-runtime-cohort.ts';
import {
  assertNodeManifestPendingSdkContext,
  prepareNodeManifestSdkTerminalScope,
} from '../src/node-manifest-sdk-terminal.ts';
import { pagesConjunctionChainFixture } from './fixtures/node-manifest-pages-conjunction-chain.ts';

async function rootBinding(directory: string, distDir: string) {
  const file = path.join(distDir, 'required-server-files.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      appDir: directory,
      relativeAppDir: '',
      config: {
        distDir: '.next',
        turbopack: { root: directory },
        experimental: { isExperimentalCompile: false },
      },
      files: ['.next/BUILD_ID', '.next/required-server-files.json'],
      ignore: [],
    }),
  );
  const input = { projectDir: directory, distDir };
  const proof = await certifyNodeManifestCompilerRoot(input);
  assert(proof !== undefined, 'Expected the authored persisted root basis');
  return { proof, input };
}
async function pending(directory: string) {
  const own = await pagesConjunctionChainFixture(directory);
  const compilerRootBinding = await rootBinding(directory, own.input.distDir);
  const input = { ...own.input, compilerRootBinding };
  const { scope } = await prepareNodeManifestSdkTerminalScope(input, own.graph);
  const consumer = { ...(await own.consumerInput()), sdkTerminalScope: scope, compilerRootBinding };
  return { own, input, consumer, compilerRootBinding, scope };
}

describe('private Pages handler source integration', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'handler-source-integration-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('freezes the qualified static catalog and does not read missing root metadata for an unrelated native graph', async () => {
    expect(NODE_MANIFEST_HANDLER_PROFILES.map((profile) => profile.name)).toStrictEqual([
      'next-16.4.3-public-pages-handler',
    ]);
    expect(
      NODE_MANIFEST_HANDLER_PROFILES.every((profile) => {
        return (
          Object.isFrozen(profile) &&
          Object.isFrozen(profile.reference.rows) &&
          Object.isFrozen(profile.literalSlots)
        );
      }),
    ).toBe(true);
    expect(Object.isFrozen(NODE_MANIFEST_HANDLER_PROFILES)).toBe(true);
    await expect(
      prepareNodeManifestHandlerCompilerRoot(
        { projectDir: '/missing/project', distDir: '/missing/output' },
        [],
      ),
    ).resolves.toBeUndefined();
  });

  it('still closes the real inner Pages group, outer SDK and bound batch with no handler role grant', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    // This observer calls the genuine implementation; it supplies no proof or success result.
    const observed = vi.spyOn(handlerContext, 'qualifyNodeManifestHandlerContext');
    const proof = await proveNodeManifests(own.input, own.graph);
    const contexts = observed.mock.results.map((result) =>
      result.type === 'return' ? result.value : undefined,
    );

    expect(contexts.some((context) => context !== undefined)).toBe(true);
    expect(proof.routeRewriteApprovals).toHaveLength(1);
    expect(proof.files.map((file) => file.file)).toContain(own.wrapperTable);
  });

  it('does not allow a genuine context to outlive its revoked registration pass', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const observed = vi.spyOn(handlerContext, 'qualifyNodeManifestHandlerContext');
    await proveNodeManifests(own.input, own.graph);
    const context = observed.mock.results
      .map((result) => (result.type === 'return' ? result.value : undefined))
      .find((value) => value !== undefined);
    assert(context !== undefined, 'Expected the genuine private context');

    await expect(handlerContext.assertCurrentNodeManifestHandlerContext(context)).rejects.toThrow(
      'inactive or uncertified scope',
    );
    await expect(
      handlerContext.assertCurrentNodeManifestHandlerContext({ ...context }),
    ).rejects.toThrow('uncertified or copied context');
  });

  it('does not accept an equal copied owner record or a substituted helper owner', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const observed = vi.spyOn(handlerContext, 'qualifyNodeManifestHandlerContext');
    await proveNodeManifests(own.input, own.graph);
    const original = observed.mock.calls.find(
      ([value]) => value.owned.input.producer.kind === 'pages-class',
    )?.[0];
    assert(original !== undefined, 'Expected the genuine private owner binding');

    await expect(
      handlerContext.qualifyNodeManifestHandlerContext({
        ...original,
        owned: { ...original.owned },
      }),
    ).rejects.toThrow('foreign private handler owner binding');
    await expect(
      handlerContext.qualifyNodeManifestHandlerContext({
        ...original,
        owned: { ...original.owned, owner: { ...original.owned.owner } },
      }),
    ).rejects.toThrow('foreign private handler owner binding');
  });

  it.each([
    {
      name: 'cleared',
      mutate: (proof: Parameters<typeof handlerMetadata.commitNodeManifestHandlerMetadata>[0]) => {
        Reflect.set(proof, 'helperMetadataFiles', undefined);
      },
    },
    {
      name: 'substituted equal empty',
      mutate: (proof: Parameters<typeof handlerMetadata.commitNodeManifestHandlerMetadata>[0]) => {
        Reflect.set(proof, 'helperMetadataFiles', Object.freeze([]));
      },
    },
    {
      name: 'forged nonempty',
      mutate: (proof: Parameters<typeof handlerMetadata.commitNodeManifestHandlerMetadata>[0]) => {
        Reflect.set(
          proof,
          'helperMetadataFiles',
          Object.freeze([{ file: '/authored/forged.json', sha256: 'forged' }]),
        );
      },
    },
  ])(
    'refuses a $name metadata lane on the genuine zero-group proof after outer awaits',
    async ({ mutate }) => {
      const own = await pagesConjunctionChainFixture(directory);
      const original = handlerMetadata.stageNodeManifestHandlerMetadata;
      vi.spyOn(handlerMetadata, 'stageNodeManifestHandlerMetadata').mockImplementationOnce(
        (input) => {
          const proof = original(input);
          mutate(proof);
          return proof;
        },
      );

      await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
        'changed original proof or metadata field',
      );
    },
  );

  it('rejects nonprivate empty-ledger minting and a copied original proof', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const observed = vi.spyOn(handlerMetadata, 'stageNodeManifestHandlerMetadata');
    await proveNodeManifests(own.input, own.graph);
    const original = observed.mock.calls[0]?.[0];
    assert(original !== undefined, 'Expected the genuine private ledger mint');

    expect(() => {
      return handlerMetadata.stageNodeManifestHandlerMetadata({
        ...original,
        consumerOwner: { ...original.consumerOwner },
      });
    }).toThrow('uncertified private consumer owner');
    await expect(
      handlerMetadata.commitNodeManifestHandlerMetadata({ ...original.proof }, []),
    ).rejects.toThrow('copied, consumed or unstaged proof');
    await expect(
      handlerMetadata.commitNodeManifestHandlerMetadata(original.proof, []),
    ).rejects.toThrow('copied, consumed or unstaged proof');
  });

  it('checks the original metadata control wrapper before reading a newly installed getter', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const original = handlerMetadata.stageNodeManifestHandlerMetadata;
    let calls = 0;
    vi.spyOn(handlerMetadata, 'stageNodeManifestHandlerMetadata').mockImplementationOnce(
      (input) => {
        const proof = original(input);
        const owned = input.owned;
        Object.defineProperty(input, 'owned', {
          get() {
            calls += 1;
            return owned;
          },
        });
        return proof;
      },
    );

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'changed original proof or metadata field',
    );
    expect(calls).toBe(0);
  });

  it('refuses an unqualified compiled getHandler even when its complete actual route chain is present', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const handler = path.join(own.root, 'dist/server/route-modules/pages/pages-handler.js');
    const original = await readFile(own.chunk, 'utf8');
    const port = `.x(${jsLiteral(handler)},()=>require(${jsLiteral(handler)}))`;
    assert(original.includes(port), 'Expected the unchanged authored handler import');
    const changed = original
      .replaceAll(port, '.i(201)')
      .replace(
        'module.exports=[',
        'module.exports=[201,ctx=>{ctx.s(["getHandler",()=>getHandler]);function getHandler(){return "unqualified";}},',
      );
    const edges = (own.imports.get(own.chunk) ?? []).filter((edge) => edge.target !== handler);
    await own.put(own.chunk, changed);
    own.imports.set(own.chunk, edges);
    own.link();

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'refusing native publication',
    );
  });

  it('refuses a forged private owner despite genuine pass, views, cohort, source array and pending SDK scope', async () => {
    const own = await pending(directory);
    const prepared = prepareNodeManifestRuntimeGraphs({
      ...own.consumer,
      inventory: own.consumer.runtimeCallers,
      profiles: own.consumer.runtimeProfiles,
    });
    const registrations = createNodeManifestRegistrationViews(
      prepared.allGraphs,
      own.consumer.sources,
    );
    const factories = new Map(
      prepared.allGraphs.flatMap((graph) =>
        graph.factories.map((factory) => [factory.id, factory] as const),
      ),
    );

    await expect(
      withNodeManifestRegistrationPassAsync(registrations, async (pass) => {
        return await handlerContext.qualifyNodeManifestHandlerContext({
          consumerOwner: { identity: Symbol('forged consumer') },
          owned: {
            owner: { identity: Symbol('helper') },
            input: own.consumer,
            graphs: prepared.allGraphs,
            registrations,
            factories,
            strictFactories: new Map(),
            cohort: prepared.cohort,
          },
          pass,
        });
      }),
    ).rejects.toThrow('uncertified private consumer owner');
  });

  it('binds an unchanged original source inventory to its exact pending SDK scope', async () => {
    const own = await pending(directory);

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, own.consumer);
    }).not.toThrow();

    const copied = { ...own.scope };

    expect(() => {
      assertNodeManifestPendingSdkContext(copied, { ...own.consumer, sdkTerminalScope: copied });
    }).toThrow('stale or uncertified SDK terminal scope');
  });

  it.each([
    {
      name: 'binding',
      change: (own: Awaited<ReturnType<typeof pending>>) => {
        own.input.compilerRootBinding = { ...own.compilerRootBinding };
        return Promise.resolve();
      },
    },
    {
      name: 'proof',
      change: async (own: Awaited<ReturnType<typeof pending>>) => {
        const proof = await certifyNodeManifestCompilerRoot(own.compilerRootBinding.input);
        assert(proof !== undefined);
        own.compilerRootBinding.proof = proof;
      },
    },
    {
      name: 'input',
      change: (own: Awaited<ReturnType<typeof pending>>) => {
        own.compilerRootBinding.input = { ...own.compilerRootBinding.input };
        return Promise.resolve();
      },
    },
  ])('refuses a same-JSON $name pointer replacement in the outer SDK input', async ({ change }) => {
    const own = await pending(directory);
    await change(own);

    expect(JSON.stringify(own.input.compilerRootBinding)).toBe(
      JSON.stringify(own.consumer.compilerRootBinding),
    );
    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, own.consumer);
    }).toThrow('stale or uncertified SDK terminal scope');
  });

  it('rechecks the exact source-array pointer after an asynchronous genuine source read', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const observed = vi.spyOn(handlerContext, 'qualifyNodeManifestHandlerContext');
    const original = handlerSources.checkedNodeManifestHandlerFile;
    vi.spyOn(handlerSources, 'checkedNodeManifestHandlerFile').mockImplementationOnce(
      async (file, sha256) => {
        const proof = await original(file, sha256);
        const input = observed.mock.calls.find(
          ([value]) => value.owned.input.producer.kind === 'pages-class',
        )?.[0];
        assert(input !== undefined, 'Expected the genuine private Pages consumer');
        Reflect.set(input.owned.input, 'sources', [...input.owned.input.sources]);
        return proof;
      },
    );

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'changed private context sources or graph',
    );
  });

  it('does not invoke a private wrapper getter installed during a genuine source await', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const observed = vi.spyOn(handlerContext, 'qualifyNodeManifestHandlerContext');
    const original = handlerSources.checkedNodeManifestHandlerFile;
    let calls = 0;
    vi.spyOn(handlerSources, 'checkedNodeManifestHandlerFile').mockImplementationOnce(
      async (file, sha256) => {
        const proof = await original(file, sha256);
        const input = observed.mock.calls.find(
          ([value]) => value.owned.input.producer.kind === 'pages-class',
        )?.[0];
        assert(input !== undefined, 'Expected the genuine private Pages consumer');
        const owned = input.owned;
        Object.defineProperty(input, 'owned', {
          get() {
            calls += 1;
            return owned;
          },
        });
        return proof;
      },
    );

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'changed private context sources or graph',
    );
    expect(calls).toBe(0);
  });

  it('does not canonicalize an undeclared handler property on an otherwise pinned source', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const code = await readFile(own.chunk, 'utf8');
    assert(code.includes('.getHandler'), 'Expected the fixed handler member use');
    const edges = [...(own.imports.get(own.chunk) ?? [])];
    await own.put(own.chunk, code.replaceAll('.getHandler', '.wrongDeclaredProperty'));
    own.imports.set(own.chunk, edges);
    own.link();

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'refusing native publication',
    );
  });

  it('refuses a copied equal source import array or source bytes which do not match the original digest', async () => {
    const own = await pending(directory);
    const first = own.consumer.sources[0];
    assert(first !== undefined);
    const sources = own.consumer.sources.map((source) =>
      source === first ? { ...source, imports: [...source.imports] } : source,
    );

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, { ...own.consumer, sources });
    }).toThrow('pending SDK original source binding');

    const changed = own.consumer.sources.map((source) =>
      source === first ? { ...source, source: { ...source.source, code: 'changed;' } } : source,
    );

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, { ...own.consumer, sources: changed });
    }).toThrow('pending SDK original source binding');
  });
});
