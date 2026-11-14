import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import { PATCHES, type PatchContext, rewrittenChunk } from '../src/patches/index.ts';
import { patchesPlugin, patchSource } from '../src/patches/rolldown.ts';
import type { Patch } from '../src/patches/types.ts';
import { sameChunks } from '../src/same-chunks.ts';

const CODE = 'module.exports=[1,()=>42];\n';
const PACKAGE_SOURCE = '../../../node_modules/next/dist/server/example.js';
const PROJECT_SOURCE = '../../../src/page.ts';
const GRAPH = 'module.exports=[1,()=>Symbol.for("next.server.manifests")];\n';
const ABORT = [
  'if (cacheSignal) {',
  'cacheSignal.inputReady().then(()=>{ controller.abort(); });',
  '} else if (staged) {',
  'rendering.waitForStage(finalStage).then(()=>scheduleOnNextTick(()=>controller.abort()), noop);',
  '} else { scheduleOnNextTick(()=>controller.abort()); }',
  '',
].join('\n');

describe('server chunk code and source-map identity', () => {
  let directory: string;
  let distDir: string;
  let chunks: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upwind-project-chunks-'));
    distDir = path.join(directory, '.next');
    chunks = path.join(distDir, 'server', 'chunks');
    await mkdir(chunks, { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function written(
    name: string,
    source: string,
    mappings: string,
    code = CODE,
  ): Promise<string> {
    const file = path.join(chunks, `${name}.js`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${code}//# sourceMappingURL=${path.basename(file)}.map`);
    await writeFile(
      `${file}.map`,
      JSON.stringify({ version: 3, sources: [source], names: [], mappings }),
    );
    return file;
  }

  function projectMaps() {
    return {
      carried: true,
      project: { projectDir: directory, distDir, outDir: path.join(directory, '.out') },
    };
  }

  function context(): PatchContext {
    return { projectDir: directory, distDir, chunks: [], instrumentation: undefined, wasm: [] };
  }

  function rewritten(source: string, file: string): string | undefined {
    return rewrittenChunk(source, file, context());
  }

  function different(source: string, file: string): string {
    return `${rewritten(source, file)}\n${JSON.stringify(file)}`;
  }

  it('merges package-only twins whose dropped mappings leave different unmapped boundaries', async () => {
    const a = await written('a', PACKAGE_SOURCE, 'AAAA;AACA');
    const b = await written('b', PACKAGE_SOURCE, 'KAAA;;EACA');

    await expect(sameChunks([a, b], projectMaps())).resolves.toStrictEqual(new Map([[b, a]]));
  });

  it('keeps the same package mappings distinct when the whole maps are carried', async () => {
    const a = await written('a', PACKAGE_SOURCE, 'AAAA;AACA');
    const b = await written('b', PACKAGE_SOURCE, 'KAAA;;EACA');

    await expect(sameChunks([a, b], { carried: true })).resolves.toStrictEqual(new Map());
  });

  it('preserves different frames in retained project sources', async () => {
    const a = await written('a', PROJECT_SOURCE, 'AAAA');
    const b = await written('b', PROJECT_SOURCE, 'AACA');

    await expect(sameChunks([a, b], projectMaps())).resolves.toStrictEqual(new Map());
  });

  it('keeps a map with project frames apart from one with none', async () => {
    const a = await written('a', PACKAGE_SOURCE, 'AAAA');
    const b = await written('b', PROJECT_SOURCE, 'AAAA');

    await expect(sameChunks([a, b], projectMaps())).resolves.toStrictEqual(new Map());
  });

  it.each([
    ['manifests', GRAPH],
    ['abort waits', ABORT],
  ])('shares %s rewrites whose original maps the actual loader does not carry', async (_, code) => {
    const a = await written('a', PROJECT_SOURCE, 'AAAA', code);
    const b = await written('b', PROJECT_SOURCE, 'AACA', code);
    const source = await readFile(a, 'utf8');
    const expected = rewritten(source, a);
    const load = patchesPlugin(PATCHES, context()).load;
    assert.ok(load !== undefined && typeof load !== 'function');
    const id = a.split(path.sep).join('/');
    const loaded = await load.handler.call({} as never, id, { rawId: id, attributes: {} });

    expect(expected).toBeDefined();
    expect(loaded).toStrictEqual({ code: expected, moduleType: 'js' });
    await expect(sameChunks([a, b], { carried: true }, rewritten)).resolves.toStrictEqual(
      new Map([[b, a]]),
    );
  });

  it('keeps unpatched project frames strict even when a rewrite proof is offered', async () => {
    const a = await written('a', PROJECT_SOURCE, 'AAAA');
    const b = await written('b', PROJECT_SOURCE, 'AACA');

    expect(rewritten(await readFile(a, 'utf8'), a)).toBeUndefined();
    await expect(sameChunks([a, b], { carried: true }, rewritten)).resolves.toStrictEqual(
      new Map(),
    );
  });

  it('requires equal original code even when its rewritten output would be equal', async () => {
    const a = await written('a', PROJECT_SOURCE, 'AAAA', GRAPH);
    const b = await written('b', PROJECT_SOURCE, 'AACA', GRAPH.replaceAll('"', "'"));

    await expect(sameChunks([a, b], { carried: true }, rewritten)).resolves.toStrictEqual(
      new Map(),
    );
  });

  it('requires equal rewritten output as well as equal original code', async () => {
    const a = await written('a', PROJECT_SOURCE, 'AAAA', GRAPH);
    const b = await written('b', PROJECT_SOURCE, 'AACA', GRAPH);

    await expect(sameChunks([a, b], { carried: true }, different)).resolves.toStrictEqual(
      new Map(),
    );
  });

  it('keeps a proven rewrite apart from an ordinary load of the same code', async () => {
    const a = await written('a', PROJECT_SOURCE, 'AAAA', GRAPH);
    const b = await written('b', PROJECT_SOURCE, 'AAAA', GRAPH);
    const oneSided = (source: string, file: string): string | undefined =>
      file === a ? rewritten(source, file) : undefined;

    await expect(sameChunks([a, b], { carried: true }, oneSided)).resolves.toStrictEqual(new Map());
  });

  it('keeps rewritten chunks in different directories at their own module coordinates', async () => {
    const a = await written('one/a', PROJECT_SOURCE, 'AAAA', GRAPH);
    const b = await written('two/b', PROJECT_SOURCE, 'AACA', GRAPH);

    await expect(sameChunks([a, b], { carried: true }, rewritten)).resolves.toStrictEqual(
      new Map(),
    );
  });

  it('rejects a context-dependent runtime claim before building its copy table', () => {
    expect(
      rewritten('unbuilt runtime', path.join(chunks, '[turbopack]_runtime.js')),
    ).toBeUndefined();
  });

  it('runs the actual rewrite guards instead of accepting a marker alone', () => {
    const source = 'const text = `Symbol.for("next.server.manifests")`;';

    expect(() => rewritten(source, path.join(chunks, 'a.js'))).toThrow(
      'expected the key of the manifests singleton 0 time(s), found 1',
    );
  });

  it('checks later claims against the intermediate source and refuses them before applying', () => {
    const first: Patch = {
      name: 'first',
      target: /\.js$/u,
      reaches: ['build-output'],
      marker: (source) => source === 'before',
      apply: () => ({ contents: 'after', edits: 1, notes: [] }),
    };
    const later: Patch = {
      name: 'later',
      target: /\.js$/u,
      reaches: ['build-output'],
      marker: (source) => source === 'after',
      apply() {
        throw new Error('a context-dependent rewrite must not run during comparison');
      },
    };

    expect(
      patchSource([first, later], context(), {
        source: 'before',
        file: path.join(chunks, 'a.js'),
        only: new Set([first]),
      }),
    ).toBeUndefined();
  });
});
