import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The files of the image encoder the native server loads (`runtime/src/native/image-encoder.ts`):
 * `sharp`, found where Next.js finds it — from where `next` is installed, of which it is an optional
 * dependency — and every package it requires in turn, the binding for this platform and the
 * `libvips` that binding links against among them. They go into the artifact beside Next.js, as
 * `output: 'standalone'` carries them (`build/collect-build-traces.js` traces `sharp` with the
 * server), so an artifact moved off the machine it was built on still resizes images.
 *
 * Each package is listed by the path Node's lookup reaches it by — through the links a package
 * manager lays, `node_modules/.pnpm/next@…/node_modules/sharp` — so the copier lays the same links
 * in the artifact (`copyNativeFiles`), and the binding still finds `libvips` beside it. Nothing
 * where there is no `sharp` to find: the server then serves sources as they are, and says so.
 */

const NODE_MODULES = 'node_modules';
const PACKAGE_JSON = 'package.json';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

async function isPackage(directory: string): Promise<boolean> {
  try {
    return (await stat(path.join(directory, PACKAGE_JSON))).isFile();
  } catch {
    return false;
  }
}

/**
 * Where Node's lookup finds `name` from `directory`: the first `node_modules/<name>` up the tree,
 * skipping a directory that is itself `node_modules`, as `Module._nodeModulePaths` lists them.
 */
async function packageFrom(directory: string, name: string): Promise<string | undefined> {
  for (let current = directory; ;) {
    if (path.basename(current) !== NODE_MODULES) {
      const candidate = path.join(current, NODE_MODULES, name);
      if (await isPackage(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Every file of the package at `reached`, by paths under it: its own, not those of a package
 * nested in it, which is found as a dependency if it is one. A link inside it to a directory is
 * walked as one, once.
 */
async function packageFiles(reached: string): Promise<string[]> {
  const files: string[] = [];
  const walked = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    const real = await realpath(directory);
    if (walked.has(real)) return;
    walked.add(real);

    const entries = await readdir(real, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === NODE_MODULES) continue;
      const file = path.join(directory, entry.name);

      const info = await stat(file);
      if (info.isDirectory()) await walk(file);
      else if (info.isFile()) files.push(file);
    }
  };
  await walk(reached);
  return files;
}

async function manifestOf(directory: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(directory, PACKAGE_JSON), 'utf8')) as PackageManifest;
}

/** The encoder's files, from the project's own installation; none where it has no `sharp`. */
export async function imageEncoderFiles(projectDir: string): Promise<string[]> {
  let nextManifest: string;
  try {
    nextManifest = createRequire(path.join(projectDir, PACKAGE_JSON)).resolve(
      `next/${PACKAGE_JSON}`,
    );
  } catch {
    return [];
  }
  const sharp = await packageFrom(path.dirname(nextManifest), 'sharp');
  if (sharp === undefined) return [];
  const files: string[] = [];
  const seen = new Set<string>();
  const pending = [sharp];
  for (let reached = pending.pop(); reached !== undefined; reached = pending.pop()) {
    const real = await realpath(reached);
    if (seen.has(real)) continue;
    seen.add(real);
    files.push(...(await packageFiles(reached)));
    const manifest = await manifestOf(real);
    // Required from where the package really is, as Node resolves a package's own requires; a
    // platform's binding among the optional ones is there only on the platform it is for.
    const required = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
    for (const name of required) {
      const found = await packageFrom(real, name);
      if (found !== undefined) pending.push(found);
    }
  }
  return files;
}
