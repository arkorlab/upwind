import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';

export interface NodePhysicalLayout {
  readonly root: string;
  readonly traceRoot: string;
  readonly distDir: string | undefined;
  readonly cwd: string;
  readonly nameOf: (file: string) => string;
}

interface CanonicalPrefix {
  readonly declared: string;
  readonly canonical: string;
}

async function canonicalDist(file: string): Promise<string | undefined> {
  try {
    return await realpath(file);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return undefined;
  }
}

/** Rebase only declared roots, retaining the final logical alias rather than following it. */
function canonicalLocation(file: string, prefixes: readonly CanonicalPrefix[]): string {
  for (const prefix of prefixes) {
    const relative = beneath(prefix.declared, file);
    if (relative !== undefined) return path.resolve(prefix.canonical, relative);
  }
  return file;
}

export async function nodePhysicalLayout(input: BuildFunctionInput): Promise<NodePhysicalLayout> {
  const traceRoot = path.resolve(input.repoRoot ?? input.projectDir);
  const declaredDist = path.resolve(input.patch.distDir);
  const [root, projectDir, distDir] = await Promise.all([
    realpath(traceRoot),
    realpath(input.projectDir),
    canonicalDist(declaredDist),
  ]);
  const project = beneath(root, projectDir);
  if (project === undefined)
    throw new AuditError('Node project directory escapes its tracing root');
  const cwd = path.posix.join('project', project.split(path.sep).join('/'));
  const prefixes: CanonicalPrefix[] = [{ declared: traceRoot, canonical: root }];
  if (distDir !== undefined) prefixes.unshift({ declared: declaredDist, canonical: distDir });
  const nameOf = (file: string): string => {
    const canonical = canonicalLocation(path.resolve(file), prefixes);
    const relative = beneath(root, canonical);
    if (relative !== undefined)
      return path.posix.join('project', relative.split(path.sep).join('/'));
    const built = distDir === undefined ? undefined : beneath(distDir, canonical);
    if (built !== undefined)
      return path.posix.join(cwd, '.upwind-build', built.split(path.sep).join('/'));
    throw new AuditError('Node artifact input escapes both its tracing root and build output');
  };
  return { root, traceRoot, distDir, cwd, nameOf };
}
