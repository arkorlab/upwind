import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { nodeModuleAliases } from '../src/node-module-aliases.ts';
import type { NodePhysicalLayout } from '../src/node-physical-layout.ts';

const directories: string[] = [];
const DEPENDENCY = 'authored-required-dependency';
const SUBDEPENDENCY = 'authored-required-subdependency';

async function fixture(code = 'exports.value=42;', extension: 'cjs' | 'mjs' = 'cjs') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-required-alias-'));
  const root = await realpath(temporary);
  directories.push(root);
  const entry = path.join(root, `entry.${extension}`);
  await writeFile(entry, code);
  await mkdir(path.join(root, 'node_modules'));
  const layout: NodePhysicalLayout = {
    root,
    traceRoot: root,
    distDir: undefined,
    cwd: 'project',
    nameOf(file) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (relative.startsWith('../')) throw new Error('Unexpected authored path escape');
      return `project/${relative}`;
    },
  };
  const required = new Set([entry]);
  const sources = {
    originals: new Map([[entry, layout.nameOf(entry)]]),
    files: new Map([[layout.nameOf(entry), new TextEncoder().encode(code)]]),
    required,
  };
  return { root, entry, required, layout, sources, links: new Map<string, string>() };
}

async function copiedSource(
  own: Awaited<ReturnType<typeof fixture>>,
  relative: string,
  code: string,
): Promise<string> {
  const file = path.join(own.root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, code);
  const name = own.layout.nameOf(file);
  own.sources.originals.set(file, name);
  own.sources.files.set(name, new TextEncoder().encode(code));
  return file;
}

async function packageAlias(
  own: Awaited<ReturnType<typeof fixture>>,
  target: string,
  name = DEPENDENCY,
): Promise<string> {
  const alias = path.join(own.root, 'node_modules', `${name}.js`);
  await symlink(path.relative(path.dirname(alias), target), alias);
  return alias;
}

async function unclosedDependency(own: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const file = path.join(own.root, 'node_modules', SUBDEPENDENCY, 'index.js');
  await mkdir(path.dirname(file), { recursive: true });
  // This tiny source is inspected as filesystem data; it is never imported or evaluated.
  await writeFile(file, 'exports.unclosed=true;');
  return file;
}

