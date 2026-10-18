import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { AuditError } from './dependencies.ts';

/** An external build's files live here in the Function, never above `/bundle`. */
export const EXTERNAL_BUILD_DIR = '.upwind-build';
export const BUNDLE_ROOT = '/bundle';

/** `file` beneath `dir`; unlike a module name, an empty relative path names the root itself. */
export function beneath(dir: string, file: string): string | undefined {
  const relative = path.relative(dir, file);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined
    : relative;
}

function posix(file: string): string {
  return file.split(path.sep).join('/');
}

function overlaps(a: string, b: string): boolean {
  return beneath(a, b) !== undefined || beneath(b, a) !== undefined;
}

function refuseAncestor(projectDir: string, distDir: string): void {
  if (beneath(distDir, projectDir) !== undefined) {
    throw new AuditError(
      `@stayingupwind/adapter: distDir must not be the project directory or an ancestor of it: ${distDir}`,
    );
  }
}

export interface BuildPaths {
  readonly external: boolean;
  /** Relative to the Function's project root, rather than to the build machine's project. */
  readonly runtimeDistDir: string;
  /** A data module's name, or undefined outside both the project and its build output. */
  moduleName(file: string): string | undefined;
  /** The path at which the Function reads such a module. */
  runtimePath(file: string): string | undefined;
  /** An external build may not smuggle a file outside its own root through a symlink. */
  assertDataFile(file: string): void;
}

/**
 * Physical build paths stay physical for the bundler. Only data module names change: an output
 * beside a workspace package is mounted under a reserved, legal name in the Function's VFS.
 * In-project builds retain their existing names exactly.
 */
export function buildPaths(projectDir: string, distDir: string): BuildPaths {
  const project = path.resolve(projectDir);
  const dist = path.resolve(distDir);
  refuseAncestor(project, dist);
  const relativeDist = beneath(project, dist);
  const external = relativeDist === undefined;
  const runtimeDistDir = external ? EXTERNAL_BUILD_DIR : posix(relativeDist);
  let realDist: string | undefined;
  function moduleName(file: string): string | undefined {
    const built = beneath(dist, file);
    if (built !== undefined) {
      return path.posix.join(runtimeDistDir, posix(built));
    }
    const relative = beneath(project, file);
    if (relative === undefined || relative === '') return undefined;
    const name = posix(relative);
    if (external && (name === EXTERNAL_BUILD_DIR || name.startsWith(`${EXTERNAL_BUILD_DIR}/`))) {
      throw new AuditError(`@stayingupwind/adapter: ${EXTERNAL_BUILD_DIR} is reserved for distDir`);
    }
    return name;
  }
  return {
    external,
    runtimeDistDir,
    moduleName,
    runtimePath(file) {
      const name = moduleName(file);
      return name === undefined ? undefined : `${BUNDLE_ROOT}/${name}`;
    },
    assertDataFile(file) {
      if (!external || beneath(dist, file) === undefined) return;
      realDist ??= realpathSync(dist);
      if (beneath(realDist, realpathSync(file)) === undefined) {
        throw new AuditError(
          `@stayingupwind/adapter: a data file escapes the external distDir through a symlink: ${file}`,
        );
      }
    },
  };
}

/** Checked before clearing the adapter's staging directory or reading any external data. */
export function assertBuildPaths(projectDir: string, distDir: string, outDir: string): void {
  const paths = buildPaths(projectDir, distDir);
  if (overlaps(path.resolve(distDir), path.resolve(outDir))) {
    throw new AuditError('@stayingupwind/adapter: distDir overlaps the adapter output directory');
  }
  const realProject = realpathSync(projectDir);
  const realDist = realpathSync(distDir);
  refuseAncestor(realProject, realDist);
  const realOut = existsSync(outDir)
    ? realpathSync(outDir)
    : path.join(realProject, path.relative(projectDir, outDir));
  if (overlaps(realDist, realOut)) {
    throw new AuditError('@stayingupwind/adapter: distDir overlaps the adapter output directory');
  }
  if (paths.external && existsSync(path.join(projectDir, EXTERNAL_BUILD_DIR))) {
    throw new AuditError(`@stayingupwind/adapter: ${EXTERNAL_BUILD_DIR} is reserved for distDir`);
  }
}
