import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import { nodePackageMain, nodePackageName, nodePackageSubpaths } from './node-package-subpaths.ts';
import type { NodeSourceSpecifier } from './node-source-specifiers.ts';

const PACKAGE_MANIFEST = 'package.json';
const FILE_SUFFIXES = ['', '.js', '.json', '.node'] as const;
const INDEX_SUFFIXES = ['.js', '.json', '.node'] as const;

function missingPath(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function metadata(directory: string): Promise<unknown> {
  try {
    const bytes = await readFile(path.join(directory, PACKAGE_MANIFEST));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value;
  } catch (error) {
    if (!missingPath(error)) throw error;
    return undefined;
  }
}

export async function nodePackageHasExports(directory: string): Promise<boolean> {
  const value = await metadata(directory);
  return record(value) && value['exports'] !== undefined && value['exports'] !== null;
}

export async function nodePackageDirectory(alias: string): Promise<boolean> {
  try {
    return (await stat(alias)).isDirectory();
  } catch (error) {
    if (!missingPath(error)) throw error;
    return false;
  }
}

/** External imports targets use packageResolve directory ancestry, independent of conditions. */
export async function nodePackageImportsDirectory(
  importer: string,
  packageName: string,
): Promise<string | undefined> {
  if (
    !path.isAbsolute(importer) ||
    nodePackageName(packageName) !== packageName ||
    !/^(?:@[\w.-]+\/)?[\w.-]+$/u.test(packageName) ||
    packageName.split('/').some((part) => ['.', '..', 'node_modules'].includes(part))
  )
    throw new AuditError('Node package import has an unproved external target');
  for (let directory = path.dirname(importer); ; directory = path.dirname(directory)) {
    const alias = path.join(directory, 'node_modules', packageName);
    if (await nodePackageDirectory(alias)) return alias;
    if (path.dirname(directory) === directory) return undefined;
  }
}

async function filesAt(logical: string, suffixes: readonly string[]): Promise<boolean> {
  for (const suffix of suffixes)
    try {
      if ((await stat(`${logical}${suffix}`)).isFile()) return true;
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
  return false;
}

async function directoryTarget(logical: string): Promise<boolean> {
  if (!(await nodePackageDirectory(logical))) return false;
  const value = await metadata(logical);
  // A truthy main must reach Node's resolver even if its target is missing or invalid.
  // Node throws for that case instead of continuing with another package root.
  if (record(value) && Boolean(value['main'])) {
    if (typeof value['main'] === 'string') nodePackageMain(logical, value['main']);
    return true;
  }
  return filesAt(path.join(logical, 'index'), INDEX_SUFFIXES);
}

/** Lookup DATA only; the selected root and its resolved files still require closed trace proof. */
export async function nodePackageLegacySubpath(
  importer: string,
  directory: string,
  specifier: string,
  packageName: string,
): Promise<boolean> {
  if (specifier === packageName)
    throw new AuditError('Legacy Node package lookup requires a subpath');
  const target = nodePackageSubpaths(specifier, packageName, undefined).targets[0];
  if (target === undefined) throw new AuditError('Legacy Node package lookup lacks a subpath');
  const logical = path.resolve(directory, target);
  const directoryOnly = specifier.endsWith('/');
  if (
    (directoryOnly || !(await filesAt(logical, FILE_SUFFIXES))) &&
    !(await directoryTarget(logical))
  )
    return false;
  // No MODULE_NOT_FOUND catch: invalid main/configuration and resolver errors must propagate.
  createRequire(importer).resolve(directoryOnly ? `${logical}${path.sep}` : logical);
  return true;
}

/** CJS continues past an absent legacy entry; ESM stops at its first directory. */
export async function nodePackageCandidate(
  importer: string,
  directory: string,
  load: NodeSourceSpecifier,
  packageName: string,
): Promise<boolean> {
  if (load.kind === 'import') return nodePackageDirectory(directory);
  if (await nodePackageHasExports(directory)) return true;
  if (load.specifier !== packageName)
    return nodePackageLegacySubpath(importer, directory, load.specifier, packageName);
  // The caller already considered every bare file candidate before directory/main lookup.
  if (!(await directoryTarget(directory))) return false;
  createRequire(importer).resolve(directory);
  return true;
}
