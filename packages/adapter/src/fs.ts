import { stat } from 'node:fs/promises';

/**
 * The one filesystem question several parts of this build ask, in a module of its own.
 *
 * It lived in `collect.ts` until `source-maps.ts` needed it too, which made the two import each
 * other. The cycle happened to work — every binding is read inside a function body — but module
 * initialization order is not something to leave to load order.
 */

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
