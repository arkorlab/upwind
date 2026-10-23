import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { build, type Metafile } from 'esbuild';

/**
 * A Worker of the stack, bundled as `wrangler deploy` bundles one: one ES module, with the
 * runtime's own modules left to the runtime — `cloudflare:*`, and `node:*` under `nodejs_compat`.
 */
export interface BundledWorker {
  readonly entry: string;
  readonly script: string;
  /** Every module bundled in, by its path from `root`. */
  readonly metafile: Metafile;
  readonly root: string;
}

/** The scope every package of upwind's own is published under. */
const OWN_SCOPE = '@stayingupwind/';

export async function bundleWorker(entry: string): Promise<BundledWorker> {
  const root = path.dirname(entry);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:*', 'node:*'],
    logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (output === undefined) {
    throw new Error(`esbuild produced no output for ${entry}`);
  }
  return { entry, script: output.text, metafile: result.metafile, root };
}

/** The name in the nearest `package.json` above `file` that has one, read once per directory. */
function packageOf(file: string, names: Map<string, string | undefined>): string | undefined {
  const visited: string[] = [];
  let found: string | undefined;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (names.has(dir)) {
      found = names.get(dir);
      break;
    }
    visited.push(dir);
    const candidate = path.join(dir, 'package.json');
    const manifest: unknown = existsSync(candidate)
      ? JSON.parse(readFileSync(candidate, 'utf8'))
      : undefined;
    const name: unknown =
      typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'name') : undefined;
    if (typeof name === 'string') {
      found = name;
      break;
    }
    if (path.dirname(dir) === dir) {
      break;
    }
  }
  for (const dir of visited) {
    names.set(dir, found);
  }
  return found;
}

/**
 * Refuses a Worker that bundles a module of anything but upwind's own packages and their
 * dependencies: a module of another workspace package is its host's, which a stack run from
 * upwind alone could not have. A dependency is whatever was installed (`node_modules`); a module
 * outside it belongs to the nearest package that names itself, which has to be one of upwind's.
 */
export function assertHostOnly(worker: BundledWorker): void {
  const names = new Map<string, string | undefined>();
  const foreign: string[] = [];
  for (const input of Object.keys(worker.metafile.inputs)) {
    const file = path.resolve(worker.root, input);
    if (file.split(path.sep).includes('node_modules')) {
      continue;
    }
    const name = packageOf(file, names);
    if (name?.startsWith(OWN_SCOPE) !== true) {
      foreign.push(`${file} (${name ?? 'no package'})`);
    }
  }
  if (foreign.length > 0) {
    throw new Error(
      `${worker.entry} bundles modules of no package of upwind's own: ${foreign.join(', ')}`,
    );
  }
}
