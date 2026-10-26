import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';

/** NFT metadata remains relative to its trace, including explicitly declared additional roots. */
interface FileTrace {
  readonly files: readonly string[];
  readonly symlinks?: readonly (readonly [number, string, number?])[];
  readonly additionalRoots?: readonly (FileTrace & {
    readonly path: string;
    readonly name: string;
  })[];
}

function inside(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`@stayingupwind/adapter: native trace escapes its declared root: ${file}`);
  }
  return relative;
}

/**
 * Every traced source, including symlinks that make Node's package resolution work. NFT lists
 * each link among its files; the copier reads that actual link rather than applying standalone's
 * additional-root destination remapping, because native output retains the original tree.
 */
export async function nativeTraceFiles(file: string): Promise<string[]> {
  const trace: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (typeof trace !== 'object' || trace === null || !('files' in trace)) {
    throw new Error(`@stayingupwind/adapter: invalid native file trace: ${file}`);
  }
  const parsed = trace as FileTrace;
  const directory = path.dirname(file);
  const roots = parsed.additionalRoots ?? [];
  const files: string[] = [];
  for (const [index, list] of [parsed, ...roots].entries()) {
    if (!Array.isArray(list.files) || list.files.some((name) => typeof name !== 'string')) {
      throw new Error(`@stayingupwind/adapter: invalid native file trace: ${file}`);
    }
    const root = index === 0 ? directory : path.resolve(directory, roots[index - 1]?.path ?? '');
    const names: readonly string[] = list.files;
    for (const name of names) {
      const source = path.resolve(root, name);
      if (index !== 0) inside(root, source);
      files.push(source);
    }
  }
  return files;
}

/**
 * An output's asset sources, but for the links Next.js stages for a cross-root symlink
 * (`build/adapter/synthetic-symlinks.ts`, in `<distDir>/adapter/synthetic_symlinks`). Such a link
 * is the trace's own link written again for an output that places each asset at its destination: its
 * target is relative to the destination's directory (`next_additional_roots/<root>/…`), so where it
 * is staged it leads nowhere, and resolving it failed the build. The native output places nothing at a
 * destination — it keeps the original tree — and the trace that made the staged link is one it reads
 * (`nativeTraceFiles`), so the link it stands for, and the files that link leads to in the additional
 * root, are copied as they are.
 */
export function nativeAssetSources(
  assets: Readonly<Record<string, string>>,
  distDir: string,
): string[] {
  const staged = path.resolve(distDir, 'adapter', 'synthetic_symlinks');
  return Object.values(assets).filter((source) => path.dirname(path.resolve(source)) !== staged);
}

/** A common parent keeps every native relative import and symlink relocatable. */
function commonParent(files: readonly string[]): string {
  let root = path.dirname(files[0] ?? path.resolve('.'));
  for (const file of files.slice(1)) {
    for (;;) {
      const relative = path.relative(root, file);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        break;
      const parent = path.dirname(root);
      if (root === parent) {
        throw new Error(
          '@stayingupwind/adapter: native files must be on the same filesystem volume',
        );
      }
      root = parent;
    }
  }
  return root;
}

function environmentFile(file: string): boolean {
  const name = path.basename(file);
  return name === '.env' || name.startsWith('.env.');
}

const CODE_FILE = /\.(?:[cm]?js|[cm]?ts)$/u;
const CLOUDFLARE_IMPORT = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]cloudflare:/u;
const COPY_BATCH_SIZE = 16;

interface Sources {
  readonly files: Set<string>;
  readonly links: Map<string, string>;
  readonly parents: Set<string>;
}

const LICENSE_FILES = new Set([
  'licence',
  'licence.md',
  'licence.txt',
  'license',
  'license-apache',
  'license-apache2',
  'license-mit',
  'license.apache',
  'license.apache2',
  'license.md',
  'license.txt',
  'notice',
  'notice.md',
  'notice.txt',
]);

