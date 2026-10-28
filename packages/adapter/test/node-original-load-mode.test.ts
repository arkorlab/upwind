import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  nodeOriginalModeMetadata,
  nodeOriginalModeProofFiles,
} from '../src/node-original-load-mode-archive.ts';
import {
  assertOriginalCommonJsMode,
  originalNodeModeHash,
  inspectOriginalNodeMode,
  prepareOriginalNodeModes,
  useOriginalCommonJsMode,
  type OriginalNodeModeGraph,
} from '../src/node-original-load-mode.ts';
import { isNodeProofCompilerModule } from '../src/node-proof.ts';

async function prepareModes(
  input: { readonly rootDir: string; readonly projectDir: string; readonly distDir: string },
  graph: OriginalNodeModeGraph,
) {
  return prepareOriginalNodeModes(
    input,
    graph,
    [...graph.retained].filter((id) => !isNodeProofCompilerModule(id)),
  );
}

const directories: string[] = [];

async function fixture(extension = '.js', metadata: string | null = '{"type":"commonjs"}') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-node-goal-'));
  const root = await realpath(temporary);
  directories.push(root);
  const project = path.join(root, 'project');
  const dist = path.join(project, '.next');
  await mkdir(path.join(dist, 'server/chunks'), { recursive: true });
  await mkdir(project, { recursive: true });
  const file = path.join(dist, `server/chunks/page${extension}`);
  await writeFile(file, 'module.exports=42;');
  const pkg = path.join(dist, 'package.json');
  if (metadata !== null) await writeFile(pkg, metadata);
  const source = { file, sha256: originalNodeModeHash(await readFile(file)) };
  const graph = { sources: new Map([['page', source]]), retained: new Set(['page']) };
  const scope = await prepareModes({ rootDir: project, projectDir: project, distDir: dist }, graph);
  return { root, project, dist, file, pkg, source, graph, scope };
}

async function unsupportedMetadata(
  own: Awaited<ReturnType<typeof fixture>>,
  kind: 'oversize' | 'symlink',
) {
  if (kind === 'oversize') {
    await writeFile(own.pkg, JSON.stringify({ type: 'commonjs', padding: 'x'.repeat(70_000) }));
    return;
  }
  const target = path.join(own.project, 'authored-scope.json');
  await writeFile(target, '{"type":"commonjs"}');
  await rm(own.pkg);
  await symlink(target, own.pkg);
}

async function requiredMode(own: Awaited<ReturnType<typeof fixture>>) {
  const proof = await useOriginalCommonJsMode(own.scope, 'page', own.source);
  if (proof === undefined) throw new Error('missing authored mode');
  return proof;
}
async function changeSource(own: Awaited<ReturnType<typeof fixture>>, field: string) {
  const files = {
    source: own.file,
    metadata: own.pkg,
    closer: path.join(own.dist, 'server/package.json'),
  };
  const file = Reflect.get(files, field) as string;
  const before = field === 'closer' ? undefined : await readFile(file);
  await writeFile(
    file,
    field === 'source' ? 'module.exports=43;' : '{"type":"commonjs","changed":true}',
  );
  return async () => {
    if (before === undefined) await rm(file);
    else await writeFile(file, before);
  };
}

