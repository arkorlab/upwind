import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assert, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { NodeArtifactFiles } from '../src/node-artifact-files.ts';
import {
  certifyNodeNextRewrites,
  nodeNextRewriteMetadata,
  nodeProjectInstrumentationSource,
  rewriteCertifiedNodeNextFile,
} from '../src/node-next-rewrite-proof.ts';
import { proveNodeFunction } from '../src/node-proof.ts';
import { nodeNextRewriteFixture, rewriteDigest } from './fixtures/node-next-rewrites.ts';

describe('source-bound Node cache and instrumentation policy', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-next-rewrites-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('authorizes the exact route runtime only after its complete pinned SDK-root proof', async () => {
    const own = await nodeNextRewriteFixture(directory);

    expect(own.manifests.approvedRouteSources?.some((source) => source.file === own.runtime)).toBe(
      true,
    );

    const artifact = new NodeArtifactFiles(own.input, own.physical, [], own.proof);
    artifact.rewriteNextFiles();
    await artifact.assertNextRewrites();
    const runtime = artifact.files.get(own.physical.nameOf(own.runtime));
    assert.isDefined(runtime);
    const code = Buffer.from(runtime.bytes).toString('utf8');

    expect(code).toContain('cacheHandler is unsupported in native Node Functions');
    expect(code).toContain('cacheHandlers is unsupported in native Node Functions');
    expect(
      Buffer.from(
        own.physical.files.find((file) => file.name === runtime.name)?.bytes ?? [],
      ).toString('utf8'),
    ).toBe(own.runtimeCode);
    expect(own.manifests.approvedCompilerSources).toStrictEqual([]);
    expect(
      nodeNextRewriteMetadata(own.proof)
        .map((source) => source.file)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(
      [own.config, own.runtime, own.loader].toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it.each(['class', 'normalization'] as const)(
    'refuses a missing completed %s proof',
    async (missing) => {
      const own = await nodeNextRewriteFixture(directory);
      const manifest =
        missing === 'class'
          ? { normalization: own.manifests.normalization, routeRewriteApprovals: [] }
          : { routeRewriteApprovals: own.manifests.routeRewriteApprovals };

      await expect(
        certifyNodeNextRewrites(own.input, own.graph, own.patches, manifest),
      ).rejects.toThrow(/caller proof|normalization|stale completed/u);
    },
  );

  it('rejects a cloned certificate even with the same enumerable brand', async () => {
    const own = await nodeNextRewriteFixture(directory);

    expect(() => {
      return rewriteCertifiedNodeNextFile({ ...own.proof }, own.input, {
        file: own.runtime,
        name: own.physical.nameOf(own.runtime),
        code: own.runtimeCode,
      });
    }).toThrow('certificate');
  });

  it('does not reuse completed route authority on a same-content replacement graph', async () => {
    const own = await nodeNextRewriteFixture(directory);

    await expect(
      certifyNodeNextRewrites(own.input, { ...own.graph }, own.patches, own.manifests),
    ).rejects.toThrow('stale completed route graph');
  });

  it('invalidates completed route authority when actual importers change', async () => {
    const own = await nodeNextRewriteFixture(directory);
    own.graph.importers.get(own.loader)?.push('/unknown/caller.js');

    await expect(own.certify()).rejects.toThrow('stale completed route graph');
  });

  it('does not transfer a completed route approval to another logical SDK inventory', async () => {
    const own = await nodeNextRewriteFixture(directory);
    Object.assign(own.input.entries[0] ?? {}, { id: '/other' });

    await expect(own.certify()).rejects.toThrow('stale completed route graph or context');
  });

  it('refuses a copied private route approval even though its source records match', async () => {
    const own = await nodeNextRewriteFixture(directory);
    const approval = own.manifests.routeRewriteApprovals?.[0];
    assert.isDefined(approval);
    const manifests = { ...own.manifests, routeRewriteApprovals: [{ ...approval }] };

    await expect(
      certifyNodeNextRewrites(own.input, own.graph, own.patches, manifests),
    ).rejects.toThrow('stale completed route graph');
  });

  it('rejects changed physical source bytes before applying a certified rewrite', async () => {
    const own = await nodeNextRewriteFixture(directory);
    const artifact = new NodeArtifactFiles(own.input, own.physical, [], own.proof);
    const original = own.physical.files.find(
      (file) => file.name === own.physical.nameOf(own.runtime),
    );
    assert.isDefined(original);
    original.bytes[0] = 0;

    expect(() => {
      artifact.rewriteNextFiles();
    }).toThrow('matching certificate');
  });

  it.each(['archive', 'config'] as const)(
    'rejects changed %s bytes before publication',
    async (change) => {
      const own = await nodeNextRewriteFixture(directory);
      const artifact = new NodeArtifactFiles(own.input, own.physical, [], own.proof);
      artifact.rewriteNextFiles();
      const file = change === 'archive' ? own.runtime : own.config;
      artifact.files.set(own.physical.nameOf(file), {
        name: own.physical.nameOf(file),
        bytes: new Uint8Array([0]),
      });

      await expect(artifact.assertNextRewrites()).rejects.toThrow(/policy bytes|configuration/u);
    },
  );

  it('gives no rewrite authority to an additional physical NFT-only matching source', async () => {
    const own = await nodeNextRewriteFixture(directory);
    const file = path.join(
      directory,
      'node_modules/next/dist/compiled/next-server/pages-api.runtime.prod.js',
    );
    const bytes = new Uint8Array(
      await readFile(
        new URL(
          '../node_modules/next/dist/compiled/next-server/pages-api.runtime.prod.js',
          import.meta.url,
        ),
      ),
    );
    const physical = {
      ...own.physical,
      files: [...own.physical.files, { name: own.physical.nameOf(file), bytes }],
      sourcePaths: new Map([...own.physical.sourcePaths, [own.physical.nameOf(file), file]]),
    };
    const artifact = new NodeArtifactFiles(own.input, physical, [], own.proof);

    expect(() => {
      artifact.rewriteNextFiles();
    }).toThrow('matching certificate');
  });

  it('requires every certified physical runtime to receive the guarded archive bytes', async () => {
    const own = await nodeNextRewriteFixture(directory);
    const physical = {
      ...own.physical,
      files: own.physical.files.filter((file) => file.name !== own.physical.nameOf(own.runtime)),
    };
    const artifact = new NodeArtifactFiles(own.input, physical, [], own.proof);
    artifact.rewriteNextFiles();

    await expect(artifact.assertNextRewrites()).rejects.toThrow(
      'certified physical source was not rewritten',
    );
  });

  it.each(['own', 'composed'] as const)(
    'seals the %s hook target and generated bundle mapping',
    async (mode) => {
      const own = await nodeNextRewriteFixture(directory, mode);
      assert.isDefined(own.hook);
      const artifact = new NodeArtifactFiles(own.input, own.physical, [], own.proof);
      const bytes = new TextEncoder().encode(
        mode === 'own'
          ? nodeProjectInstrumentationSource(own.physical.nameOf(own.hook))
          : 'exports.register=async()=>{};',
      );
      const originals =
        mode === 'own'
          ? new Map<string, string>()
          : new Map([[own.hook, rewriteDigest(await readFile(own.hook))]]);
      artifact.sealInstrumentation(originals, bytes);
      artifact.add('upwind/instrumentation.cjs', bytes);
      artifact.rewriteNextFiles();
      await artifact.assertNextRewrites();
      const loader = artifact.files.get(own.physical.nameOf(own.loader));
      assert.isDefined(loader);

      expect(Buffer.from(loader.bytes).toString('utf8')).toContain(
        '/bundle/upwind/instrumentation.cjs',
      );
      expect(own.loaderCode).not.toContain('/bundle/upwind/instrumentation.cjs');
      expect(
        nodeNextRewriteMetadata(own.proof)
          .map((source) => source.file)
          .toSorted((left, right) => left.localeCompare(right)),
      ).toStrictEqual(
        [own.config, own.runtime, own.loader].toSorted((left, right) => left.localeCompare(right)),
      );
    },
  );

  async function ownHookArtifact() {
    const own = await nodeNextRewriteFixture(directory, 'own');
    assert.isDefined(own.hook);
    const artifact = new NodeArtifactFiles(own.input, own.physical, [], own.proof);
    const bytes = new TextEncoder().encode(
      nodeProjectInstrumentationSource(own.physical.nameOf(own.hook)),
    );
    return { own, artifact, bytes, selectedHook: own.hook };
  }

  it('rejects a same-content replacement of the selected hook', async () => {
    const { own, artifact, bytes, selectedHook } = await ownHookArtifact();
    const other = path.join(directory, 'same-content.js');
    await writeFile(other, await readFile(selectedHook));
    Object.assign(own.input.patch, { instrumentation: other });

    expect(() => {
      artifact.sealInstrumentation(new Map(), bytes);
    }).toThrow('context changed');
  });

  it('rejects a generated project-hook wrapper pointing at another archive path', async () => {
    const { artifact } = await ownHookArtifact();
    const bytes = new TextEncoder().encode(nodeProjectInstrumentationSource('project/wrong.js'));

    expect(() => {
      artifact.sealInstrumentation(new Map(), bytes);
    }).toThrow('wrapper mapping');
  });

  it('rejects an instrumentation bundle with an extra unproved source', async () => {
    const { artifact, bytes } = await ownHookArtifact();

    expect(() => {
      artifact.sealInstrumentation(new Map([['/unknown/source.js', 'unknown']]), bytes);
    }).toThrow('source differs');
  });

  it('rejects changed generated bundle bytes immediately before archiving', async () => {
    const { artifact, bytes } = await ownHookArtifact();
    artifact.sealInstrumentation(new Map(), bytes);
    artifact.add('upwind/instrumentation.cjs', bytes);
    artifact.rewriteNextFiles();
    artifact.files.set('upwind/instrumentation.cjs', {
      name: 'upwind/instrumentation.cjs',
      bytes: new Uint8Array([0]),
    });

    await expect(artifact.assertNextRewrites()).rejects.toThrow('bundle changed');
  });

  it('rejects a project hook that disappears after its bundle was sealed', async () => {
    const { artifact, bytes, selectedHook } = await ownHookArtifact();
    artifact.sealInstrumentation(new Map(), bytes);
    artifact.add('upwind/instrumentation.cjs', bytes);
    artifact.rewriteNextFiles();
    await rm(selectedHook);

    await expect(artifact.assertNextRewrites()).rejects.toThrow('project hook changed');
  });

  it('binds symlink resolution rather than accepting a same-content hook retarget', async () => {
    const own = await nodeNextRewriteFixture(directory, 'composed');
    assert.isDefined(own.hook);
    const target = path.join(directory, 'other.cjs');
    await writeFile(target, await readFile(own.hook));
    await rm(own.hook);
    await symlink(target, own.hook);
    const artifact = new NodeArtifactFiles(own.input, own.physical, [], own.proof);

    await expect(artifact.assertNextRewrites()).rejects.toThrow('selected hook changed');
  });

  it.each([true, false])('refuses an unknown loader caller, retained=%s', async (retained) => {
    const own = await nodeNextRewriteFixture(directory);
    const caller = path.join(directory, 'unknown.js');
    const code =
      'exports.load=(project,dist)=>require("next/dist/server/lib/router-utils/instrumentation-globals.external.js").getInstrumentationModule(project,dist);';
    await writeFile(caller, code);
    own.graph.sources.set(caller, { file: caller, sha256: rewriteDigest(code) });
    own.graph.imports.set(caller, [
      {
        specifier: 'next/dist/server/lib/router-utils/instrumentation-globals.external.js',
        target: own.loader,
      },
    ]);
    own.graph.importers.get(own.loader)?.push(caller);
    const retain = retained
      ? () => own.graph.retained.add(caller)
      : () => own.graph.retained.delete(caller);
    retain();

    await expect(own.certify(true)).rejects.toThrow('loader caller or root');
  });

  it.each(['cache', 'instrumentation'] as const)(
    'refuses a fake %s source through the actual original Node pipeline',
    async (kind) => {
      const distDir = path.join(directory, '.next');
      const entry = path.join(distDir, 'server/entry.cjs');
      const file =
        kind === 'cache'
          ? path.join(
              directory,
              'node_modules/next/dist/compiled/next-server/pages.runtime.prod.js',
            )
          : path.join(
              directory,
              'node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js',
            );
      await mkdir(path.dirname(entry), { recursive: true });
      await mkdir(path.dirname(file), { recursive: true });
      const code =
        kind === 'cache'
          ? // eslint-disable-next-line no-template-curly-in-string -- Inert fake runtime source.
            'exports.load=async function(root,handler){return [interop(await load(format(`${root}/${this.distDir}`,handler))),interop(await load(format(this.distDir,handler)))]};'
          : // eslint-disable-next-line no-template-curly-in-string -- Inert fake loader source.
            "exports.load=async function(projectDir,distDir){return await require(_nodepath.default.join(projectDir, distDir, 'server', `${_constants.INSTRUMENTATION_HOOK_FILENAME}.js`))};";
      const binary = path.join(distDir, 'server/addon.node');
      await writeFile(binary, new Uint8Array([0]));
      await writeFile(file, code);
      await writeFile(
        entry,
        `exports.native=()=>require("./addon.node");exports.loader=require(${jsLiteral(file)});`,
      );

      await expect(
        proveNodeFunction({
          kind: 'app',
          projectDir: directory,
          outDir: path.join(directory, '.upwind'),
          entries: [{ id: '/native', filePath: entry }],
          entryTraces: [{ id: '/native', assets: { entry, binary, file } }],
          patch: {
            projectDir: directory,
            distDir,
            chunks: [],
            instrumentation: undefined,
            wasm: [],
          },
        }),
      ).rejects.toThrow(/cache policy caller proof|loader source/u);
    },
  );
});
