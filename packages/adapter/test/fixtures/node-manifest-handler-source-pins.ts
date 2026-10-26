import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NODE_MANIFEST_HANDLER_PROFILES } from '../../src/node-manifest-handler-catalog.ts';

/** Provenance-only primary bytes. Never register these files in the executable fixture graph. */
export async function copyHandlerSourcePins(root: string, publishedRoot: string): Promise<void> {
  for (const profile of NODE_MANIFEST_HANDLER_PROFILES)
    for (const pin of profile.sources) {
      const destination = path.join(root, pin.relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(publishedRoot, pin.relative)));
    }
}
