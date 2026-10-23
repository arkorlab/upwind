import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { rolldown } from 'rolldown';

/**
 * A Worker of the stack, bundled as `wrangler deploy` bundles one: one ES module, with the
 * runtime's own modules left to the runtime — `cloudflare:*`, and `node:*` under `nodejs_compat`.
 */
export interface BundledWorker {
  readonly entry: string;
  readonly script: string;
  /** Every source module loaded, including modules removed by tree shaking. */
  readonly inputs: readonly string[];
  readonly root: string;
}

/** The scope every package of upwind's own is published under. */
const OWN_SCOPE = '@stayingupwind/';

/** The cache host leaves its runtime imports for the application build to resolve. */
export interface BundleWorkerOptions {
  readonly platform?: 'browser' | 'neutral';
  readonly external?: readonly RegExp[];
}

export async function bundleWorker(
  entry: string,
  options: BundleWorkerOptions = {},
): Promise<BundledWorker> {
  const root = path.dirname(entry);
  const inputs = new Set<string>();
  const bundle = await rolldown({
    cwd: root,
    input: entry,
    platform: options.platform ?? 'browser',
    preserveEntrySignatures: 'strict',
    transform: { target: 'es2024' },
    resolve: { conditionNames: ['workerd', 'worker', 'browser'] },
    external: [/^cloudflare:/u, /^node:/u, ...(options.external ?? [])],
    plugins: [
      {
        name: 'upwind-worker-inputs',
        moduleParsed(module) {
          // Output chunks omit tree-shaken modules. Ownership checks must see the source graph,
          // while virtual modules and the runtime's external imports have no source file to own.
          if (path.isAbsolute(module.id)) {
            inputs.add(module.id);
          }
        },
      },
    ],
    onLog(_level, log, defaultHandler) {
      // Rolldown normally leaves an unresolved package external. A deploy must carry its whole
      // dependency graph, apart from the runtime modules explicitly left external above.
      if (log.code === 'UNRESOLVED_IMPORT') {
        defaultHandler('error', log);
      }
    },
  });
  try {
    const { output } = await bundle.generate({ format: 'esm', codeSplitting: false });
    const [chunk] = output;
    if (output.length !== 1 || chunk?.type !== 'chunk') {
      throw new Error(`Rolldown did not produce one ES module for ${entry}`);
    }
    return { entry, script: chunk.code, inputs: [...inputs], root };
  } finally {
    await bundle.close();
  }
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
  for (const input of worker.inputs) {
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
