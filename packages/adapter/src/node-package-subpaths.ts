import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { AuditError } from './dependencies.ts';

const MAX_DEPTH = 8;
const MAX_NODES = 64;
const MAX_TARGETS = 16;

interface PackageSubpaths {
  readonly exact: boolean;
  readonly targets: readonly string[];
}

function refuse(): never {
  throw new AuditError('Node package subpath has unproved export or physical topology');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nodePackageName(specifier: string): string | undefined {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.includes(':') ||
    specifier.startsWith('#')
  )
    return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function safeRelative(target: string): boolean {
  return (
    target.startsWith('./') &&
    !/[*#?%\\]/u.test(target) &&
    target
      .slice(2)
      .split('/')
      .every((part) => part !== '' && !['.', '..', 'node_modules'].includes(part))
  );
}

/** Inspect every finite condition branch without selecting require conditions for ESM. */
function exportTargets(value: unknown): readonly string[] {
  const targets = new Set<string>();
  let nodes = 0;
  function visit(target: unknown, depth: number): void {
    nodes += 1;
    if (depth > MAX_DEPTH || nodes > MAX_NODES) refuse();
    if (target === null) return;
    if (typeof target === 'string') {
      if (!safeRelative(target)) refuse();
      targets.add(target);
      if (targets.size > MAX_TARGETS) refuse();
      return;
    }
    if (!record(target)) refuse();
    for (const [condition, child] of Object.entries(target)) {
      if (condition === '' || condition.startsWith('.') || /^\d/u.test(condition)) refuse();
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
  if (targets.size === 0) refuse();
  return [...targets];
}

/** Only captured package metadata and exact subpath entries establish these lookup candidates. */
export function nodePackageSubpaths(
  specifier: string,
  packageName: string,
  metadata: unknown,
): PackageSubpaths | undefined {
  if (specifier === packageName) return undefined;
  const relative = `.${specifier.slice(packageName.length)}`;
  if (!safeRelative(relative)) refuse();
  if (!record(metadata) || metadata['exports'] === undefined || metadata['exports'] === null)
    return { exact: false, targets: [relative] };
  const exports = metadata['exports'];
  if (!record(exports) || !Object.hasOwn(exports, relative)) refuse();
  return { exact: true, targets: exportTargets(exports[relative]) };
}
function missingTarget(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))
  );
}

/** Restore candidate aliases inside the canonical package, not below its root symlink. */
export async function preserveNodePackageSubpaths(input: {
  readonly directory: string;
  readonly specifier: string;
  readonly packageName: string;
  readonly metadata: Uint8Array | undefined;
  readonly relativeAlias: (target: string) => Promise<void>;
  readonly exactAlias: (target: string) => Promise<void>;
}): Promise<void> {
  if (input.specifier === input.packageName) return;
  const metadata: unknown =
    input.metadata === undefined ? undefined : JSON.parse(new TextDecoder().decode(input.metadata));
  const subpaths = nodePackageSubpaths(input.specifier, input.packageName, metadata);
  if (subpaths === undefined) return;
  for (const target of subpaths.targets) {
    if (!subpaths.exact) {
      await input.relativeAlias(target);
      continue;
    }
    const logical = path.resolve(input.directory, target);
    try {
      const canonical = await realpath(logical);
      if (!(await stat(canonical)).isFile())
        throw new AuditError('Node package export requires an exact regular target');
      if (canonical !== logical) await input.exactAlias(target);
    } catch (error) {
      // An absent conditional branch was absent before relocation too; never invent its alias.
      if (!missingTarget(error)) throw error;
    }
  }
}