describe('required Node alias closure from authored source bytes and tiny FS data', () => {
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it('promotes a required target from trace-only sources and rejects its unclosed dependency', async () => {
    const own = await fixture(`require('${DEPENDENCY}');`);
    const dependency = await copiedSource(
      own,
      'store/dependency.cjs',
      `require('${SUBDEPENDENCY}');`,
    );
    await packageAlias(own, dependency);
    await unclosedDependency(own);

    await expect(nodeModuleAliases(own.sources, own.layout, own.links)).rejects.toThrow(
      'The first existing Node package target is outside its closed trace',
    );
  });

  it('recursively promotes multiple levels of required copied targets', async () => {
    const own = await fixture(`require('${DEPENDENCY}');`);
    const first = await copiedSource(own, 'store/first.cjs', `require('${SUBDEPENDENCY}');`);
    const second = await copiedSource(own, 'store/second.cjs', 'exports.value=42;');
    await packageAlias(own, first);
    await packageAlias(own, second, SUBDEPENDENCY);

    await nodeModuleAliases(own.sources, own.layout, own.links);

    expect(own.links.get(`project/node_modules/${DEPENDENCY}.js`)).toBe('project/store/first.cjs');
    expect(own.links.get(`project/node_modules/${SUBDEPENDENCY}.js`)).toBe(
      'project/store/second.cjs',
    );
  });

  it.each([
    {
      label: 'package main',
      extension: 'cjs',
      code: `require('${DEPENDENCY}');`,
      metadata: { name: DEPENDENCY, main: './main.cjs' },
      leaf: 'main.cjs',
      dependencyCode: `require('${SUBDEPENDENCY}');`,
    },
    {
      label: 'package index',
      extension: 'cjs',
      code: `require('${DEPENDENCY}');`,
      metadata: { name: DEPENDENCY },
      leaf: 'index.js',
      dependencyCode: `require('${SUBDEPENDENCY}');`,
    },
    {
      label: 'canonical require exports',
      extension: 'cjs',
      code: `require('${DEPENDENCY}');`,
      metadata: {
        name: DEPENDENCY,
        exports: { require: './require.cjs', import: './import.mjs' },
      },
      leaf: 'require.cjs',
      dependencyCode: `require('${SUBDEPENDENCY}');`,
    },
    {
      label: 'canonical import exports',
      extension: 'mjs',
      code: `import '${DEPENDENCY}';`,
      metadata: {
        name: DEPENDENCY,
        exports: { require: './require.cjs', import: './import.mjs' },
      },
      leaf: 'import.mjs',
      dependencyCode: `import '${SUBDEPENDENCY}';`,
    },
  ] as const)('promotes the exact $label entry even when it needs no symlink', async (row) => {
    const own = await fixture(row.code, row.extension);
    const directory = `node_modules/${DEPENDENCY}`;
    await copiedSource(own, `${directory}/package.json`, JSON.stringify(row.metadata));
    await copiedSource(own, `${directory}/require.cjs`, 'exports.value=42;');
    await copiedSource(own, `${directory}/import.mjs`, 'export const value=42;');
    await copiedSource(own, `${directory}/${row.leaf}`, row.dependencyCode);
    await unclosedDependency(own);

    await expect(nodeModuleAliases(own.sources, own.layout, own.links)).rejects.toThrow(
      'The first existing Node package target is outside its closed trace',
    );
  });

  it('does not promote the unused import condition of a required CommonJS package', async () => {
    const own = await fixture(`require('${DEPENDENCY}');`);
    const directory = `node_modules/${DEPENDENCY}`;
    await copiedSource(
      own,
      `${directory}/package.json`,
      JSON.stringify({
        name: DEPENDENCY,
        exports: { require: './require.cjs', import: './import.mjs' },
      }),
    );
    await copiedSource(own, `${directory}/require.cjs`, 'exports.value=42;');
    await copiedSource(own, `${directory}/import.mjs`, `import '${SUBDEPENDENCY}';`);
    await unclosedDependency(own);

    await expect(nodeModuleAliases(own.sources, own.layout, own.links)).resolves.toBeUndefined();
  });

  it('does not make an unreachable trace-only JS import a required refusal', async () => {
    const own = await fixture();
    await copiedSource(own, 'trace-only.cjs', `require('${SUBDEPENDENCY}');`);
    await unclosedDependency(own);

    await expect(nodeModuleAliases(own.sources, own.layout, own.links)).resolves.toBeUndefined();
    expect(own.links.size).toBe(0);
  });

  it('does not turn a successful trace-only layout hint into a strict transitive root', async () => {
    const own = await fixture();
    await copiedSource(own, 'trace-only.cjs', `require('${DEPENDENCY}');`);
    const dependency = await copiedSource(
      own,
      'store/dependency.cjs',
      `require('${SUBDEPENDENCY}');`,
    );
    await packageAlias(own, dependency);
    await unclosedDependency(own);

    await expect(nodeModuleAliases(own.sources, own.layout, own.links)).resolves.toBeUndefined();
  });

  it('does not let a trace-only hint replace an already required alias', async () => {
    const own = await fixture(`require('${DEPENDENCY}');`);
    const first = await copiedSource(own, 'store/first.cjs', 'exports.value=1;');
    const second = await copiedSource(own, 'store/second.cjs', 'exports.value=2;');
    await copiedSource(own, 'trace-only.cjs', `require('${DEPENDENCY}');`);
    const alias = await packageAlias(own, first);

    await nodeModuleAliases(own.sources, own.layout, own.links, async () => {
      await rm(alias);
      await symlink(path.relative(path.dirname(alias), second), alias);
    });

    expect(own.links.get(`project/node_modules/${DEPENDENCY}.js`)).toBe('project/store/first.cjs');
  });

  it('retains legacy all-sources-strict behavior when the required inventory is undefined', async () => {
    const own = await fixture();
    await copiedSource(own, 'trace-only.cjs', `require('${SUBDEPENDENCY}');`);
    await unclosedDependency(own);
    const legacy = { originals: own.sources.originals, files: own.sources.files };

    await expect(nodeModuleAliases(legacy, own.layout, own.links)).rejects.toThrow(
      'The first existing Node package target is outside its closed trace',
    );
  });

  it.each([
    { style: 'legacy required/native callback', option: 'callback' },
    { style: 'options required/native callback', option: 'options' },
  ] as const)('keeps $style failure hard', async ({ option }) => {
    const own = await fixture();
    await copiedSource(own, 'trace-only.cjs', `require('${SUBDEPENDENCY}');`);
    await unclosedDependency(own);
    const error = new AuditError('authored required/native collection failure');
    const callback = () => Promise.reject(error);
    const choices = { callback, options: { collectRequiredAliases: callback } };

    await expect(
      nodeModuleAliases(own.sources, own.layout, own.links, choices[option]),
    ).rejects.toBe(error);
  });

  it('keeps the caller-owned required inventory unchanged during recursive promotion', async () => {
    const own = await fixture(`require('${DEPENDENCY}');`);
    const dependency = await copiedSource(own, 'store/dependency.cjs', 'exports.value=42;');
    await packageAlias(own, dependency);
    const before = [...own.required];
    Object.freeze(own.required);

    await nodeModuleAliases(own.sources, own.layout, own.links);

    expect([...own.required]).toStrictEqual(before);
    expect(own.required.has(dependency)).toBe(false);
  });

  it('propagates an unknown I/O-shaped error even from a trace-only hint', async () => {
    const own = await fixture();
    await copiedSource(own, 'trace-only.cjs', `require('${DEPENDENCY}');`);
    const dependency = await copiedSource(own, 'store/dependency.cjs', 'exports.value=42;');
    await packageAlias(own, dependency);
    const error = Object.assign(new Error('authored I/O failure'), { code: 'EIO' });
    const layout = {
      ...own.layout,
      nameOf(file: string) {
        if (file === dependency) throw error;
        return own.layout.nameOf(file);
      },
    };

    await expect(nodeModuleAliases(own.sources, layout, own.links)).rejects.toBe(error);
  });
});
