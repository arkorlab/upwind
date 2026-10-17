import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appEntrySource } from '../src/app-entry.ts';
import { assertBuildPaths, buildPaths } from '../src/build-paths.ts';
import { edgeEntrySource, type EdgeEntry } from '../src/edge.ts';
import { collectManifests } from '../src/manifests.ts';
import { turbopackRootPatch } from '../src/patches/turbopack-root.ts';
import { inlineAssetFiles, tracedFiles } from '../src/traced-files.ts';

describe('build output paths in the Function', () => {
  let root: string;
  let project: string;
  let dist: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'upwind-build-paths-'));
    project = path.join(root, 'apps', 'web');
    dist = path.join(root, 'dist', 'apps', 'web', '.next');
    await mkdir(project, { recursive: true });
    await mkdir(path.join(dist, 'server', 'app'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('retains names and roots for an in-project output', () => {
    const inside = path.join(project, '.custom-next');
    const paths = buildPaths(project, inside);

    expect(paths.external).toBe(false);
    expect(paths.runtimeDistDir).toBe('.custom-next');
    expect(paths.moduleName(path.join(inside, 'BUILD_ID'))).toBe('.custom-next/BUILD_ID');
    expect(paths.runtimePath(path.join(inside, 'BUILD_ID'))).toBe('/bundle/.custom-next/BUILD_ID');
    expect(paths.moduleName(path.join(project, 'data.json'))).toBe('data.json');
  });

  it.each(['../../dist/apps/web/.next', '../.next'])(
    'mounts %s under a legal reserved name without moving the physical path',
    (relative) => {
      const output = path.resolve(project, relative);
      const paths = buildPaths(project, output);

      expect(paths.external).toBe(true);
      expect(paths.runtimeDistDir).toBe('.upwind-build');
      expect(paths.moduleName(path.join(output, 'server', 'app', 'page.js'))).toBe(
        '.upwind-build/server/app/page.js',
      );
      expect(paths.runtimePath(path.join(output, 'BUILD_ID'))).toBe(
        '/bundle/.upwind-build/BUILD_ID',
      );
      expect(paths.moduleName(path.join(root, 'unrelated', 'data.json'))).toBeUndefined();
    },
  );

  it('refuses an output that is the project or an ancestor', () => {
    expect(() => buildPaths(project, project)).toThrow('ancestor');
    expect(() => buildPaths(project, path.dirname(project))).toThrow('ancestor');
    expect(() => buildPaths(project, path.parse(project).root)).toThrow('ancestor');
  });

  it('refuses reserved data names only when an external output needs the mount', async () => {
    const reserved = path.join(project, '.upwind-build');
    await mkdir(reserved);

    expect(() => {
      assertBuildPaths(project, dist, path.join(project, '.arkor'));
    }).toThrow('reserved');
    expect(() => buildPaths(project, dist).moduleName(path.join(reserved, 'data.json'))).toThrow(
      'reserved',
    );
    expect(buildPaths(project, path.join(project, '.next')).moduleName(reserved)).toBe(
      '.upwind-build',
    );
  });

  it('rejects lexical and symlink aliases of the staging output before clearing it', async () => {
    const out = path.join(project, '.arkor');
    await mkdir(out);

    expect(() => {
      assertBuildPaths(project, out, out);
    }).toThrow('overlaps');
    expect(() => {
      assertBuildPaths(project, path.join(out, 'next'), out);
    }).toThrow('overlaps');

    const alias = path.join(root, 'output-alias');
    await symlink(out, alias, 'dir');

    expect(() => {
      assertBuildPaths(project, alias, out);
    }).toThrow('overlaps');

    await rm(alias);
    await symlink(project, alias, 'dir');

    expect(() => {
      assertBuildPaths(project, alias, out);
    }).toThrow('ancestor');
  });

  it('collects external root and route manifests under the same VFS mount', async () => {
    await writeFile(path.join(dist, 'BUILD_ID'), 'the-build');
    await writeFile(path.join(dist, 'routes-manifest.json'), '{}');
    await writeFile(
      path.join(dist, 'server', 'app', 'page_client-reference-manifest.js'),
      'globalThis.__RSC_MANIFEST = {"page": {}};',
    );
    const modules = await collectManifests(project, dist, 'deployment');

    expect(
      modules.map((module) => module.name).toSorted((a, b) => a.localeCompare(b)),
    ).toStrictEqual([
      '.upwind-build/BUILD_ID',
      '.upwind-build/routes-manifest.json',
      '.upwind-build/server/app/page_client-reference-manifest.json',
    ]);
    expect(modules.find((module) => module.name.endsWith('BUILD_ID'))?.contents).toBe('the-build');
    expect(() => {
      assertBuildPaths(project, dist, path.join(project, '.arkor'));
    }).not.toThrow();
  });

  it('ships traced build assets and project data without including an ancestor tree', async () => {
    const asset = path.join(dist, 'server', 'assets', 'template.js');
    await mkdir(path.dirname(asset));
    await writeFile(asset, 'read as bytes');
    const data = path.join(project, 'data.json');
    const assets = {
      asset,
      data,
      code: path.join(dist, 'server', 'app', 'page.js'),
      sibling: path.join(root, 'apps', 'another', 'data.json'),
      package: path.join(project, 'node_modules', 'pkg', 'data.json'),
    };

    expect(tracedFiles([{ assets }], project, dist)).toStrictEqual([
      { name: '.upwind-build/server/assets/template.js', filePath: asset },
      { name: 'data.json', filePath: data },
    ]);
    expect(tracedFiles([{ runtime: 'edge', assets }], project, dist)).toStrictEqual([]);
  });

  it('rejects symlink escapes in traced assets and route manifests', async () => {
    const secret = path.join(root, 'outside.json');
    await writeFile(secret, '{}');
    const asset = path.join(dist, 'server', 'assets', 'data.json');
    await mkdir(path.dirname(asset));
    await symlink(secret, asset);

    expect(() => tracedFiles([{ assets: { asset } }], project, dist)).toThrow('symlink');

    await symlink(secret, path.join(dist, 'server', 'app', 'page_client-reference-manifest.js'));

    await expect(collectManifests(project, dist, 'deployment')).rejects.toThrow('symlink');
  });

  it('uses the same names when shipping and fetching inline edge assets', async () => {
    const font = path.join(dist, 'server', 'edge', 'font.ttf');
    await mkdir(path.dirname(font));
    await writeFile(font, 'font');
    const entry: EdgeEntry = {
      id: '/image',
      entryKey: 'image',
      handlerExport: 'handler',
      files: [],
      wasm: [],
      env: {},
      inlineAssets: [{ name: 'font', filePath: font }],
    };

    expect(inlineAssetFiles([entry], project, dist)).toStrictEqual([
      { name: '.upwind-build/server/edge/font.ttf', filePath: font },
    ]);
    expect(edgeEntrySource([entry], project, dist)).toContain(
      '/bundle/.upwind-build/server/edge/font.ttf',
    );
  });

  it('rewrites both Turbopack roots independently of physical workspace nesting', () => {
    const source = [
      'const RUNTIME_ROOT = path.resolve(__filename, relativePathToRuntimeRoot);',
      'const ABSOLUTE_ROOT = path.resolve(__filename, relativePathToDistRoot);',
    ].join('\n');
    const file = path.join(dist, 'server', 'chunks', '[turbopack]_runtime.js');
    const result = turbopackRootPatch.apply(source, file, {
      projectDir: project,
      distDir: dist,
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    });

    expect(result.contents).toContain('RUNTIME_ROOT = "/bundle/.upwind-build"');
    expect(result.contents).toContain('ABSOLUTE_ROOT = "/bundle"');
    expect(result.edits).toBe(2);
  });

  it('keeps routes lazy and normalizes an external route only on its first load', () => {
    const setDistDir = vi.fn<(value: string) => void>();
    const loaded = {
      routeModule: {
        get distDir() {
          return '../.next';
        },
        set distDir(value: string) {
          setDistDir(value);
        },
      },
    };
    const require = vi.fn<() => typeof loaded>().mockReturnValue(loaded);
    const module: { exports: { entries?: Record<string, () => typeof loaded> } } = { exports: {} };
    const source = appEntrySource(
      [
        { id: '/one', filePath: path.join(dist, 'server', 'one.js') },
        { id: '/two', filePath: path.join(dist, 'server', 'two.js') },
      ],
      buildPaths(project, dist),
    );
    // eslint-disable-next-line sonarjs/code-eval -- evaluate this generated entry with a fake loader, not application code.
    runInNewContext(source, { module, require });

    expect(require).not.toHaveBeenCalled();
    expect(module.exports.entries?.['/one']?.()).toBe(loaded);
    expect(module.exports.entries?.['/one']?.()).toBe(loaded);
    expect(require).toHaveBeenCalledExactlyOnceWith(path.join(dist, 'server', 'one.js'));
    expect(setDistDir).toHaveBeenCalledExactlyOnceWith('.upwind-build');
  });

  it('normalizes an asynchronous external route before handing it to concurrent callers', async () => {
    const pending = Promise.withResolvers<{ routeModule: { distDir: string } }>();
    const require = vi
      .fn<() => Promise<{ routeModule: { distDir: string } }>>()
      .mockReturnValue(pending.promise);
    const module: {
      exports: { entries?: Record<string, () => Promise<{ routeModule: { distDir: string } }>> };
    } = { exports: {} };
    const source = appEntrySource(
      [
        { id: '/one', filePath: path.join(dist, 'server', 'one.js') },
        { id: '/two', filePath: path.join(dist, 'server', 'two.js') },
      ],
      buildPaths(project, dist),
    );
    // eslint-disable-next-line sonarjs/code-eval -- evaluate generated code with a pending fake loader, not application code.
    runInNewContext(source, { module, require });
    const first = module.exports.entries?.['/one']?.();
    const second = module.exports.entries?.['/one']?.();
    const loaded = { routeModule: { distDir: '../.next' } };

    expect(first).toBe(second);
    expect(require).toHaveBeenCalledExactlyOnceWith(path.join(dist, 'server', 'one.js'));
    expect(loaded.routeModule.distDir).toBe('../.next');

    pending.resolve(loaded);

    await expect(first).resolves.toBe(loaded);
    expect(loaded.routeModule.distDir).toBe('.upwind-build');
    await expect(module.exports.entries?.['/one']?.()).resolves.toBe(loaded);
    expect(require).toHaveBeenCalledTimes(1);
  });

  it('retries an asynchronous entry initialization failure and shares the successful retry', async () => {
    const failure = new Error('entry initialization failed');
    const loaded = { routeModule: { distDir: '../.next' } };
    const pending = Promise.withResolvers<typeof loaded>();
    const require = vi
      .fn<() => Promise<typeof loaded>>()
      .mockRejectedValueOnce(failure)
      .mockReturnValue(pending.promise);
    const module: { exports: { entries?: Record<string, () => Promise<typeof loaded>> } } = {
      exports: {},
    };
    const source = appEntrySource(
      [{ id: '/one', filePath: path.join(dist, 'server', 'one.js') }],
      buildPaths(project, dist),
    );
    // eslint-disable-next-line sonarjs/code-eval -- evaluate generated code with a rejecting fake loader, not application code.
    runInNewContext(source, { module, require });

    const first = module.exports.entries?.['/one']?.();
    const concurrentFailure = module.exports.entries?.['/one']?.();

    expect(first).toBe(concurrentFailure);
    await expect(first).rejects.toBe(failure);
    expect(require).toHaveBeenCalledTimes(1);

    const retry = module.exports.entries?.['/one']?.();
    const concurrentRetry = module.exports.entries?.['/one']?.();

    expect(retry).toBe(concurrentRetry);
    expect(require).toHaveBeenCalledTimes(2);

    pending.resolve(loaded);

    await expect(retry).resolves.toBe(loaded);
    expect(loaded.routeModule.distDir).toBe('.upwind-build');
    expect(module.exports.entries?.['/one']?.()).toBe(retry);
  });
});
