import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The filesystem questions several parts of this build ask, in a module of their own.
 *
 * `exists` lived in `collect.ts` until `source-maps.ts` needed it too, which made the two import
 * each other. The cycle happened to work — every binding is read inside a function body — but
 * module initialization order is not something to leave to load order.
 */

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `file` is somewhere below `dir`.
 *
 * `..` has to be a segment of its own to mean "above": a sibling directory named `..next` is a
 * path that starts with `..` and is not outside anything.
 */
export function isUnder(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
