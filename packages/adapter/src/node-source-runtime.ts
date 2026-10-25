// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Inspection-only parser for the pinned hosted Node 24 strip mode; its output is never shipped.
import { stripTypeScriptTypes } from 'node:module';

import { AuditError } from './dependencies.ts';

/** Validate copied executable syntax without rewriting the original Node artifact. */
export function assertRawNodeSource(file: string, bytes: Uint8Array): void {
  if (/\.[cm]?[jt]sx$/u.test(file))
    throw new AuditError('Raw JSX dependencies require compilation before native publication');
  if (!/\.[cm]?ts$/u.test(file)) return;
  if (file.split(/[\\/]/u).includes('node_modules'))
    throw new AuditError(
      'Raw TypeScript in node_modules requires compilation before native publication',
    );
  try {
    // The hosted Node 24 runtime strips types, but does not transform enums or parameter fields.
    // Only validation is used here; original bytes and their digest stay unchanged.
    stripTypeScriptTypes(Buffer.from(bytes).toString('utf8'), { mode: 'strip' });
  } catch {
    throw new AuditError(
      'Raw TypeScript dependency requires compilation before native publication',
    );
  }
}
