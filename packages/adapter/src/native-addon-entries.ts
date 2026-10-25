import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { exists } from './fs.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';

/** NFT names the hook's dependencies, not the compiled hook or generated host composition. */
export async function instrumentationEntryTraces(
  hook: { readonly file: string | undefined; readonly assets: Readonly<Record<string, string>> },
  distDir: string,
): Promise<NativeAddonEntryTrace[]> {
  if (hook.file === undefined) return [];
  const importers = [hook.file];
  const original = path.join(distDir, 'server', 'instrumentation.js');
  if (hook.file !== original && (await exists(original))) importers.push(original);
  // The public hook convention supplies the common owner. Metadata does not alter Worker files.
  return [{ id: 'instrumentation', assets: hook.assets, importers }];
}

/** Entry identity is proof metadata; only assets can establish ownership of a binary. */
export async function entryOwnsImporter(
  trace: NativeAddonEntryTrace,
  original: string,
): Promise<boolean> {
  const candidates = [...Object.values(trace.assets), ...(trace.importers ?? [])];
  const sources = await Promise.all(
    candidates.filter((file) => /\.(?:c|m)?js$/u.test(file)).map((file) => realpath(file)),
  );
  return sources.includes(original);
}
