import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_MANIFEST = 'package.json';
const DEPENDENCY_FILES = [
  PACKAGE_MANIFEST,
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

function sourceVersion(file: string): string {
  try {
    const stat = statSync(file, { bigint: true });
    return `${String(stat.mtimeNs)}:${String(stat.ctimeNs)}:${String(stat.size)}:${String(stat.ino)}`;
  } catch {
    return 'missing';
  }
}

export function sourceChanges(versions: ReadonlyMap<string, string>): () => boolean {
  return () => [...versions].some(([file, version]) => sourceVersion(file) !== version);
}

export function watchFile(
  file: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
): void {
  watchedFiles.add(file);
  if (!versions.has(file)) versions.set(file, sourceVersion(file));
}

export function watchDependencies(
  projectDir: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
): void {
  let directory = path.resolve(projectDir);
  do {
    if (
      directory === path.resolve(projectDir) ||
      existsSync(path.join(directory, PACKAGE_MANIFEST))
    )
      for (const name of DEPENDENCY_FILES)
        watchFile(path.join(directory, name), watchedFiles, versions);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  } while (directory !== path.dirname(directory));
}

export function watchManifests(
  file: string,
  watchedFiles: Set<string>,
  versions: Map<string, string>,
): void {
  let directory = path.dirname(file);
  for (;;) {
    const manifest = path.join(directory, PACKAGE_MANIFEST);
    if (existsSync(manifest)) watchFile(manifest, watchedFiles, versions);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
