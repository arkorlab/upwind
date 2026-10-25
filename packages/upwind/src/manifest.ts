import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A package's version, or nothing when its manifest cannot be read or does not say.
 *
 * Nothing here is worth failing a dev server over: a version is something `/__upwind` reports and a
 * banner prints, and a run whose manifest could not be read should still serve the application.
 */
export async function packageVersion(manifest: string | URL): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifest, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The version of the package a resolved module belongs to: the nearest manifest up from it that says one. */
export async function moduleVersion(module: string): Promise<string | undefined> {
  let at = path.dirname(module);
  for (;;) {
    const version = await packageVersion(path.join(at, 'package.json'));
    if (version !== undefined) {
      return version;
    }
    const up = path.dirname(at);
    if (up === at) {
      return undefined;
    }
    at = up;
  }
}

/**
 * This CLI's own version.
 *
 * `../package.json` reads the same from the sources a workspace links (`src/cli.ts`) and from the
 * module a registry installs (`dist/cli.js`): both sit one directory below the manifest.
 */
export async function ownVersion(): Promise<string | undefined> {
  return packageVersion(new URL('../package.json', import.meta.url));
}
