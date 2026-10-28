import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NODE_MANIFEST_HANDLER_PROFILES } from '../../src/node-manifest-handler-catalog.ts';

/** Provenance-only primary bytes. Never register these files in the executable fixture graph. */
export async function copyHandlerSourcePins(root: string, publishedRoot: string): Promise<void> {
  const relativeFiles = new Set([
    ...NODE_MANIFEST_HANDLER_PROFILES.flatMap((profile) => profile.sources.map((pin) => pin.relative)),
    'dist/build/load-entrypoint.js',
    'dist/build/templates/pages.js',
    'dist/esm/build/templates/pages.js',
  ]);
  for (const relative of relativeFiles) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(publishedRoot, relative)));
  }
}
