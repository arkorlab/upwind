import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import {
  nodeAliasLookupError,
  nodeAliasOutsideTrace,
  OUTSIDE_CLOSED_TRACE,
} from '../src/node-alias-diagnostics.ts';
import { nodeModuleAliases } from '../src/node-module-aliases.ts';
import type { NodePhysicalLayout } from '../src/node-physical-layout.ts';

const directories: string[] = [];
const ROOT = '/authored/project';

function diagnostic(value: unknown): AuditError {
  if (!(value instanceof AuditError)) throw new Error('Expected authored AuditError');
  return value;
}
async function rejected(run: () => Promise<void>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an authored lookup refusal');
}

async function fixture(kind: 'require' | 'import' = 'require', optional = false) {
  const prefix = path.join(tmpdir(), 'node-alias-diagnostic-');
  const root = await realpath(await mkdtemp(prefix));
  directories.push(root);
  const file = path.join(root, 'src', kind === 'require' ? 'entry.cjs' : 'entry.mjs');
  await mkdir(path.dirname(file));
  await mkdir(path.join(root, 'node_modules'));
  const call = kind === 'require' ? 'require("dep");' : 'import "dep";';
  const code = optional ? `if(process.env.NODE_ENV!=="production"){${call}}` : call;
  // Only source inventory and filesystem metadata are inspected; this file is never loaded.
  await writeFile(file, code);
  const layout: NodePhysicalLayout = {
    root,
    traceRoot: root,
    distDir: undefined,
    cwd: 'project',
    nameOf(target) {
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (relative.startsWith('../')) throw new Error('Unexpected authored path escape');
      return `project/${relative}`;
    },
  };
  const sources = {
    originals: new Map([[file, layout.nameOf(file)]]),
    files: new Map([[layout.nameOf(file), new TextEncoder().encode(code)]]),
  };
  return { root, file, layout, sources, links: new Map<string, string>() };
}
async function unclosed(own: Awaited<ReturnType<typeof fixture>>, directory = false) {
  const target = path.join(own.root, directory ? 'store/pkg' : 'store/target.cjs');
  await mkdir(path.dirname(target), { recursive: true });
  if (directory) {
    await mkdir(target);
    await writeFile(path.join(target, 'index.js'), 'module.exports="never loaded";');
  } else await writeFile(target, 'module.exports="never loaded";');
  const alias = path.join(own.root, 'node_modules', directory ? 'dep' : 'dep.js');
  await symlink(path.relative(path.dirname(alias), target), alias);
  return target;
}

