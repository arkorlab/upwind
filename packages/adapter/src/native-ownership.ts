import { realpath, stat } from 'node:fs/promises';

import { AuditError } from './dependencies.ts';
import { entryOwnsImporter } from './native-addon-entries.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';

export async function ownedNativeFiles(
  importer: string,
  traces: readonly NativeAddonEntryTrace[],
): Promise<string[]> {
  const original = await realpath(importer);
  const files = new Set<string>();
  for (const trace of traces) {
    if (!(await entryOwnsImporter(trace, original))) continue;
    for (const file of Object.values(trace.assets))
      if (file.endsWith('.node')) files.add(await realpath(file));
  }
  return [...files];
}

export async function ownedBinary(
  binary: string,
  importer: string,
  traces: readonly NativeAddonEntryTrace[],
): Promise<readonly string[]> {
  const actual = await realpath(binary);
  const original = await realpath(importer);
  const owners: string[] = [];
  for (const trace of traces) {
    const files = Object.values(trace.assets);
    if (!(await entryOwnsImporter(trace, original))) continue;
    for (const file of files) {
      if (file.endsWith('.node') && (await realpath(file)) === actual) {
        owners.push(trace.id);
        break;
      }
    }
  }
  if (owners.length === 0 || !(await stat(actual)).isFile()) {
    throw new AuditError(
      '@stayingupwind/adapter: a native load has no owned, regular-file binary in the route trace',
    );
  }
  return owners;
}