async function packageLicenses(directory: string, sources: Sources): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!LICENSE_FILES.has(entry.name.toLowerCase()) || entry.isDirectory()) continue;
    const file = path.join(directory, entry.name);
    const physical = await realpath(file);
    sources.files.add(physical);
    if (entry.isSymbolicLink()) sources.links.set(file, physical);
  }
}

async function discoverParents(file: string, sources: Sources): Promise<void> {
  let parent = path.dirname(file);
  while (!sources.parents.has(parent)) {
    sources.parents.add(parent);
    const info = await lstat(parent);
    if (info.isSymbolicLink()) sources.links.set(parent, await realpath(parent));
    const manifest = path.join(parent, 'package.json');
    try {
      if ((await stat(manifest)).isFile()) {
        sources.files.add(await realpath(manifest));
        await packageLicenses(parent, sources);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

async function discoverFile(file: string, sources: Sources): Promise<void> {
  const info = await lstat(file);
  await discoverParents(file, sources);
  if (info.isSymbolicLink()) {
    const target = await realpath(file);
    sources.links.set(file, target);
    if ((await stat(file)).isFile()) sources.files.add(target);
  } else if (info.isFile()) {
    sources.files.add(await realpath(file));
  } else if (!info.isDirectory()) {
    throw new Error(`@stayingupwind/adapter: native trace is not a regular file: ${file}`);
  }
}

async function nativeDestinations(
  files: ReadonlySet<string>,
  root: string,
  outDir: string,
  pathOf: (file: string) => string,
): Promise<Map<string, string>> {
  const destinations = new Map<string, string>();
  for (const file of files) {
    if (environmentFile(file)) continue;
    if (CODE_FILE.test(file)) {
      const source = await readFile(file, 'utf8');
      if (CLOUDFLARE_IMPORT.test(source)) {
        throw new Error(
          `@stayingupwind/adapter: native output imports a Cloudflare-only module: ${path.relative(root, file)}`,
        );
      }
    }
    destinations.set(path.join(outDir, pathOf(file)), file);
  }
  return destinations;
}

async function copyLinks(
  links: ReadonlyMap<string, string>,
  outDir: string,
  pathOf: (file: string) => string,
): Promise<void> {
  const ordered = [...links].toSorted(([a], [b]) => a.length - b.length);
  for (const [file, source] of ordered) {
    const target = path.join(outDir, pathOf(file));
    const destination = path.join(outDir, pathOf(source));
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await symlink(
        path.relative(path.dirname(target), destination) || '.',
        target,
        (await stat(file)).isDirectory() ? 'dir' : 'file',
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await realpath(target)) !== (await realpath(destination))
      )
        throw error;
    }
  }
}

/**
 * Copy only traced files, retaining the real package tree and the relative links into it.
 * File contents stay unbundled: native addons and Node's real module loader remain available.
 */
export async function copyNativeFiles(input: {
  readonly files: readonly string[];
  readonly directories: readonly string[];
  readonly outDir: string;
}): Promise<{ readonly pathOf: (file: string) => string; readonly count: number }> {
  const files = new Set<string>();
  const links = new Map<string, string>();
  const seen = new Set<string>();
  const parents = new Set<string>();
  const sources = { files, links, parents };

  for (const source of input.files) {
    const file = path.resolve(source);
    if (seen.has(file) || environmentFile(file)) continue;
    seen.add(file);
    await discoverFile(file, sources);
  }

  const root = commonParent([
    ...input.directories.map((directory) => path.resolve(directory, 'package.json')),
    ...files,
    ...links.keys(),
    ...links.values(),
  ]);
  const pathOf = (file: string): string =>
    path.posix.join('files', inside(root, path.resolve(file)).split(path.sep).join('/'));
  const destinations = await nativeDestinations(files, root, input.outDir, pathOf);
  const entries = [...destinations];
  for (let offset = 0; offset < entries.length; offset += COPY_BATCH_SIZE) {
    await Promise.all(
      entries.slice(offset, offset + COPY_BATCH_SIZE).map(async ([target, source]) => {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }),
    );
  }
  await copyLinks(links, input.outDir, pathOf);
  return { pathOf, count: destinations.size };
}
