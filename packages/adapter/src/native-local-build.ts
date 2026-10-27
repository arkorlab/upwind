import { realpath, stat } from 'node:fs/promises';

import { AuditError } from './dependencies.ts';

const MISSING_FILE = 'ENOENT';

/** A selected lookup path must survive relocation without an unproved internal alias. */
export async function firstExistingNativeBinary(
  candidates: readonly string[],
  owned: ReadonlySet<string>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const actual = await realpath(candidate);
      if (actual !== candidate)
        throw new AuditError('Native loader lookup requires an unproved internal alias');
      if (!owned.has(actual) || !(await stat(actual)).isFile())
        throw new AuditError('Native loader first existing binary is not an owned regular file');
      return actual;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== MISSING_FILE)
        throw error;
    }
  }
  return undefined;
}
