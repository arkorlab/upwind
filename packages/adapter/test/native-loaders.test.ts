import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nativeLoaderBinary, nativeLoaderSelectorKeys } from '../src/native-loaders.ts';
import { reviewedNodeGypBuildSource } from './fixtures/native-node-gyp-source.ts';

const REVIEWED_NODE_GYP = reviewedNodeGypBuildSource();

function defaultPrebuildHost(): void {
  vi.stubGlobal('process', {
    ...process,
    platform: 'linux',
    arch: 'x64',
    versions: { node: '24.22.1', modules: '137', uv: '1.0.0' },
    config: { variables: {} },
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.41' } }) },
  });
}

describe('proved native loader selection', () => {
  let directory: string;
  let entry: string;
  let release: string;
  let debug: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-loader-selection-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    entry = path.join(directory, 'entry.cjs');
    release = path.join(directory, 'build/Release/addon.node');
    debug = path.join(directory, 'build/Debug/addon.node');
    const loader = path.join(directory, 'node_modules/node-gyp-build');
    await mkdir(loader, { recursive: true });
    await mkdir(path.dirname(release), { recursive: true });
    await mkdir(path.dirname(debug), { recursive: true });
    await writeFile(entry, 'module.exports=0;\n');
    await writeFile(path.join(directory, 'package.json'), '{"name":"native-package"}\n');
    await writeFile(
      path.join(loader, 'package.json'),
      '{"name":"node-gyp-build","main":"node-gyp-build.js"}\n',
    );
    await writeFile(path.join(loader, 'node-gyp-build.js'), REVIEWED_NODE_GYP);
    // Give every case a defined selector environment without reading the developer's values.
    const selectorKeys = await nativeLoaderSelectorKeys(entry);
    for (const key of selectorKeys) vi.stubEnv(key, '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  async function selected(owned: readonly string[]) {
    const entries = owned.map((file, index) => [String(index), file] as const);
    const assets = { entry, ...Object.fromEntries(entries) };
    return nativeLoaderBinary({
      kind: 'node-gyp-build',
      value: '',
      importer: entry,
      traces: [{ id: '/native', assets }],
    });
  }

  it('binds the reviewed source and selects Release before Debug', async () => {
    await writeFile(release, new Uint8Array([1]));
    await writeFile(debug, new Uint8Array([2]));
    const { binary } = await selected([release, debug]);
    // eslint-disable-next-line sonarjs/hashing -- SHA-1 identifies the pinned upstream Git blob, not an authentication digest.
    const blob = createHash('sha1')
      .update(`blob ${Buffer.byteLength(REVIEWED_NODE_GYP)}\0`)
      .update(REVIEWED_NODE_GYP)
      .digest('hex');

    expect({ binary, blob }).toStrictEqual({
      binary: release,
      blob: '76b96e107474cdd79394262b65ac286db36353e8',
    });
  });

  it('never skips the actual first existing unowned Release binary for owned Debug', async () => {
    await writeFile(release, new Uint8Array([1]));
    await writeFile(debug, new Uint8Array([2]));

    await expect(selected([debug])).rejects.toThrow('first existing binary');
  });

  it('refuses filesystem-order-dependent selection within one directory', async () => {
    const other = path.join(path.dirname(release), 'second.node');
    await writeFile(release, new Uint8Array([1]));
    await writeFile(other, new Uint8Array([2]));

    await expect(selected([release, other])).rejects.toThrow('ambiguous binary selection');
  });

  it('uses the actual caller directory rather than walking to the nearest package root', async () => {
    await writeFile(release, new Uint8Array([1]));
    const nested = path.join(directory, 'nested/entry.cjs');
    await mkdir(path.dirname(nested), { recursive: true });
    await writeFile(nested, 'module.exports=0;\n');

    await expect(
      nativeLoaderBinary({
        kind: 'node-gyp-build',
        value: '',
        importer: nested,
        traces: [{ id: '/native', assets: { nested, release } }],
      }),
    ).rejects.toThrow('single proved target');
  });

  it.each([
    'PREBUILDS_ONLY',
    'npm_config_arch',
    'npm_config_platform',
    'LIBC',
    'ARM_VERSION',
    'ELECTRON_RUN_AS_NODE',
    'NATIVE_PACKAGE_PREBUILD',
  ])('refuses selector override %s before publication', async (key) => {
    await writeFile(release, new Uint8Array([1]));
    vi.stubEnv(key, 'custom');

    await expect(selected([release])).rejects.toThrow('environment overrides');
  });

  async function prebuild(file: string, folder = 'linux-x64'): Promise<string> {
    const binary = path.join(directory, 'prebuilds', folder, file);
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, new Uint8Array([3]));
    return binary;
  }

  it('selects an owned package-local prebuild without evaluating the loader or binary', async () => {
    defaultPrebuildHost();
    const binary = await prebuild('node.napi.glibc.node');

    await expect(selected([binary])).resolves.toMatchObject({ binary });
  });

  it.each([
    'PREBUILDS_ONLY',
    'npm_config_arch',
    'npm_config_platform',
    'LIBC',
    'ARM_VERSION',
    'ELECTRON_RUN_AS_NODE',
    'NATIVE_PACKAGE_PREBUILD',
  ])('refuses configured prebuild selector %s rather than certifying its default', async (key) => {
    defaultPrebuildHost();
    const binary = await prebuild('node.napi.node');
    vi.stubEnv(key, 'custom');

    await expect(selected([binary])).rejects.toThrow('environment overrides');
  });

  it('keeps Release before even an ambiguous prebuild directory', async () => {
    await writeFile(release, new Uint8Array([1]));
    const first = await prebuild('first.node.napi.node');
    const second = await prebuild('second.node.napi.node');

    await expect(selected([release, first, second])).resolves.toMatchObject({ binary: release });
  });

  it('does not skip an unowned winning prebuild for a lower-priority owned binary', async () => {
    defaultPrebuildHost();
    await prebuild('node.abi137.node');
    const fallback = await prebuild('node.napi.node');

    await expect(selected([fallback])).rejects.toThrow('first existing binary');
  });

  it('refuses an unproved selected prebuild symlink even when its target is owned', async () => {
    defaultPrebuildHost();
    const binary = path.join(directory, 'canonical.node');
    const alias = path.join(directory, 'prebuilds/linux-x64/node.napi.node');
    await writeFile(binary, new Uint8Array([3]));
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(binary, alias);

    await expect(selected([binary])).rejects.toThrow('unproved internal alias');
  });

  it('does not fall back to another matching tuple after the selected tuple has no binary', async () => {
    defaultPrebuildHost();
    await mkdir(path.join(directory, 'prebuilds/linux-x64'), { recursive: true });
    const other = await prebuild('node.napi.node', 'linux-x64+arm64');

    await expect(selected([other])).rejects.toThrow('single proved target');
  });

  it('refuses a non-directory selected tuple instead of hiding a filesystem error', async () => {
    defaultPrebuildHost();
    await mkdir(path.join(directory, 'prebuilds'), { recursive: true });
    await writeFile(path.join(directory, 'prebuilds/linux-x64'), 'not a directory');

    await expect(selected([])).rejects.toThrow('ENOTDIR');
  });

  it.each(['platform', 'arch', 'electron', 'nw', 'libc', 'arm', 'window', 'webpack'])(
    'refuses the unsupported prebuild host selector %s',
    async (selector) => {
      defaultPrebuildHost();
      switch (selector) {
        case 'platform': {
          vi.stubGlobal('process', { ...process, platform: 'darwin' });
          break;
        }
        case 'arch': {
          vi.stubGlobal('process', { ...process, arch: 'arm64' });
          break;
        }
        case 'electron':
        case 'nw': {
          vi.stubGlobal('process', {
            ...process,
            versions: { ...process.versions, [selector]: '1.0.0' },
          });
          break;
        }
        case 'libc': {
          vi.stubGlobal('process', {
            ...process,
            report: { getReport: () => ({ header: {} }) },
          });
          break;
        }
        case 'arm': {
          vi.stubGlobal('process', { ...process, config: { variables: { arm_version: 7 } } });
          break;
        }
        case 'window': {
          vi.stubGlobal('window', { process: { type: 'renderer' } });
          break;
        }
        default: {
          vi.stubGlobal('__webpack_require__', vi.fn());
        }
      }
      const binary = await prebuild('node.napi.node');

      await expect(selected([binary])).rejects.toThrow('default Node Linux x64 glibc host');
    },
  );
});
