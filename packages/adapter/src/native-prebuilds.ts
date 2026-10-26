import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { AuditError } from './dependencies.ts';

const MAX_ENTRIES = 4096;
const MISSING_FILE = 'ENOENT';
export interface NativePrebuildTarget {
  readonly abi: string;
  readonly uv: string;
}
interface Tuple {
  readonly name: string;
  readonly architectures: readonly string[];
}
interface Tags {
  readonly file: string;
  specificity: number;
  runtime?: string;
  abi?: string;
  uv?: string;
  armv?: string;
  libc?: string;
  napi?: true;
}
function refuse(reason: string): never {
  throw new AuditError(`Native prebuild ${reason}; refusing publication`);
}
function bounded(names: readonly string[]): void {
  if (names.length > MAX_ENTRIES) refuse('directory exceeds its entry limit');
  for (const name of names)
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\'))
      refuse('directory entry is not a basename');
}

/** The reviewed loader's default Node/Linux/x64/glibc selectors, never caller overrides. */
function targetOfHost(): NativePrebuildTarget {
  const report = process.report.getReport();
  const header = typeof report === 'object' && 'header' in report ? report.header : undefined;
  const variables = process.config.variables;
  if (
    header === null ||
    typeof header !== 'object' ||
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    'window' in globalThis ||
    '__webpack_require__' in globalThis ||
    'electron' in process.versions ||
    'nw' in process.versions ||
    !('glibcVersionRuntime' in header) ||
    typeof header.glibcVersionRuntime !== 'string' ||
    header.glibcVersionRuntime === '' ||
    existsSync('/etc/alpine-release') ||
    ('arm_version' in variables && Boolean(variables.arm_version))
  )
    refuse('requires the default Node Linux x64 glibc host');
  const abi = process.versions.modules;
  const uv = process.versions.uv.split('.', 1)[0];
  if (uv === undefined || !/^\d+$/u.test(abi) || !/^\d+$/u.test(uv))
    refuse('host ABI or libuv version is unproved');
  return { abi, uv };
}
function tuple(name: string): Tuple | undefined {
  const parts = name.split('-');
  const platform = parts[0];
  const architectures = parts[1]?.split('+');
  if (
    architectures === undefined ||
    platform !== 'linux' ||
    parts.length !== 2 ||
    architectures.includes('') ||
    !architectures.includes('x64')
  )
    return undefined;
  return { name, architectures };
}

/** Selection DATA only. The caller must still prove the selected regular file's ownership. */
export function nodeGypPrebuildDirectory(names: readonly string[]): string | undefined {
  bounded(names);
  const candidates = names.flatMap((name) => {
    const value = tuple(name);
    return value === undefined ? [] : [value];
  });
  const ordered = candidates.toSorted(
    (left, right) => left.architectures.length - right.architectures.length,
  );
  const first = ordered[0];
  if (first !== undefined && ordered[1]?.architectures.length === first.architectures.length)
    refuse('tuple selection depends on filesystem order');
  return first?.name;
}
function tagsOf(file: string): Tags | undefined {
  const parts = file.split('.');
  if (parts.pop() !== 'node') return undefined;
  const tags: Tags = { file, specificity: 0 };
  for (const tag of parts) {
    if (['electron', 'node', 'node-webkit'].includes(tag)) tags.runtime = tag;
    else if (tag === 'napi') tags.napi = true;
    else if (tag.startsWith('abi')) tags.abi = tag.slice('abi'.length);
    else if (tag.startsWith('uv')) tags.uv = tag.slice(2);
    else if (tag.startsWith('armv')) tags.armv = tag.slice('armv'.length);
    else if (['glibc', 'musl'].includes(tag)) tags.libc = tag;
    else continue;
    tags.specificity += 1;
  }
  return tags;
}
function matches(tags: Tags, target: NativePrebuildTarget): boolean {
  if (tags.runtime !== undefined && tags.runtime !== 'node') return false;
  if (Boolean(tags.abi) && tags.abi !== target.abi && tags.napi !== true) return false;
  if (Boolean(tags.uv) && tags.uv !== target.uv) return false;
  if (tags.armv !== undefined && tags.armv !== '') return false;
  return tags.libc === undefined || tags.libc === '' || tags.libc === 'glibc';
}
function compare(left: Tags, right: Tags): number {
  if (left.runtime !== right.runtime) return left.runtime === 'node' ? -1 : 1;
  if (left.abi !== right.abi) return left.abi === undefined || left.abi === '' ? 1 : -1;
  return right.specificity - left.specificity;
}

/** The exact reviewed tag precedence, refusing both ties and inconsistent ABI comparators. */
export function nodeGypPrebuildFile(
  names: readonly string[],
  target: NativePrebuildTarget,
): string | undefined {
  bounded(names);
  if (!/^\d+$/u.test(target.abi) || !/^\d+$/u.test(target.uv))
    refuse('target ABI or libuv version is unproved');
  const candidates = names.flatMap((name) => {
    const tags = tagsOf(name);
    return tags !== undefined && matches(tags, target) ? [tags] : [];
  });
  const abiByRuntime = new Map<string | undefined, Set<string | undefined>>();
  for (const candidate of candidates) {
    const values = abiByRuntime.get(candidate.runtime) ?? new Set<string | undefined>();
    values.add(candidate.abi);
    abiByRuntime.set(candidate.runtime, values);
  }
  // Distinct truthy ABI values can make the original comparator non-antisymmetric.
  // Empty ABI tags are unproved; ordinary ABI presence versus absence is ordered.
  for (const values of abiByRuntime.values()) {
    const present = [...values].filter((value) => value !== undefined);
    if (values.has('') || present.length > 1) refuse('ABI selector order is ambiguous');
  }
  const ordered = candidates.toSorted(compare);
  const first = ordered[0];
  const second = ordered[1];
  if (first !== undefined && second !== undefined && compare(first, second) === 0)
    refuse('binary selection depends on filesystem order');
  return first?.file;
}
async function namesAt(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === MISSING_FILE) return [];
    throw error;
  }
}

/** Package-local prebuilds only; execPath-nearby discovery is not a closed artifact. */
export async function nodeGypPrebuild(root: string): Promise<string | undefined> {
  const prebuilds = path.join(root, 'prebuilds');
  const selected = nodeGypPrebuildDirectory(await namesAt(prebuilds));
  if (selected === undefined) return undefined;
  const target = targetOfHost();
  const directory = path.join(prebuilds, selected);
  const file = nodeGypPrebuildFile(await namesAt(directory), target);
  return file === undefined ? undefined : path.join(directory, file);
}
