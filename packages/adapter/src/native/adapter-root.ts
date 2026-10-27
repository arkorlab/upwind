import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { exists } from '../fs.ts';

/**
 * The adapter's own package directory, found from this module upwards by its name: where the native
 * server's templates are, compiled in a public install and as sources in a checkout (`emit.ts`).
 */
export async function adapterRoot(): Promise<string> {
  let directory = import.meta.dirname;
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (await exists(manifest)) {
      const value = JSON.parse(await readFile(manifest, 'utf8')) as { readonly name?: string };
      if (value.name === '@stayingupwind/adapter') return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error('@stayingupwind/adapter: cannot find the native server templates');
    directory = parent;
  }
}