describe('original CommonJS mode source facts; no application executes', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('filters only the existing exact Rolldown virtual runtime without cloning the original graph', async () => {
    const own = await fixture();
    const runtime = `${String.fromCodePoint(0)}rolldown/runtime.js`;
    own.graph.retained.add(runtime);
    const scope = await prepareModes(
      { rootDir: own.project, projectDir: own.project, distDir: own.dist },
      own.graph,
    );

    await expect(useOriginalCommonJsMode(scope, 'page', own.source)).resolves.toBeDefined();
    await expect(inspectOriginalNodeMode(scope, runtime)).rejects.toThrow('identity');

    const graph = {
      sources: own.graph.sources,
      retained: new Set([...own.graph.retained, `${runtime}?unknown`]),
    };

    await expect(
      prepareModes({ rootDir: own.project, projectDir: own.project, distDir: own.dist }, graph),
    ).rejects.toThrow('missing original descriptor');
  });

  it.each(['oversize', 'symlink'] as const)(
    'makes the same metadata limitation %s fatal after a proof is USED',
    async (kind) => {
      const own = await fixture();
      await useOriginalCommonJsMode(own.scope, 'page', own.source);
      await unsupportedMetadata(own, kind);

      await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).rejects.toThrow(
        'no longer CommonJS',
      );
    },
  );

  it.each(['.mjs', '.cts', '.ts'])('does not admit unsupported extension %s', async (extension) => {
    const own = await fixture(extension);

    await expect(inspectOriginalNodeMode(own.scope, 'page')).resolves.toMatchObject({
      kind: 'unknown',
    });
    await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).resolves.toBeUndefined();
    expect(nodeOriginalModeProofFiles(own.scope, [])).toStrictEqual([]);
  });

  it.each([
    null,
    '{}',
    '{"type":"module"}',
    '{"type":"commonjs","type":"commonjs"}',
    '{"type":"module","type":"commonjs"}',
    '{"ty\\u0070e":"commonjs","type":"commonjs"}',
  ])('leaves default/ESM/ambiguous nearest metadata unknown: %s', async (metadata) => {
    const own = await fixture('.js', metadata);

    await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).resolves.toBeUndefined();
    expect(nodeOriginalModeMetadata(own.scope)).toStrictEqual([]);
  });

  it('does not cross a nearer scope without type to use an ancestor type', async () => {
    const own = await fixture();
    await writeFile(path.join(own.dist, 'server/package.json'), '{}');

    await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).resolves.toBeUndefined();
  });

  it('shares one private token across simultaneous fresh checks of the same original source', async () => {
    const own = await fixture();
    const [first, second] = await Promise.all([
      useOriginalCommonJsMode(own.scope, 'page', own.source),
      useOriginalCommonJsMode(own.scope, 'page', own.source),
    ]);

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(nodeOriginalModeMetadata(own.scope)).toHaveLength(1);
  });

  it('rejects a previously used mode becoming unknown instead of silently forgetting its witness', async () => {
    const own = await fixture();
    await useOriginalCommonJsMode(own.scope, 'page', own.source);
    await writeFile(own.pkg, '{"type":"module"}');

    await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).rejects.toThrow(
      'no longer CommonJS',
    );
  });

  it('does not merge differing metadata snapshots for separate used sources', async () => {
    const own = await fixture();
    const file = path.join(own.dist, 'server/chunks/second.js');
    await writeFile(file, 'module.exports=2;');
    const second = { file, sha256: originalNodeModeHash(await readFile(file)) };
    own.graph.sources.set('second', second);
    own.graph.retained.add('second');
    const scope = await prepareModes(
      { rootDir: own.project, projectDir: own.project, distDir: own.dist },
      own.graph,
    );
    await useOriginalCommonJsMode(scope, 'page', own.source);
    await writeFile(own.pkg, '{"type":"commonjs","revision":2}');
    await useOriginalCommonJsMode(scope, 'second', second);

    expect(() => nodeOriginalModeMetadata(scope)).toThrow('conflicting used metadata');
  });

  it('refuses copied scope/source/token and retargeted graph descriptors', async () => {
    const own = await fixture();
    const proof = await requiredMode(own);

    await expect(useOriginalCommonJsMode({ ...own.scope }, 'page', own.source)).rejects.toThrow(
      'scope',
    );
    await expect(useOriginalCommonJsMode(own.scope, 'page', { ...own.source })).rejects.toThrow(
      'identity',
    );
    await expect(
      assertOriginalCommonJsMode({ ...proof }, own.scope, 'page', own.source),
    ).rejects.toThrow('mode');

    const foreign = await prepareModes(
      { rootDir: own.project, projectDir: own.project, distDir: own.dist },
      { ...own.graph },
    );

    await expect(assertOriginalCommonJsMode(proof, foreign, 'page', own.source)).rejects.toThrow(
      'mode',
    );

    own.graph.sources.set('page', { ...own.source });

    await expect(assertOriginalCommonJsMode(proof, own.scope, 'page', own.source)).rejects.toThrow(
      'identity',
    );
  });

  it.each(['source', 'metadata', 'closer'])(
    'rejects separate-call FS changes to %s after capture and restores valid facts',
    async (field) => {
      const own = await fixture();
      const proof = await requiredMode(own);
      const restore = await changeSource(own, field);

      await expect(
        assertOriginalCommonJsMode(proof, own.scope, 'page', own.source),
      ).rejects.toThrow('CommonJS goal');

      await restore();
      await assertOriginalCommonJsMode(proof, own.scope, 'page', own.source);
    },
  );

  it('rejects changed original descriptors and graph inventories, then rechecks restored identities', async () => {
    const own = await fixture();
    const proof = await requiredMode(own);
    const sha256 = own.source.sha256;
    own.source.sha256 = 'changed';

    await expect(assertOriginalCommonJsMode(proof, own.scope, 'page', own.source)).rejects.toThrow(
      'identity',
    );

    own.source.sha256 = sha256;
    const sources = own.graph.sources;
    own.graph.sources = new Map(sources);

    await expect(assertOriginalCommonJsMode(proof, own.scope, 'page', own.source)).rejects.toThrow(
      'identity',
    );

    own.graph.sources = sources;
    const retained = own.graph.retained;
    own.graph.retained = new Set(retained);

    await expect(assertOriginalCommonJsMode(proof, own.scope, 'page', own.source)).rejects.toThrow(
      'identity',
    );

    own.graph.retained = retained;
    retained.delete('page');

    await expect(assertOriginalCommonJsMode(proof, own.scope, 'page', own.source)).rejects.toThrow(
      'identity',
    );

    retained.add('page');
    await assertOriginalCommonJsMode(proof, own.scope, 'page', own.source);
  });

  it.each(['.cjs', '.js'])(
    'preserves root-owned %s facts with an absent unused output and does not upgrade a later output',
    async (extension) => {
      const own = await fixture();
      const dist = path.join(own.root, 'not-created');
      const file = path.join(own.project, `entry${extension}`);
      await writeFile(file, 'module.exports=1;');
      await writeFile(path.join(own.project, 'package.json'), '{"type":"commonjs"}');
      const source = { file, sha256: originalNodeModeHash(await readFile(file)) };
      const externalFile = path.join(dist, 'later.cjs');
      const external = { file: externalFile, sha256: originalNodeModeHash('module.exports=2;') };
      const graph = {
        sources: new Map([
          ['external', external],
          ['root', source],
        ]),
        retained: new Set(['external', 'root']),
      };
      const scope = await prepareModes(
        { rootDir: own.project, projectDir: own.project, distDir: dist },
        graph,
      );
      const proof = await useOriginalCommonJsMode(scope, 'root', source);

      expect(proof).toBeDefined();

      await mkdir(dist);
      await writeFile(externalFile, 'module.exports=2;');

      await expect(useOriginalCommonJsMode(scope, 'root', source)).resolves.toBe(proof);
      await expect(useOriginalCommonJsMode(scope, 'external', external)).rejects.toThrow('escapes');
    },
  );

  it('keeps an existing output root identity fresh after it is retargeted', async () => {
    const own = await fixture();
    const proof = await requiredMode(own);
    const original = `${own.dist}-original`;
    const alternate = path.join(own.root, 'alternate-dist');
    await rename(own.dist, original);
    await mkdir(alternate);
    await symlink(alternate, own.dist);

    await expect(assertOriginalCommonJsMode(proof, own.scope, 'page', own.source)).rejects.toThrow(
      'root changed',
    );

    await rm(own.dist);
    await rename(original, own.dist);
    await assertOriginalCommonJsMode(proof, own.scope, 'page', own.source);
  });

  it('refuses symlink metadata and original sources outside owned roots', async () => {
    const own = await fixture();
    const target = path.join(own.root, 'scope.json');
    await writeFile(target, '{"type":"commonjs"}');
    await rm(own.pkg);
    await symlink(target, own.pkg);

    await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).resolves.toBeUndefined();

    const file = path.join(own.root, 'outside.cjs');
    await writeFile(file, 'module.exports=1;');
    const source = { file, sha256: originalNodeModeHash(await readFile(file)) };
    own.graph.sources.set('outside', source);
    own.graph.retained.add('outside');
    const fresh = await prepareModes(
      { rootDir: own.project, projectDir: own.project, distDir: own.dist },
      own.graph,
    );

    await expect(useOriginalCommonJsMode(fresh, 'outside', source)).rejects.toThrow('escapes');
  });
});
