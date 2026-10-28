import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nativeLoadsPlugin, type NativeLoad } from '../src/native-loads.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';
import { nodeNativeAliases } from '../src/node-native-aliases.ts';
import { nodePhysicalLayout } from '../src/node-physical-layout.ts';

const BINARY_BYTES = new Uint8Array([0, 1, 127, 255]);
const SOURCE =
  "const path=require('node:path');module.exports=()=>process.dlopen(module,path.join(__dirname,'addon.node'));\n";

async function stage(physical: NodePhysicalFiles, root: string): Promise<void> {
  for (const file of physical.files) {
    const target = path.join(root, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  for (const link of physical.links) {
    const target = path.join(root, link.path);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.relative(path.dirname(target), path.join(root, link.target)), target);
  }
}

describe('proved dlopen binary aliases with canonical-only traces', () => {
  let directory: string;
  let repository: string;
  let project: string;
  let output: string;
  let entry: string;
  let binary: string;
  let alias: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-dlopen-alias-'));
    directory = await realpath(temporary);
    repository = path.join(directory, 'repository');
    project = path.join(repository, 'app');
    output = path.join(directory, 'output');
    entry = path.join(project, 'entry.cjs');
    binary = path.join(repository, 'store/addon.node');
    alias = path.join(project, 'addon.node');
    await mkdir(project, { recursive: true });
    await mkdir(path.dirname(binary));
    await mkdir(output);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function input(files: readonly string[] = [entry, binary]): BuildFunctionInput {
    // Only the physical packager's input fields are supplied; no application or native code runs.
    return {
      repoRoot: repository,
      projectDir: project,
      patch: { distDir: output },
      entries: [{ id: '/native', filePath: entry }],
      entryTraces: [
        { id: '/native', assets: Object.fromEntries(files.map((file) => [file, file])) },
      ],
      files: [],
      edgeEntries: [],
      manifests: [],
    } as unknown as BuildFunctionInput;
  }

  async function fixture(source = SOURCE, traced = true): Promise<readonly NativeLoad[]> {
    await writeFile(entry, source);
    await writeFile(binary, BINARY_BYTES);
    await symlink(path.relative(path.dirname(alias), binary), alias);
    const tracedBinary = traced ? binary : path.join(path.dirname(binary), 'unrelated.node');
    if (!traced) await writeFile(tracedBinary, BINARY_BYTES);
    const proof = nativeLoadsPlugin([{ id: '/native', assets: { entry, binary: tracedBinary } }], {
      nodeTarget: true,
    });
    // Source-only bundling preserves proof markers; its output is never executed.
    await using build = await rolldown({
      input: entry,
      platform: 'neutral',
      plugins: [proof.plugin],
      external: ['node:path'],
    });
    const generated = await build.generate({ format: 'cjs', exports: 'auto' });
    const chunk = generated.output.find((item): item is OutputChunk => item.type === 'chunk');
    if (chunk === undefined) throw new Error('Expected the authored source chunk');
    const retained = await proof.retained(chunk);
    return retained;
  }

  it('retains the original dlopen path and restores its alias without changing either input byte sequence', async () => {
    const loads = await fixture();
    const physical = await nodePhysicalFiles(input(), loads);
    const archive = path.join(directory, 'archive');
    await stage(physical, archive);

    expect(loads).toStrictEqual([
      { kind: 'dlopen', importer: entry, binary, binaryAlias: alias, owners: ['/native'] },
    ]);
    expect(physical.links).toStrictEqual([
      { path: 'project/app/addon.node', target: 'project/store/addon.node' },
    ]);
    await expect(readFile(path.join(archive, 'project/app/addon.node'))).resolves.toStrictEqual(
      Buffer.from(BINARY_BYTES),
    );
    await expect(readFile(path.join(archive, 'project/app/entry.cjs'), 'utf8')).resolves.toBe(
      SOURCE,
    );
    await expect(readFile(binary)).resolves.toStrictEqual(Buffer.from(BINARY_BYTES));
    await expect(readFile(entry, 'utf8')).resolves.toBe(SOURCE);
  });

  it('keeps an external distDir alias and its target aligned inside the relocated output namespace', async () => {
    entry = path.join(output, 'server/entry.cjs');
    alias = path.join(output, 'server/addon.node');
    binary = path.join(output, 'store/addon.node');
    await mkdir(path.dirname(entry));
    await mkdir(path.dirname(binary));
    const physical = await nodePhysicalFiles(input(), await fixture());

    expect(physical.links).toStrictEqual([
      {
        path: 'project/app/.upwind-build/server/addon.node',
        target: 'project/app/.upwind-build/store/addon.node',
      },
    ]);
  });

  it('refuses absolute source operands instead of introducing a build-machine path into the artifact', async () => {
    const source = `const path=require('node:path');module.exports=()=>process.dlopen(module,path.resolve(__dirname,${jsLiteral(alias)}));`;

    await expect(fixture(source)).rejects.toThrow('no statically known native binary');
  });

  it('refuses a traced symlink target outside both admitted namespaces', async () => {
    binary = path.join(directory, 'outside.node');
    const loads = await fixture();

    await expect(nodePhysicalFiles(input(), loads)).rejects.toThrow(
      'escapes both its tracing root and build output',
    );
  });

  it('refuses an original alias outside both admitted namespaces even when its canonical target is owned', async () => {
    alias = path.join(directory, 'outside.node');
    const relative = path.relative(path.dirname(entry), alias);
    const source = `const path=require('node:path');module.exports=()=>process.dlopen(module,path.join(__dirname,${jsLiteral(relative)}));`;
    const loads = await fixture(source);

    await expect(nodePhysicalFiles(input(), loads)).rejects.toThrow(
      'escapes both its tracing root and build output',
    );
  });

  it('does not turn an untraced binary into a proved dlopen or a new physical input', async () => {
    await expect(fixture(SOURCE, false)).rejects.toThrow('no owned, regular-file binary');
  });

  it('refuses a proved alias when the canonical target is omitted from the physical closed set', async () => {
    const loads = await fixture();

    await expect(nodePhysicalFiles(input([entry]), loads)).rejects.toThrow(
      'no closed physical target or importer',
    );
  });

  it('refuses a symlink retargeted after the retained-load proof', async () => {
    const loads = await fixture();
    const other = path.join(repository, 'store/other.node');
    await writeFile(other, BINARY_BYTES);
    await unlink(alias);
    await symlink(other, alias);

    await expect(nodePhysicalFiles(input([entry, binary, other]), loads)).rejects.toThrow(
      'changed physical target',
    );
  });

  it('preserves the existing refusal for native relative topology crossing an external distDir relocation', async () => {
    entry = path.join(output, 'entry.cjs');
    alias = path.join(output, 'addon.node');
    const loads = await fixture();

    await expect(nodePhysicalFiles(input(), loads)).rejects.toThrow('relocation changes');
  });

  it('refuses a native alias that would shadow an existing physical artifact input', async () => {
    entry = path.join(output, 'server/entry.cjs');
    alias = path.join(output, 'server/addon.node');
    binary = path.join(output, 'store/addon.node');
    const shadow = path.join(project, '.upwind-build/server/addon.node');
    await mkdir(path.dirname(entry));
    await mkdir(path.dirname(binary));
    await mkdir(path.dirname(shadow), { recursive: true });
    await writeFile(shadow, BINARY_BYTES);
    const loads = await fixture();

    await expect(nodePhysicalFiles(input([entry, binary, shadow]), loads)).rejects.toThrow(
      'conflicts with a physical input',
    );
  });

  it.each(['relative', 'non-dlopen'] as const)(
    'refuses forged %s alias metadata rather than inferring a new lookup origin',
    async (mode) => {
      const loads = (await fixture()).map((load) => {
        return mode === 'relative'
          ? { ...load, binaryAlias: 'addon.node' }
          : { ...load, kind: 'direct' as const };
      });
      const reason =
        mode === 'relative' ? 'requires an absolute proved filename' : 'not a proved dlopen lookup';

      await expect(nodePhysicalFiles(input(), loads)).rejects.toThrow(reason);
    },
  );

  it.each(['exact', 'ancestor', 'descendant'] as const)(
    'refuses a conflicting existing %s link instead of silently dropping the native alias',
    async (mode) => {
      const loads = await fixture();
      const layout = await nodePhysicalLayout(input());
      const sources = {
        files: new Map([
          [layout.nameOf(binary), BINARY_BYTES],
          [layout.nameOf(entry), new TextEncoder().encode(SOURCE)],
        ]),
        originals: new Map([
          [binary, layout.nameOf(binary)],
          [entry, layout.nameOf(entry)],
        ]),
      };
      const name = layout.nameOf(alias);
      const paths = {
        exact: name,
        ancestor: path.posix.dirname(name),
        descendant: `${name}/child`,
      };
      const links = new Map([[paths[mode], 'project/other']]);

      await expect(nodeNativeAliases(loads, sources, layout, links)).rejects.toThrow('conflicts');
    },
  );
});
