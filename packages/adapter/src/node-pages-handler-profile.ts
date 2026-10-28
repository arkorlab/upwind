import { createHash } from 'node:crypto';

const MAX_FILES = 256;
const MAX_FILE_BYTES = 16_777_216;
const MAX_TOTAL_BYTES = 67_108_864;
const MAX_PATH_LENGTH = 240;
const SHA256 = /^[a-f\d]{64}$/u;
const EXPECTED_FIELDS = ['files', 'inputs', 'schema', 'semanticClosure', 'status'];
const INPUT_FIELDS = ['fixture', 'image', 'lock', 'next', 'packageManager', 'swc'];
const FILE_FIELDS = ['name', 'sha256', 'source'];

export interface PagesHandlerProfileFile {
  readonly name: string;
  readonly sha256: string;
  readonly source: string;
}

export interface PagesHandlerProfile {
  readonly schema: 1;
  readonly status: 'UNQUALIFIED';
  readonly semanticClosure: 'unmapped:getHandler';
  readonly inputs: Readonly<
    Record<'fixture' | 'image' | 'lock' | 'next' | 'packageManager' | 'swc', string>
  >;
  readonly files: readonly PagesHandlerProfileFile[];
}

interface ReviewedPagesHandler {
  readonly role: 'getHandler';
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid unqualified Pages profile object');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(actual) !==
    JSON.stringify(expected.toSorted((left, right) => left.localeCompare(right)))
  )
    throw new TypeError('Unexpected unqualified Pages profile fields');
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value))
    throw new TypeError('Invalid unqualified Pages profile digest');
  return value;
}

function fileName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PATH_LENGTH ||
    !/^(?:pages|chunks)\/[\w./[\]-]+\.js$/u.test(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    value.endsWith('-manifest.js')
  )
    throw new TypeError('Invalid unqualified Pages profile path');
  return value;
}

function profileFile(value: unknown): PagesHandlerProfileFile {
  const row = record(value);
  keys(row, FILE_FIELDS);
  const name = fileName(row['name']);
  const sha256 = digest(row['sha256']);
  const source = row['source'];
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source) > MAX_FILE_BYTES ||
    source.includes('\0') ||
    /sourceMappingURL\s*=\s*data:/u.test(source) ||
    createHash('sha256').update(source).digest('hex') !== sha256
  )
    throw new TypeError('Invalid unqualified Pages profile source');
  return Object.freeze({ name, sha256, source });
}

function inputDigests(value: unknown): PagesHandlerProfile['inputs'] {
  const row = record(value);
  keys(row, INPUT_FIELDS);
  return Object.freeze({
    fixture: digest(row['fixture']),
    image: digest(row['image']),
    lock: digest(row['lock']),
    next: digest(row['next']),
    packageManager: digest(row['packageManager']),
    swc: digest(row['swc']),
  });
}

/** Parses bounded, self-consistent DATA; this never certifies its provenance or executable meaning. */
export function parsePagesHandlerProfile(value: unknown): PagesHandlerProfile {
  const row = record(value);
  keys(row, EXPECTED_FIELDS);
  if (
    row['schema'] !== 1 ||
    row['status'] !== 'UNQUALIFIED' ||
    row['semanticClosure'] !== 'unmapped:getHandler' ||
    !Array.isArray(row['files']) ||
    row['files'].length === 0 ||
    row['files'].length > MAX_FILES
  )
    throw new TypeError('Invalid unqualified Pages profile boundary');
  const files: PagesHandlerProfileFile[] = [];
  const sources = row['files'];
  let previous = '';
  let bytes = 0;
  for (const source of sources) {
    const file = profileFile(source);
    if (file.name <= previous) throw new TypeError('Unordered or duplicate Pages profile paths');
    previous = file.name;
    bytes += Buffer.byteLength(file.source);
    if (bytes > MAX_TOTAL_BYTES) throw new TypeError('Pages profile byte budget exceeded');
    files.push(file);
  }
  return Object.freeze({
    files: Object.freeze(files),
    inputs: inputDigests(row['inputs']),
    schema: 1,
    semanticClosure: 'unmapped:getHandler',
    status: 'UNQUALIFIED',
  });
}

/** The reviewed registry is deliberately empty: candidate hashes and supplied catalogs grant nothing. */
export function matchReviewedPagesHandler(candidate: unknown): ReviewedPagesHandler | undefined {
  parsePagesHandlerProfile(candidate);
  return undefined;
}
