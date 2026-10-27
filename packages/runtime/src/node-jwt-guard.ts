import { createHash, Hash } from 'node:crypto';
import { createRequire, Module } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNodeJwtRealm, captureNodeJwtRealm, type NodeJwtRealm } from './node-jwt-realm.ts';

const apply = Reflect.apply;
const descriptorOf = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const NativeError = Error;
const sourceHash = createHash;
const updateHash: unknown = descriptorOf(Hash.prototype, 'update')?.value;
const finishHash: unknown = descriptorOf(Hash.prototype, 'digest')?.value;
const byteLength = Buffer.byteLength.bind(Buffer);
const PROFILE = 'next-16.4.3-jsonwebtoken-ncc-v1';
const SHA256 = '056c2dddba96faa35f4dc0740228a241990561290ff3bd5456c7c7dbc5a7a6b9';
const SOURCE_BYTES = 121_051;

/** Build-produced data. It does not grant a compiler exception on its own. */
export interface NodeJwtGuardRecord {
  readonly schema: 1;
  readonly profile: typeof PROFILE;
  readonly nodeVersion: '24.22.1';
  readonly archivePath: string;
  readonly sha256: typeof SHA256;
  readonly bytes: typeof SOURCE_BYTES;
}

interface GuardedSource {
  readonly filename: string;
  readonly record: NodeJwtGuardRecord;
}

const installation = { completed: false };

function fail(reason: string): never {
  throw new NativeError(`Unsupported Node JWT initialization: ${reason}`);
}

function archiveName(name: string): boolean {
  return (
    name !== '' &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.includes(':') &&
    !name.startsWith('/') &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function sourceRecord(value: unknown): NodeJwtGuardRecord {
  if (typeof value !== 'object' || value === null) fail('invalid source record');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!hasOwn(descriptor, 'value')) fail('source record contains accessors');
    record[name] = descriptor.value;
  }
  if (
    record['schema'] !== 1 ||
    record['profile'] !== PROFILE ||
    record['nodeVersion'] !== '24.22.1' ||
    record['sha256'] !== SHA256 ||
    record['bytes'] !== SOURCE_BYTES ||
    typeof record['archivePath'] !== 'string' ||
    !archiveName(record['archivePath'])
  )
    fail('invalid build-produced source record');
  return freeze({
    schema: 1,
    profile: PROFILE,
    nodeVersion: '24.22.1',
    archivePath: record['archivePath'],
    sha256: SHA256,
    bytes: SOURCE_BYTES,
  });
}

function guardedSource(root: string, value: unknown, require: NodeJS.Require): GuardedSource {
  const record = sourceRecord(value);
  const filename = path.resolve(root, record.archivePath);
  if (require.resolve(filename) !== filename)
    fail('qualified source is not a canonical regular archive file');
  return freeze({ filename, record });
}

function sourceDigest(contents: string): string {
  if (typeof updateHash !== 'function' || typeof finishHash !== 'function')
    fail('missing native digest methods');
  const hash = sourceHash('sha256');
  apply(updateHash, hash, [contents, 'utf8']);
  const value: unknown = apply(finishHash, hash, ['hex']);
  if (typeof value !== 'string') fail('invalid source digest');
  return value;
}

function assertSource(contents: unknown, source: GuardedSource, realm: NodeJwtRealm): void {
  // This runs at evaluation, after any application modules preceding this dependency.
  assertNodeJwtRealm(realm);
  if (
    typeof contents !== 'string' ||
    byteLength(contents, 'utf8') !== source.record.bytes ||
    sourceDigest(contents) !== source.record.sha256
  )
    fail('qualified source changed before evaluation');
}

/**
 * The fixed Node loader calls _compile immediately before executing CommonJS source.
 * Keep its source, receiver and arguments unchanged; no preload or evaluation retry.
 * Node 24.22.1: lib/internal/modules/cjs/loader.js and esm/translators.js.
 */
export function installNodeJwtGuards(serverUrl: string, records: readonly unknown[]): void {
  if (records.length === 0) return;
  if (installation.completed) fail('initialization guard already installed');
  if (process.versions.node !== '24.22.1' || process.execArgv.length > 0)
    fail('requires the fixed default Node 24.22.1 loader');
  const server = fileURLToPath(serverUrl);
  const root = path.dirname(path.dirname(server));
  const require = createRequire(serverUrl);
  const sources = records.map((record) => guardedSource(root, record, require));
  const byFilename = new Map(sources.map((source) => [source.filename, source]));
  const findSource = byFilename.get.bind(byFilename);
  const names = new Set(sources.map((source) => source.filename));
  if (names.size !== sources.length) fail('duplicate qualified source');
  for (const source of sources)
    if (descriptorOf(require.cache, source.filename) !== undefined)
      fail('qualified source already evaluated');
  const loader = Module.prototype;
  const descriptor = descriptorOf(loader, '_compile');
  const original: unknown = descriptor?.value;
  if (typeof original !== 'function' || descriptor === undefined || !hasOwn(descriptor, 'value'))
    fail('missing default CommonJS evaluation method');
  const originalCompile = original;
  let realm: NodeJwtRealm;
  function compile(this: unknown, ...args: unknown[]): unknown {
    const filename = args[1];
    const source = typeof filename === 'string' ? findSource(filename) : undefined;
    if (source !== undefined) assertSource(args[0], source, realm);
    return apply(originalCompile, this, args);
  }
  defineProperty(loader, '_compile', { ...descriptor, value: compile });
  try {
    const buffer: unknown = require('node:buffer');
    const crypto: unknown = require('node:crypto');
    const stream: unknown = require('node:stream');
    const util: unknown = require('node:util');
    realm = captureNodeJwtRealm(globalThis, process, {
      buffer,
      crypto,
      stream,
      util,
      loader: Module,
    });
    installation.completed = true;
  } catch (error) {
    defineProperty(loader, '_compile', descriptor);
    throw error;
  }
}
