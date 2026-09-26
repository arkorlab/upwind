import { readFile } from 'node:fs/promises';

/**
 * This scaffolder's own version, and what it asks for of the packages released beside it.
 *
 * `create-upwind@0.2.0` scaffolds `upwind@^0.2.0`: the two are published from one tag, which the
 * release verifies says the version every package says, so a scaffolder and the CLI it wires in are
 * always of the same generation. A version that cannot be read falls back to `latest` — a scaffolded
 * project that installs the newest is a better answer than one that installs nothing.
 */
const FALLBACK = 'latest';

export async function ownRange(): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (
      typeof manifest === 'object' &&
      manifest !== null &&
      'version' in manifest &&
      typeof manifest.version === 'string'
    ) {
      return `^${manifest.version}`;
    }
    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/** The version this reports for `--version`, or nothing when its own manifest could not be read. */
export async function ownVersion(): Promise<string | undefined> {
  const range = await ownRange();
  return range === FALLBACK ? undefined : range.slice(1);
}
