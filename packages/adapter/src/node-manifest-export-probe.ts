import { AuditError } from './dependencies.ts';
import { exportBindings } from './node-manifest-turbopack-values.ts';

const PREFIX = 'Unproved Next.js Turbopack manifest ';
const SUFFIX = '; refusing native publication';
const UNSUPPORTED_EXPORTS: ReadonlySet<string> = new Set([
  'empty export registration',
  'export getter',
  'export getter body',
  'export getter expression',
  'export name',
  'export registration arguments',
  'export value expression',
]);

/** A role probe may decline an export shape; the general export parser remains strict. */
export function inspectExportBindings(
  table: unknown,
): ReturnType<typeof exportBindings> | undefined {
  try {
    return exportBindings(table);
  } catch (error) {
    if (
      error instanceof AuditError &&
      error.message.startsWith(PREFIX) &&
      error.message.endsWith(SUFFIX) &&
      UNSUPPORTED_EXPORTS.has(error.message.slice(PREFIX.length, -SUFFIX.length))
    )
      return undefined;
    throw error;
  }
}
