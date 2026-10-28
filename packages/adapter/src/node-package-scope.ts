import { stat } from 'node:fs/promises';
import path from 'node:path';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';

interface PackageScopeInput {
  readonly layout: {
    readonly root: string;
    readonly nameOf: (file: string) => string;
  };
  readonly sources: { readonly files: ReadonlyMap<string, Uint8Array> };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function packageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The nearest existing scope wins, even when its name or exports do not match the request. */
export async function nodePackageScope(
  importer: string,
  input: PackageScopeInput,
): Promise<{ readonly file: string; readonly metadata: Record<string, unknown> } | undefined> {
  for (
    let dir = path.dirname(importer);
    beneath(input.layout.root, dir) !== undefined && path.basename(dir) !== 'node_modules';
    dir = path.dirname(dir)
  ) {
    const file = path.join(dir, 'package.json');
    try {
      await stat(file);
      const bytes = input.sources.files.get(input.layout.nameOf(file));
      if (bytes === undefined)
        throw new AuditError('Node package import scope metadata is not closed');
      const metadata: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!packageRecord(metadata))
        throw new AuditError('Invalid Node package import scope metadata');
      return { file, metadata };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (dir === input.layout.root) break;
  }
  return undefined;
}
