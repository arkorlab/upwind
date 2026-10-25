import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { sha256Hex } from '@stayingupwind/core/artifact';

import { appEntrySource } from './app-entry.ts';
import { jsLiteral } from './codegen.ts';
import { AuditError } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';
import type { NativeLoad } from './native-loads.ts';
import type { NodeArchiveFile } from './node-archive.ts';
import type { NodePhysicalFiles } from './node-files.ts';
import {
  assertNodeNextRewriteArchive,
  rewriteCertifiedNodeNextFile,
  sealNodeInstrumentationBundle,
  type NodeNextRewriteProof,
} from './node-next-rewrite-proof.ts';
import type { NodeFunctionProof } from './node-proof.ts';
import { fetchCacheWaitUntilPatch } from './patches/fetch-cache-wait-until.ts';
import { resourceCacheBridgePatch } from './patches/resource-cache-bridge.ts';

/** Only shared-cache/render semantics. No Worker loader, VM, native, fs or process substitutes. */
const NODE_PATCHES = [fetchCacheWaitUntilPatch, resourceCacheBridgePatch];
const ELF_HEADER_BYTES = 64;
const ELF_MAGIC_START = 0x7f;
const ELF_MAGIC_E = 0x45;
const ELF_MAGIC_L = 0x4c;
const ELF_MAGIC_F = 0x46;
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_PREFIX = [
  ELF_MAGIC_START,
  ELF_MAGIC_E,
  ELF_MAGIC_L,
  ELF_MAGIC_F,
  ELF_CLASS_64,
  ELF_DATA_LITTLE_ENDIAN,
] as const;
const ELF_MACHINE_OFFSET = 18;
const ELF_X64_MACHINE = 62;
type EntryNormalization = NonNullable<NodeFunctionProof['normalization']>;

async function assertEntryNormalization(
  input: BuildFunctionInput,
  seal: EntryNormalization,
  physical: NodePhysicalFiles,
): Promise<void> {
  if (
    path.resolve(input.patch.distDir) !== seal.distDir ||
    (await realpath(input.patch.distDir)) !== seal.canonicalDistDir ||
    input.entries.length !== seal.entries.length
  )
    throw new AuditError('The Node manifest normalization contract changed before packaging');
  if (seal.runtimeRootDir !== undefined) {
    const root = await realpath(input.repoRoot ?? input.projectDir);
    const original = path
      .relative(seal.canonicalDistDir, seal.runtimeRootDir)
      .split(path.sep)
      .join('/');
    const relocated = path.posix.relative(
      physical.nameOf(seal.canonicalDistDir),
      physical.nameOf(seal.runtimeRootDir),
    );
    if (original !== relocated || root !== seal.runtimeRootDir)
      throw new AuditError('Native Function relocation changes the sealed Turbopack runtime root');
  }
  const ids = new Set<string>();
  for (const [index, entry] of input.entries.entries()) {
    const expected = seal.entries[index];
    if (
      expected === undefined ||
      ids.has(entry.id) ||
      entry.id !== expected.id ||
      entry.filePath !== expected.filePath ||
      (await realpath(entry.filePath)) !== expected.canonicalFilePath
    )
      throw new AuditError('The Node route entry changed after its manifest consumer proof');
    ids.add(entry.id);
  }
}

function nativeElf(bytes: Uint8Array): void {
  if (
    bytes.byteLength < ELF_HEADER_BYTES ||
    ELF_PREFIX.some((value, index) => bytes[index] !== value) ||
    bytes[ELF_MACHINE_OFFSET] !== ELF_X64_MACHINE ||
    bytes[ELF_MACHINE_OFFSET + 1] !== 0
  )
    throw new AuditError('Native Function binary is not a Linux x64 ELF object');
}

function wasmSource(module: BuildFunctionInput['wasm']['modules'][number]): string {
  const variable = `m_${module.sha256}`;
  const relative = jsLiteral(`./wasm/${module.sha256}.wasm`);
  const globals = module.globals
    .map((global) => `globalThis[${jsLiteral(global)}]??=${variable};`)
    .join('');
  return `const ${variable}=new WebAssembly.Module(readFileSync(new URL(${relative},import.meta.url)));${globals}`;
}

function rewrittenNextFile(
  file: NodeArchiveFile,
  input: BuildFunctionInput,
  settings: {
    readonly patchContext: BuildFunctionInput['patch'];
    readonly physical: NodePhysicalFiles;
    readonly proof: NodeNextRewriteProof | undefined;
  },
): NodeArchiveFile | undefined {
  const { physical, proof, patchContext } = settings;
  const original =
    physical.sourcePaths.get(file.name) ??
    (file.name.startsWith('project/')
      ? path.join(input.repoRoot ?? input.projectDir, file.name.slice('project/'.length))
      : undefined);
  if (original === undefined || !/\.[cm]?js$/u.test(original)) return undefined;
  const source = Buffer.from(file.bytes).toString('utf8');
  const certified = rewriteCertifiedNodeNextFile(proof, input, {
    file: original,
    name: file.name,
    code: source,
  });
  let contents = certified ?? source;
  if (certified === undefined) {
    for (const patch of NODE_PATCHES) {
      if (patch.target.test(original) && (patch.marker === undefined || patch.marker(contents)))
        contents = patch.apply(contents, original, patchContext).contents;
    }
  }
  if (contents === source) return undefined;
  return { ...file, bytes: new TextEncoder().encode(contents) };
}

/** Physical app files plus explicit generated metadata, all constructed during the build. */
export class NodeArtifactFiles {
  #normalizedEntry: string | undefined;
  readonly #nextRewrites: NodeNextRewriteProof | undefined;
  readonly files: Map<string, NodeArchiveFile>;
  readonly input: BuildFunctionInput;
  readonly physical: NodePhysicalFiles;
  readonly native: readonly NativeLoad[];

