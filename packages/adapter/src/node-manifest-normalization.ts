import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import type { EntryModule } from './function.ts';

export interface NodeManifestNormalization {
  readonly entries: readonly {
    readonly id: string;
    readonly filePath: string;
    readonly canonicalFilePath: string;
  }[];
  readonly distDir: string;
  readonly canonicalDistDir: string;
  readonly runtimeRootDir?: string;
  /** Inert canonical compiler metadata, sealed separately from executable code. */
  readonly metadataFiles?: readonly { readonly file: string; readonly sha256: string }[];
}

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js client manifest ${reason}; refusing native publication`);
}

/** Seal the complete SDK entry inventory, independently of any protected constructor subset. */
export async function nodeManifestNormalization(input: {
  readonly entries?: readonly EntryModule[] | undefined;
  readonly distDir: string;
}): Promise<NodeManifestNormalization> {
  if (input.entries === undefined || input.entries.length === 0)
    refuse('missing sealed entry inventory');
  const entries: NodeManifestNormalization['entries'][number][] = [];
  const ids = new Set<string>();
  for (const entry of input.entries) {
    const canonicalFilePath = await realpath(entry.filePath);
    if (ids.has(entry.id)) refuse('duplicate sealed route');
    ids.add(entry.id);
    // Route IDs are unique; a built error module may intentionally serve several SDK entries.
    entries.push(Object.freeze({ id: entry.id, filePath: entry.filePath, canonicalFilePath }));
  }
  const distDir = path.resolve(input.distDir);
  return Object.freeze({
    entries: Object.freeze(entries),
    distDir,
    canonicalDistDir: await realpath(distDir),
  });
}