describe('required Node alias diagnostics from authored data and FS only', () => {
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it('keeps the inner refusal exact and stores its target only in private metadata', () => {
    const target = `${ROOT}/store/unclosed.cjs`;
    const error = nodeAliasOutsideTrace(target);
    const wrapped = diagnostic(
      nodeAliasLookupError(error, ROOT, `${ROOT}/src/entry.cjs`, {
        kind: 'require',
        specifier: 'dep',
      }),
    );

    expect(error.message).toBe(OUTSIDE_CLOSED_TRACE);
    expect(Object.getOwnPropertyNames(error)).not.toContain('target');
    expect(JSON.stringify(error)).not.toContain(target);
    expect(wrapped.message).toBe(
      `${OUTSIDE_CLOSED_TRACE} (importer="src/entry.cjs", specifier="dep", kind="require", target="store/unclosed.cjs")`,
    );
    expect(wrapped.cause).toBe(error);
  });

  it('does not transfer target metadata through a copied message or a cause', () => {
    const original = nodeAliasOutsideTrace(`${ROOT}/store/hidden.cjs`);
    const copied = new AuditError(original.message, { cause: original });
    const wrapped = diagnostic(
      nodeAliasLookupError(copied, ROOT, `${ROOT}/entry.cjs`, {
        kind: 'import',
        specifier: 'dep',
      }),
    );

    expect(wrapped.message).not.toContain('target=');
    expect(wrapped.cause).toBe(copied);
  });

  it.each([false, true])(
    'reports required-input provenance without changing refusal: %s',
    (requiredInput) => {
      const error = nodeAliasOutsideTrace(`${ROOT}/store/unclosed.cjs`);
      const wrapped = diagnostic(
        nodeAliasLookupError(error, ROOT, `${ROOT}/entry.cjs`, {
          kind: 'require',
          specifier: 'dep',
          requiredInput,
        }),
      );

      expect(wrapped.message).toContain(`requiredInput=${String(requiredInput)}`);
      expect(wrapped.cause).toBe(error);
      expect(error.message).toBe(OUTSIDE_CLOSED_TRACE);
    },
  );

  it('bounds and JSON-quotes relative identities and source specifiers', () => {
    const name = `src/"line\n${'x'.repeat(300)}`;
    const specifier = `dep/"line\n${'y'.repeat(300)}`;
    const error = nodeAliasOutsideTrace(`${ROOT}/${name}`);
    const wrapped = diagnostic(
      nodeAliasLookupError(error, ROOT, `${ROOT}/${name}`, { kind: 'require', specifier }),
    );
    const quotedName = JSON.stringify(`${name.slice(0, 240)}…`);
    const quotedSpecifier = JSON.stringify(`${specifier.slice(0, 240)}…`);

    expect(wrapped.message).toContain(`importer=${quotedName}`);
    expect(wrapped.message).toContain(`specifier=${quotedSpecifier}`);
    expect(wrapped.message).toContain(`target=${quotedName}`);
    expect(wrapped.message).not.toContain(ROOT);
    expect(wrapped.message).not.toContain('\n');
  });

  it.each([
    undefined,
    null,
    42,
    new TypeError('authored programming error'),
    Object.assign(new Error('authored I/O failure'), { code: 'EIO' }),
  ])('preserves an unexpected failure by identity: %#', (error) => {
    expect(
      nodeAliasLookupError(error, ROOT, `${ROOT}/entry.cjs`, { kind: 'require', specifier: 'dep' }),
    ).toBe(error);
  });

  it.each(['require', 'import'] as const)(
    'adds context to a strict %s lookup while preserving its closed-trace refusal',
    async (kind) => {
      const own = await fixture(kind);
      const target = await unclosed(own, kind === 'import');
      const error = diagnostic(
        await rejected(() => nodeModuleAliases(own.sources, own.layout, own.links)),
      );

      expect(error.message).toBe(
        `${OUTSIDE_CLOSED_TRACE} (importer=${JSON.stringify(path.relative(own.root, own.file))}, specifier="dep", kind=${JSON.stringify(kind)}, target=${JSON.stringify(path.relative(own.root, target))})`,
      );
      expect(diagnostic(error.cause).message).toBe(OUTSIDE_CLOSED_TRACE);
      expect(own.links.size).toBe(0);
    },
  );

  it('continues ignoring an alternative-only unclosed target with its unchanged inner message', async () => {
    const own = await fixture('require', true);
    await unclosed(own);
    await nodeModuleAliases(own.sources, own.layout, own.links);

    expect(own.links.size).toBe(0);
  });

  it.each([
    new TypeError('authored programming error'),
    Object.assign(new Error('authored I/O failure'), { code: 'EIO' }),
  ])('preserves unexpected strict lookup failures: %#', async (error) => {
    const own = await fixture();
    await unclosed(own);
    const layout = {
      ...own.layout,
      nameOf() {
        throw error;
      },
    };

    await expect(nodeModuleAliases(own.sources, layout, own.links)).rejects.toBe(error);
  });

  it('does not wrap unknown alternative AuditErrors or required-collection callback failures', async () => {
    const own = await fixture('require', true);
    await unclosed(own);
    const error = new AuditError('authored unclassified refusal');
    const layout = {
      ...own.layout,
      nameOf() {
        throw error;
      },
    };

    await expect(nodeModuleAliases(own.sources, layout, own.links)).rejects.toBe(error);
    await expect(
      nodeModuleAliases(own.sources, own.layout, own.links, () => Promise.reject(error)),
    ).rejects.toBe(error);
  });
});