  constructor(
    input: BuildFunctionInput,
    physical: NodePhysicalFiles,
    native: readonly NativeLoad[],
    nextRewrites?: NodeNextRewriteProof,
  ) {
    this.input = input;
    this.physical = physical;
    this.native = native;
    this.#nextRewrites = nextRewrites;
    this.files = new Map(physical.files.map((file) => [file.name, file]));
  }

  add(name: string, bytes: Uint8Array): void {
    const previous = this.files.get(name);
    if (previous !== undefined) {
      if (Buffer.compare(previous.bytes, bytes) !== 0)
        throw new AuditError('Node artifact generated metadata conflicts with a physical input');
      return;
    }
    this.files.set(name, { name, bytes });
  }

  text(name: string, value: string): void {
    this.add(name, new TextEncoder().encode(value));
  }

  /** Called only after the original-source/physical-byte proof has succeeded. */
  rewriteNextFiles(): void {
    const patchContext = {
      ...this.input.patch,
      instrumentation:
        this.input.patch.instrumentation === undefined
          ? undefined
          : '/bundle/upwind/instrumentation.cjs',
    };
    for (const file of this.physical.files) {
      const rewritten = rewrittenNextFile(file, this.input, {
        patchContext,
        physical: this.physical,
        proof: this.#nextRewrites,
      });
      if (rewritten !== undefined) this.files.set(file.name, rewritten);
    }
  }

  sealInstrumentation(originals: ReadonlyMap<string, string>, bytes: Uint8Array): void {
    sealNodeInstrumentationBundle(this.#nextRewrites, this.input, this.physical, {
      originals,
      bytes,
    });
  }

  async assertNextRewrites(): Promise<void> {
    await assertNodeNextRewriteArchive(
      this.#nextRewrites,
      this.input,
      this.files,
      this.physical.nameOf,
    );
  }

  async addNativeMetadata(): Promise<void> {
    const modules: { path: string; sha256: string }[] = [];
    const binaries = new Set(await Promise.all(this.native.map((load) => realpath(load.binary))));
    for (const binary of binaries) {
      const filename = this.physical.nameOf(binary);
      const bytes = this.files.get(filename)?.bytes;
      if (bytes === undefined)
        throw new AuditError('Selected native binary was omitted from the Node artifact');
      nativeElf(bytes);
      modules.push({ path: filename, sha256: await sha256Hex(bytes) });
    }
    this.text('upwind/native.json', JSON.stringify({ modules }));
    this.text('upwind/links.json', JSON.stringify({ links: this.physical.links }));
    this.text('runtime.json', this.input.runtimeManifest);
  }

  async addNextManifests(): Promise<void> {
    // Next's production entry reads the original JSON manifests from its real dist directory.
    const directories = [this.input.patch.distDir, path.join(this.input.patch.distDir, 'server')];
    for (const dir of directories) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const item of entries) {
        if (!item.isFile() || !item.name.endsWith('.json') || item.name.endsWith('.nft.json'))
          continue;
        const file = path.join(dir, item.name);
        this.add(this.physical.nameOf(file), new Uint8Array(await readFile(file)));
      }
    }
  }

  async addPlatformFiles(): Promise<void> {
    for (const manifest of this.input.manifests) this.text(manifest.name, manifest.contents);
    // Web inline assets and runtime compatibility data keep their existing /bundle names.
    for (const file of this.input.files)
      this.add(file.name, new Uint8Array(await readFile(file.filePath)));
    for (const blob of this.input.blobs) this.add(`blobs/${blob.sha256}`, blob.bytes);
  }

  async addAppEntry(normalization?: EntryNormalization): Promise<void> {
    if (normalization !== undefined)
      await assertEntryNormalization(this.input, normalization, this.physical);
    const dist = this.physical.nameOf(await realpath(this.input.patch.distDir));
    const table = await Promise.all(
      this.input.entries.map(async (entry) => {
        const file = this.physical.nameOf(await realpath(entry.filePath));
        return { id: entry.id, filePath: `/bundle/${file}` };
      }),
    );
    // Node's shared serve layer sets relativeProjectDir='.' and the bootstrap uses this cwd.
    // Next joins that project root with distDir; an absolute value would duplicate /bundle.
    const runtimeDistDir = path.posix.relative(this.physical.cwd, dist) || '.';
    const entry = appEntrySource(table, { external: true, runtimeDistDir, nodeRequestMeta: true });
    const source = `globalThis.AsyncLocalStorage ??= require('node:async_hooks').AsyncLocalStorage;\n${entry}`;
    this.text('upwind/app.cjs', source);
    if (normalization !== undefined) this.#normalizedEntry = source;
  }

  /** The proven analysis root is valid only if the shipped root normalizes the same route table. */
  async assertAppEntryNormalization(normalization?: EntryNormalization): Promise<void> {
    if (normalization === undefined) return;
    await assertEntryNormalization(this.input, normalization, this.physical);
    const bytes = this.files.get('upwind/app.cjs')?.bytes;
    if (
      bytes === undefined ||
      this.#normalizedEntry === undefined ||
      Buffer.compare(Buffer.from(bytes), Buffer.from(this.#normalizedEntry)) !== 0
    )
      throw new AuditError(
        'The physical Node entry no longer enforces its manifest normalization contract',
      );
  }

  addWasm(): void {
    const wasm = this.input.wasm.modules.map((module) => {
      this.add(`upwind/wasm/${module.sha256}.wasm`, module.bytes);
      return wasmSource(module);
    });
    this.text('upwind/wasm.mjs', `import {readFileSync} from 'node:fs';${wasm.join('\n')}`);
  }
}
