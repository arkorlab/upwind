import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The code a deploy carries with it: the runtime cache's host, which a build bundles into every
 * Function.
 *
 * Shipped built. The cache package it is made of is TypeScript sources that a registry does not
 * carry, so the published command carries the host bundled, in `dist/shipped/`, with its digest in
 * a manifest beside it: the host a version of this command builds with is exactly that one, whatever
 * is installed where it runs. A run from this repository's own sources, which has no `dist/`, names
 * the sources instead.
 */

/**
 * The cache's Function host, the module a build names by its path: the sources' own in this
 * repository, or the shipped bundle, whose imports a build points at the project's own runtime
 * first (`cache-host.ts`).
 */
export type CacheHostSource =
  | { readonly kind: 'source'; readonly path: string }
  | { readonly kind: 'bundle'; readonly path: string; readonly sha256: string };

/** A file `dist/shipped/` holds, and the digest of what it holds. */
export interface ShippedFile {
  readonly file: string;
  readonly sha256: string;
}

/** What `dist/shipped/manifest.json` says. */
export interface ShippedManifest {
  readonly cacheHost: ShippedFile;
}

export const SHIPPED_MANIFEST_FILE = 'manifest.json';

export function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Where the shipped code is, beside the module this is bundled into; nothing for a run from sources. */
function shippedDir(): string | undefined {
  // eslint-disable-next-line unicorn/no-missing-local-resource -- beside the bundled command in `dist/`, not beside its sources
  const dir = fileURLToPath(new URL('shipped/', import.meta.url));
  return existsSync(path.join(dir, SHIPPED_MANIFEST_FILE)) ? dir : undefined;
}

async function shippedManifest(dir: string): Promise<ShippedManifest> {
  return JSON.parse(
    await readFile(path.join(dir, SHIPPED_MANIFEST_FILE), 'utf8'),
  ) as ShippedManifest;
}

/** The cache's Function host, in the sources. */
export function cacheHostEntry(): string {
  return fileURLToPath(import.meta.resolve('@stayingupwind/cache/function/host'));
}

/** The scope every package of upwind's own is published under, and this command's own name. */
const OWN_SCOPE = '@stayingupwind/';
const OWN_NAME = 'upwind';

/** The name in the nearest `package.json` above `file` that has one. */
function packageOf(file: string): string | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      const manifest: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      const name: unknown =
        typeof manifest === 'object' && manifest !== null
          ? Reflect.get(manifest, 'name')
          : undefined;
      if (typeof name === 'string') {
        return name;
      }
    }
    if (path.dirname(dir) === dir) {
      return undefined;
    }
  }
}

/**
 * Refuses a bundle of anything but upwind's own packages, this command included, and what they
 * install: what a deploy ships is what upwind ships, and nothing else of the repository it was
 * built in.
 */
export function assertUpwindOnly(entry: string, inputs: readonly string[], root: string): void {
  const foreign = inputs
    .map((input) => path.resolve(root, input))
    .filter((file) => !file.split(path.sep).includes('node_modules'))
    .filter((file) => {
      const name = packageOf(file);
      return name !== OWN_NAME && name?.startsWith(OWN_SCOPE) !== true;
    });
  if (foreign.length > 0) {
    throw new Error(
      `${entry} bundles modules of no package of upwind's own: ${foreign.join(', ')}`,
    );
  }
}

/** The cache host a build for a deploy names: the one shipped, or the sources' own. */
export async function shippedCacheHost(): Promise<CacheHostSource> {
  const dir = shippedDir();
  if (dir === undefined) {
    return { kind: 'source', path: cacheHostEntry() };
  }
  const { cacheHost } = await shippedManifest(dir);
  return { kind: 'bundle', path: path.join(dir, cacheHost.file), sha256: cacheHost.sha256 };
}
