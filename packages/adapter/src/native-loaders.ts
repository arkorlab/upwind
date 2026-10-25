import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';

const FIXTURE_BINDINGS = 'fd4a2e414af0b19ae18ef43baed3eaa37a918db5';
const NODE_GYP_INDEX = '07eb14ffd8045c07d69a8acc15bb97b6ea3d1217';
const NODE_GYP_RUNTIME = '76b96e107474cdd79394262b65ac286db36353e8';
const LOADER_BLOBS: Readonly<Record<string, readonly string[]>> = {
  bindings: ['727413a19969f773d01a2d18f8f42d892cf8fabe', FIXTURE_BINDINGS],
  'node-gyp-build': [NODE_GYP_RUNTIME, NODE_GYP_INDEX],
};
const KIB = 1024;
const MAX_PACKAGE_METADATA_BYTES = 128 * KIB;
const NODE_GYP_SELECTORS = [
  'PREBUILDS_ONLY',
  'npm_config_arch',
  'npm_config_platform',
  'LIBC',
  'ARM_VERSION',
  'ELECTRON_RUN_AS_NODE',
];

export class UnreviewedNativeLoaderError extends AuditError {
  constructor(message: string) {
    super(message);
    this.name = 'UnreviewedNativeLoaderError';
  }
}

export interface NativeLoaderSource {
  readonly file: string;
  readonly sha256: string;
  readonly gitBlob: string;
}

async function loaderSource(file: string): Promise<NativeLoaderSource> {
  const canonical = await realpath(file);
  const source = await readFile(canonical);
  // eslint-disable-next-line sonarjs/hashing -- SHA-1 is the immutable upstream Git blob identifier, never an authentication digest.
  const gitBlob = createHash('sha1')
    .update(`blob ${source.byteLength}\0`)
    .update(source)
    .digest('hex');
  return { file: canonical, sha256: createHash('sha256').update(source).digest('hex'), gitBlob };
}

async function reviewedLoader(
  name: string,
  importer: string,
): Promise<{ identity: string; sources: readonly NativeLoaderSource[] }> {
  const require = createRequire(importer);
  if (name === 'node-gyp-build' && 'addon' in require)
    throw new AuditError('Custom native resolution is unsupported');
  const resolved = require.resolve(name);
  const source = await loaderSource(resolved);
  const blob = source.gitBlob;
  if (LOADER_BLOBS[name]?.includes(blob) !== true) {
    throw new UnreviewedNativeLoaderError(
      `@stayingupwind/adapter: ${name} has an unreviewed native loader; its dynamic loads cannot be classified`,
    );
  }
  const sources = [source];
  if (name === 'node-gyp-build' && blob === NODE_GYP_INDEX) {
    const runtime = await loaderSource(path.join(path.dirname(resolved), 'node-gyp-build.js'));
    if (runtime.gitBlob !== NODE_GYP_RUNTIME)
      throw new UnreviewedNativeLoaderError('unreviewed node-gyp-build runtime');
    sources.push(runtime);
  }
  return { identity: blob, sources };
}

async function packageRoot(file: string): Promise<string> {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    try {
      if ((await stat(path.join(dir, 'package.json'))).isFile()) return dir;
    } catch {
      /* Keep looking without evaluating package code. */
    }
    if (path.dirname(dir) === dir) throw new AuditError('native loader has no package root');
  }
}

/** The reviewed loader's override keys; values never enter diagnostics or the artifact. */
export async function nativeLoaderSelectorKeys(importer: string): Promise<readonly string[]> {
  const keys = [...NODE_GYP_SELECTORS];
  try {
    const bytes = await readFile(path.join(path.dirname(importer), 'package.json'));
    if (bytes.byteLength > MAX_PACKAGE_METADATA_BYTES)
      throw new AuditError('Native package metadata exceeds its limit');
    const metadata: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      typeof metadata === 'object' &&
      metadata !== null &&
      'name' in metadata &&
      typeof metadata.name === 'string'
    )
      keys.push(`${metadata.name.toUpperCase().replaceAll('-', '_')}_PREBUILD`);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  return keys;
}

async function assertDefaultSelectors(importer: string): Promise<void> {
  const keys = await nativeLoaderSelectorKeys(importer);
  if (keys.some((key) => process.env[key]))
    throw new AuditError('Native loader environment overrides cannot be classified');
}

async function firstExisting(
  candidates: readonly string[],
  owned: ReadonlySet<string>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const actual = await realpath(candidate);
      if (!owned.has(actual) || !(await stat(actual)).isFile())
        throw new AuditError('Native loader first existing binary is not an owned regular file');
      return actual;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function localNodeGypBinary(
  root: string,
  owned: ReadonlySet<string>,
): Promise<string | undefined> {
  for (const folder of ['build/Release', 'build/Debug']) {
    let names: string[];
    try {
      names = (await readdir(path.join(root, folder))).filter((name) => name.endsWith('.node'));
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      continue;
    }
    // readdir order differs between filesystems. A unique candidate proves the same target.
    if (names.length > 1)
      throw new AuditError('Native loader directory has ambiguous binary selection');
    const name = names[0];
    if (name !== undefined) return firstExisting([path.join(root, folder, name)], owned);
  }
  return undefined;
}

export async function nativeLoaderBinary(input: {
  kind: 'bindings' | 'node-gyp-build';
  value: string;
  importer: string;
  traces: readonly NativeAddonEntryTrace[];
}): Promise<{ binary: string; sources: readonly NativeLoaderSource[] }> {
  const { identity, sources } = await reviewedLoader(input.kind, input.importer);
  const owned = new Set(
    await Promise.all(
      input.traces
        .flatMap((trace) => Object.values(trace.assets))
        .filter((file) => file.endsWith('.node'))
        .map((file) => realpath(file)),
    ),
  );
  let binary: string | undefined;
  if (input.kind === 'bindings') {
    if (input.value.includes('/') || input.value.includes('\\'))
      throw new AuditError('native bindings requires one literal binary basename');
    const root = await realpath(await packageRoot(input.importer));
    const name = input.value.endsWith('.node') ? input.value : `${input.value}.node`;
    const folders =
      identity === FIXTURE_BINDINGS ? ['build/Release'] : ['build', 'build/Debug', 'build/Release'];
    binary = await firstExisting(
      folders.map((folder) => path.join(root, folder, name)),
      owned,
    );
  } else {
    await assertDefaultSelectors(input.importer);
    binary = await localNodeGypBinary(await realpath(path.dirname(input.importer)), owned);
  }
  if (binary === undefined)
    throw new AuditError(
      'native loader binary selection is not a single proved target; refusing publication',
    );
  return { binary, sources };
}
