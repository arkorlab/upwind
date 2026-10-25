import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nativeLoaderBinary, nativeLoaderSelectorKeys } from '../src/native-loaders.ts';

// Reviewed node-gyp-build@4.8.4; test bytes are never executed.
// https://github.com/prebuild/node-gyp-build/blob/v4.8.4/node-gyp-build.js
const REVIEWED_NODE_GYP =
  "var fs = require('fs')\nvar path = require('path')\nvar os = require('os')\n\n// Workaround to fix webpack's build warnings: 'the request of a dependency is an expression'\nvar runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require // eslint-disable-line\n\nvar vars = (process.config && process.config.variables) || {}\nvar prebuildsOnly = !!process.env.PREBUILDS_ONLY\nvar abi = process.versions.modules // TODO: support old node where this is undef\nvar runtime = isElectron() ? 'electron' : (isNwjs() ? 'node-webkit' : 'node')\n\nvar arch = process.env.npm_config_arch || os.arch()\nvar platform = process.env.npm_config_platform || os.platform()\nvar libc = process.env.LIBC || (isAlpine(platform) ? 'musl' : 'glibc')\nvar armv = process.env.ARM_VERSION || (arch === 'arm64' ? '8' : vars.arm_version) || ''\nvar uv = (process.versions.uv || '').split('.')[0]\n\nmodule.exports = load\n\nfunction load (dir) {\n  return runtimeRequire(load.resolve(dir))\n}\n\nload.resolve = load.path = function (dir) {\n  dir = path.resolve(dir || '.')\n\n  try {\n    var name = runtimeRequire(path.join(dir, 'package.json')).name.toUpperCase().replace(/-/g, '_')\n    if (process.env[name + '_PREBUILD']) dir = process.env[name + '_PREBUILD']\n  } catch (err) {}\n\n  if (!prebuildsOnly) {\n    var release = getFirst(path.join(dir, 'build/Release'), matchBuild)\n    if (release) return release\n\n    var debug = getFirst(path.join(dir, 'build/Debug'), matchBuild)\n    if (debug) return debug\n  }\n\n  var prebuild = resolve(dir)\n  if (prebuild) return prebuild\n\n  var nearby = resolve(path.dirname(process.execPath))\n  if (nearby) return nearby\n\n  var target = [\n    'platform=' + platform,\n    'arch=' + arch,\n    'runtime=' + runtime,\n    'abi=' + abi,\n    'uv=' + uv,\n    armv ? 'armv=' + armv : '',\n    'libc=' + libc,\n    'node=' + process.versions.node,\n    process.versions.electron ? 'electron=' + process.versions.electron : '',\n    typeof __webpack_require__ === 'function' ? 'webpack=true' : '' // eslint-disable-line\n  ].filter(Boolean).join(' ')\n\n  throw new Error('No native build was found for ' + target + '\\n    loaded from: ' + dir + '\\n')\n\n  function resolve (dir) {\n    // Find matching \"prebuilds/<platform>-<arch>\" directory\n    var tuples = readdirSync(path.join(dir, 'prebuilds')).map(parseTuple)\n    var tuple = tuples.filter(matchTuple(platform, arch)).sort(compareTuples)[0]\n    if (!tuple) return\n\n    // Find most specific flavor first\n    var prebuilds = path.join(dir, 'prebuilds', tuple.name)\n    var parsed = readdirSync(prebuilds).map(parseTags)\n    var candidates = parsed.filter(matchTags(runtime, abi))\n    var winner = candidates.sort(compareTags(runtime))[0]\n    if (winner) return path.join(prebuilds, winner.file)\n  }\n}\n\nfunction readdirSync (dir) {\n  try {\n    return fs.readdirSync(dir)\n  } catch (err) {\n    return []\n  }\n}\n\nfunction getFirst (dir, filter) {\n  var files = readdirSync(dir).filter(filter)\n  return files[0] && path.join(dir, files[0])\n}\n\nfunction matchBuild (name) {\n  return /\\.node$/.test(name)\n}\n\nfunction parseTuple (name) {\n  // Example: darwin-x64+arm64\n  var arr = name.split('-')\n  if (arr.length !== 2) return\n\n  var platform = arr[0]\n  var architectures = arr[1].split('+')\n\n  if (!platform) return\n  if (!architectures.length) return\n  if (!architectures.every(Boolean)) return\n\n  return { name, platform, architectures }\n}\n\nfunction matchTuple (platform, arch) {\n  return function (tuple) {\n    if (tuple == null) return false\n    if (tuple.platform !== platform) return false\n    return tuple.architectures.includes(arch)\n  }\n}\n\nfunction compareTuples (a, b) {\n  // Prefer single-arch prebuilds over multi-arch\n  return a.architectures.length - b.architectures.length\n}\n\nfunction parseTags (file) {\n  var arr = file.split('.')\n  var extension = arr.pop()\n  var tags = { file: file, specificity: 0 }\n\n  if (extension !== 'node') return\n\n  for (var i = 0; i < arr.length; i++) {\n    var tag = arr[i]\n\n    if (tag === 'node' || tag === 'electron' || tag === 'node-webkit') {\n      tags.runtime = tag\n    } else if (tag === 'napi') {\n      tags.napi = true\n    } else if (tag.slice(0, 3) === 'abi') {\n      tags.abi = tag.slice(3)\n    } else if (tag.slice(0, 2) === 'uv') {\n      tags.uv = tag.slice(2)\n    } else if (tag.slice(0, 4) === 'armv') {\n      tags.armv = tag.slice(4)\n    } else if (tag === 'glibc' || tag === 'musl') {\n      tags.libc = tag\n    } else {\n      continue\n    }\n\n    tags.specificity++\n  }\n\n  return tags\n}\n\nfunction matchTags (runtime, abi) {\n  return function (tags) {\n    if (tags == null) return false\n    if (tags.runtime && tags.runtime !== runtime && !runtimeAgnostic(tags)) return false\n    if (tags.abi && tags.abi !== abi && !tags.napi) return false\n    if (tags.uv && tags.uv !== uv) return false\n    if (tags.armv && tags.armv !== armv) return false\n    if (tags.libc && tags.libc !== libc) return false\n\n    return true\n  }\n}\n\nfunction runtimeAgnostic (tags) {\n  return tags.runtime === 'node' && tags.napi\n}\n\nfunction compareTags (runtime) {\n  // Precedence: non-agnostic runtime, abi over napi, then by specificity.\n  return function (a, b) {\n    if (a.runtime !== b.runtime) {\n      return a.runtime === runtime ? -1 : 1\n    } else if (a.abi !== b.abi) {\n      return a.abi ? -1 : 1\n    } else if (a.specificity !== b.specificity) {\n      return a.specificity > b.specificity ? -1 : 1\n    } else {\n      return 0\n    }\n  }\n}\n\nfunction isNwjs () {\n  return !!(process.versions && process.versions.nw)\n}\n\nfunction isElectron () {\n  if (process.versions && process.versions.electron) return true\n  if (process.env.ELECTRON_RUN_AS_NODE) return true\n  return typeof window !== 'undefined' && window.process && window.process.type === 'renderer'\n}\n\nfunction isAlpine (platform) {\n  return platform === 'linux' && fs.existsSync('/etc/alpine-release')\n}\n\n// Exposed for unit tests\n// TODO: move to lib\nload.parseTags = parseTags\nload.matchTags = matchTags\nload.compareTags = compareTags\nload.parseTuple = parseTuple\nload.matchTuple = matchTuple\nload.compareTuples = compareTuples\n";

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
    for (const key of await nativeLoaderSelectorKeys(entry)) vi.stubEnv(key, '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function selected(owned: readonly string[]) {
    const entries = owned.map((file, index) => [String(index), file]);
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
    const binary = await selected([release, debug]);
    const blob = createHash('sha1')
      .update(`blob ${Buffer.byteLength(REVIEWED_NODE_GYP)}\0`)
      .update(REVIEWED_NODE_GYP)
      .digest('hex');

    expect({ binary, blob }).toEqual({
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
});
