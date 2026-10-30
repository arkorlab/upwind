import { createHash, Hash } from 'node:crypto';
import { createRequire, Module } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProxy } from 'node:util/types';

import { isGuardedNodeVersion, type GuardedNodeVersion } from '@stayingupwind/core/util';

import { installNodeFixedLoadHooks, type NodeFixedLoadHooks } from './node-fixed-load-hooks.ts';
import {
  assertNodeFixedLoadScopeHealthy,
  createNodeFixedLoadScope,
  enterNodeFixedLoadScope,
  leaveNodeFixedLoadScope,
} from './node-fixed-load-scope.ts';
import {
  nodeInitializationBuiltins,
  type NodeInitializationBuiltins,
} from './node-initialization-builtins.ts';
import {
  assertNodeJwtRealm,
  captureNodeJwtRealm,
  captureNodeNextJwtRealm,
  withNodeJwtRealmErrorHooks,
  type NodeJwtRealm,
} from './node-jwt-realm.ts';
import {
  assertNodeJwtSemverCache,
  assertNodeJwtSemverStart,
  createNodeJwtSemverGuard,
  rememberNodeJwtSemver,
  type NodeJwtSemverGuard,
} from './node-jwt-semver-guard.ts';
import { initializeNodeNextRequireHook } from './node-next-hook-bootstrap.ts';
import {
  assertNodeWsModuleContext,
  captureNodeWsModuleContext,
  type NodeWsModuleContext,
} from './node-ws-module-context.ts';

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
const proxyCheck = isProxy;
const PROFILE = 'next-16.4.3-jsonwebtoken-ncc-v1';
const SHA256 = '056c2dddba96faa35f4dc0740228a241990561290ff3bd5456c7c7dbc5a7a6b9';
const SOURCE_BYTES = 121_051;
const WS_PROFILE = 'next-16.4.3-ws-ncc-v1';
const WS_SHA256 = 'af354cb13a11abe910cdbcb70943cb450b01b24f322026ae3f88d428d148395d';
const WS_BYTES = 45_840;
const WS_OPTIONAL_TARGETS = ['bufferutil', 'utf-8-validate'] as const;
const JWT_SUFFIX = '/dist/compiled/jsonwebtoken/index.js';
const SEMVER_PROFILE = 'next-16.4.3-semver-noop-v1';
const SEMVER_SHA256 = '34c5853dd094229baa28a8b15b86e2143eeb0de0360530798ef3e9a7890942b6';
const SEMVER_BYTES = 471;
const JWT_BUILTINS = ['buffer', 'crypto', 'stream', 'util'] as const;
const WS_BUILTINS = [
  'crypto',
  'events',
  'http',
  'https',
  'net',
  'stream',
  'tls',
  'url',
  'zlib',
] as const;
const SEMVER_SPECIFIER = 'next/dist/lib/semver-noop';
const MISSING_LOAD_SOURCE = 'missing qualified load source';

/** Build-produced data. It does not grant a compiler exception on its own. */
interface GuardRecord {
  readonly schema: 1;
  readonly nodeVersion: GuardedNodeVersion;
  readonly archivePath: string;
}
export type NodeJwtGuardRecord = GuardRecord &
  (
    | {
        readonly profile: typeof PROFILE;
        readonly sha256: typeof SHA256;
        readonly bytes: typeof SOURCE_BYTES;
      }
    | {
        readonly profile: typeof WS_PROFILE;
        readonly sha256: typeof WS_SHA256;
        readonly bytes: typeof WS_BYTES;
      }
  );

interface GuardedSource {
  readonly filename: string;
  readonly record:
    | NodeJwtGuardRecord
    | (GuardRecord & {
        readonly profile: typeof SEMVER_PROFILE;
        readonly sha256: typeof SEMVER_SHA256;
        readonly bytes: typeof SEMVER_BYTES;
      });
  readonly resolveOptional: ((specifier: string) => string) | undefined;
  readonly context: NodeWsModuleContext;
  readonly semver: NodeJwtSemverGuard | undefined;
  readonly semverResolution:
    | { readonly resolve: NodeJS.RequireResolve; readonly filename: string }
    | undefined;
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
  const nodeVersion = record['nodeVersion'];
  if (
    !isGuardedNodeVersion(nodeVersion) ||
    nodeVersion !== process.versions.node ||
    record['schema'] !== 1 ||
    typeof record['archivePath'] !== 'string' ||
    !archiveName(record['archivePath'])
  )
    fail('invalid build-produced source record');
  const common = {
    schema: 1,
    nodeVersion,
    archivePath: record['archivePath'],
  } as const;
  if (
    record['profile'] === PROFILE &&
    record['sha256'] === SHA256 &&
    record['bytes'] === SOURCE_BYTES
  )
    return freeze({ ...common, profile: PROFILE, sha256: SHA256, bytes: SOURCE_BYTES });
  if (
    record['profile'] === WS_PROFILE &&
    record['sha256'] === WS_SHA256 &&
    record['bytes'] === WS_BYTES
  )
    return freeze({ ...common, profile: WS_PROFILE, sha256: WS_SHA256, bytes: WS_BYTES });
  return fail('invalid fixed source profile');
}

function guardedSource(
  root: string,
  record: GuardedSource['record'],
  require: NodeJS.Require,
): GuardedSource {
  const filename = path.resolve(root, record.archivePath);
  if (require.resolve(filename) !== filename)
    fail('qualified source is not a canonical regular archive file');
  // Capture a private resolver at the actual source's CommonJS coordinate. A dependency that
  // becomes resolvable is not covered by this absent-only profile, even if another route owns it.
  const resolveOptional =
    record.profile === WS_PROFILE ? createRequire(filename).resolve : undefined;
  return freeze({
    filename,
    record,
    resolveOptional,
    context: sourceContext(filename),
    semver: undefined,
    semverResolution: undefined,
  });
}

function sourceContext(filename: string): NodeWsModuleContext {
  const directory = path.dirname(filename);
  return captureNodeWsModuleContext({
    prototype: Module.prototype,
    isProxy: proxyCheck,
    parentDescriptor: descriptorOf(Module.prototype, 'parent'),
    directory,
    filename,
    paths: defaultModulePaths(directory),
  });
}

/** The fixed JWT proof already seals this same-root dependency in the physical archive. */
function sourceGroup(root: string, value: unknown, require: NodeJS.Require): GuardedSource[] {
  const record = sourceRecord(value);
  const primary = guardedSource(root, record, require);
  if (record.profile !== PROFILE) return [primary];
  if (!record.archivePath.endsWith(JWT_SUFFIX)) fail('invalid fixed JWT archive coordinate');
  const dependency = guardedSource(
    root,
    {
      schema: 1,
      profile: SEMVER_PROFILE,
      nodeVersion: record.nodeVersion,
      archivePath: `${record.archivePath.slice(0, -JWT_SUFFIX.length)}/dist/lib/semver-noop.js`,
      sha256: SEMVER_SHA256,
      bytes: SEMVER_BYTES,
    },
    require,
  );
  const semver = createNodeJwtSemverGuard({
    filename: dependency.filename,
    isProxy: proxyCheck,
    cache: require.cache,
  });
  const semverResolution = freeze({
    resolve: createRequire(primary.filename).resolve,
    filename: dependency.filename,
  });
  return [freeze({ ...primary, semver, semverResolution }), freeze({ ...dependency, semver })];
}

function defaultModulePaths(directory: string): readonly string[] {
  const method: unknown = descriptorOf(Module, '_nodeModulePaths')?.value;
  if (typeof method !== 'function') fail('missing default Node module paths');
  const paths: unknown = apply(method, Module, [directory]);
  if (
    !Array.isArray(paths) ||
    !paths.every((entry: unknown): entry is string => typeof entry === 'string')
  )
    fail('invalid default Node module paths');
  return paths;
}

function assertOptionalTargetsAbsent(source: GuardedSource): void {
  const resolve = source.resolveOptional;
  if (resolve === undefined) return;
  for (const target of WS_OPTIONAL_TARGETS) {
    try {
      resolve(target);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && !proxyCheck(error)
          ? descriptorOf(error, 'code')
          : undefined;
      if (code !== undefined && hasOwn(code, 'value') && code.value === 'MODULE_NOT_FOUND')
        continue;
      fail('optional WebSocket target could not be proved absent');
    }
    fail('optional WebSocket native target is present');
  }
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

function assertSource(
  contents: unknown,
  source: GuardedSource,
  realm: NodeJwtRealm,
  receiver: unknown,
): void {
  // This runs at evaluation, after any application modules preceding this dependency.
  assertNodeJwtRealm(realm);
  if (
    typeof contents !== 'string' ||
    byteLength(contents, 'utf8') !== source.record.bytes ||
    sourceDigest(contents) !== source.record.sha256
  )
    fail('qualified source changed before evaluation');
  assertNodeWsModuleContext(source.context, receiver);
  const dependency = source.semverResolution;
  if (dependency !== undefined && dependency.resolve(SEMVER_SPECIFIER) !== dependency.filename)
    fail('fixed JWT dependency resolved outside its qualified source');
  if (source.semver !== undefined) {
    if (source.record.profile === SEMVER_PROFILE) assertNodeJwtSemverStart(source.semver, receiver);
    else assertNodeJwtSemverCache(source.semver);
  }
  assertOptionalTargetsAbsent(source);
  assertNodeJwtRealm(realm);
  assertNodeWsModuleContext(source.context, receiver);
}

function loadRequests(source: GuardedSource): readonly string[] {
  if (source.record.profile === PROFILE) return [...JWT_BUILTINS, SEMVER_SPECIFIER];
  if (source.record.profile === WS_PROFILE) return [...WS_BUILTINS, ...WS_OPTIONAL_TARGETS];
  return [];
}

function assertLoadState(
  source: GuardedSource,
  request: unknown,
  parent: unknown,
  realm: NodeJwtRealm,
): void {
  assertNodeJwtRealm(realm);
  assertNodeWsModuleContext(source.context, parent);
  if (
    request === SEMVER_SPECIFIER &&
    source.semverResolution !== undefined &&
    source.semver !== undefined
  ) {
    if (source.semverResolution.resolve(SEMVER_SPECIFIER) !== source.semverResolution.filename)
      fail('fixed JWT dependency resolved outside its qualified source');
    assertNodeJwtSemverCache(source.semver);
  }
  if (
    source.record.profile === WS_PROFILE &&
    WS_OPTIONAL_TARGETS.some((target) => target === request)
  )
    assertOptionalTargetsAbsent(source);
}

/**
 * The fixed Node loader calls _compile immediately before executing CommonJS source.
 * Keep its source, receiver and arguments unchanged; no preload or evaluation retry.
 * The WS profile additionally requires both optional native loads to remain unresolved.
 * Reviewed Node 24.22.1 and 26.13.0: lib/internal/modules/cjs/loader.js and esm/translators.js.
 */
function installPreparedGuards(
  serverUrl: string,
  records: readonly unknown[],
  hook: ReturnType<typeof initializeNodeNextRequireHook> | undefined,
  captured: NodeInitializationBuiltins,
): void {
  const server = fileURLToPath(serverUrl);
  const root = path.dirname(path.dirname(server));
  const require = createRequire(serverUrl);
  const prepared = records.flatMap((record) => sourceGroup(root, record, require));
  const scope = createNodeFixedLoadScope({
    sources: prepared.flatMap((source) => {
      const requests = loadRequests(source);
      return requests.length === 0
        ? []
        : [{ filename: source.filename, directory: path.dirname(source.filename), requests }];
    }),
    isProxy: proxyCheck,
  });
  const byFilename = new Map<string, GuardedSource>();
  const findSource = byFilename.get.bind(byFilename);
  const names = new Set(prepared.map((source) => source.filename));
  if (names.size !== prepared.length) fail('duplicate qualified source');
  for (const source of prepared)
    if (descriptorOf(require.cache, source.filename) !== undefined)
      fail('qualified source already evaluated');
  const loader = Module.prototype;
  const descriptor = descriptorOf(loader, '_compile');
  const original: unknown = descriptor?.value;
  if (typeof original !== 'function' || descriptor === undefined || !hasOwn(descriptor, 'value'))
    fail('missing default CommonJS evaluation method');
  const originalCompile = original;
  let realm: NodeJwtRealm;
  let hookReady = false;
  const builtins = new Map<string, unknown>();
  const builtin = builtins.get.bind(builtins);
  function compile(this: unknown, ...args: unknown[]): unknown {
    const filename = args[1];
    const source = typeof filename === 'string' ? findSource(filename) : undefined;
    if (hookReady) {
      if (source === undefined) hook?.assertCachedLoad();
      else hook?.assert();
    }
    if (hook !== undefined && filename === hook.filename) fail('Next hook cannot be reevaluated');
    if (source === undefined) return apply(originalCompile, this, args);
    return withNodeJwtRealmErrorHooks(realm, () => {
      assertSource(args[0], source, realm, this);
      const lease = enterNodeFixedLoadScope(scope, source.filename, this);
      try {
        const result: unknown = apply(originalCompile, this, args);
        if (lease !== undefined) assertNodeFixedLoadScopeHealthy(scope, lease);
        if (source.record.profile === SEMVER_PROFILE && source.semver !== undefined)
          rememberNodeJwtSemver(source.semver, this);
        return result;
      } finally {
        if (lease !== undefined) leaveNodeFixedLoadScope(scope, lease);
      }
    });
  }
  let hooks: NodeFixedLoadHooks | undefined;
  try {
    hooks = installNodeFixedLoadHooks(scope, {
      health() {
        if (hookReady) hook?.assertCachedLoad();
      },
      before({ filename, request, parent }) {
        const source = findSource(filename) ?? fail(MISSING_LOAD_SOURCE);
        assertLoadState(source, request, parent, realm);
      },
      after({ filename, request, parent }, result) {
        const source = findSource(filename) ?? fail(MISSING_LOAD_SOURCE);
        assertLoadState(source, request, parent, realm);
        if (typeof request !== 'string') fail('nonliteral qualified dependency');
        if (request === SEMVER_SPECIFIER && source.semverResolution !== undefined) {
          const module: unknown = descriptorOf(
            require.cache,
            source.semverResolution.filename,
          )?.value;
          if (
            typeof module !== 'object' ||
            module === null ||
            descriptorOf(module, 'exports')?.value !== result
          )
            fail('fixed JWT dependency returned an unobserved namespace');
        } else if (WS_OPTIONAL_TARGETS.some((target) => target === request)) {
          fail('optional WebSocket load unexpectedly returned a value');
        } else if (builtin(request) !== result) {
          fail('fixed dependency returned a substituted builtin');
        }
      },
      failure({ filename, request, parent }, error) {
        const source = findSource(filename) ?? fail(MISSING_LOAD_SOURCE);
        assertLoadState(source, request, parent, realm);
        const code =
          typeof error === 'object' && error !== null && !proxyCheck(error)
            ? descriptorOf(error, 'code')
            : undefined;
        return (
          source.record.profile === WS_PROFILE &&
          WS_OPTIONAL_TARGETS.some((target) => target === request) &&
          code !== undefined &&
          hasOwn(code, 'value') &&
          code.value === 'MODULE_NOT_FOUND'
        );
      },
    });
    // Context evidence must capture the transparent require boundary, not its predecessor.
    const sources = prepared.map((source) =>
      freeze({ ...source, context: sourceContext(source.filename) }),
    );
    for (const source of sources) byFilename.set(source.filename, source);
    defineProperty(loader, '_compile', { ...descriptor, value: compile });
    for (const [name, value] of captured.values) builtins.set(name, value);
    realm =
      hook === undefined
        ? captureNodeJwtRealm(globalThis, process, captured.basis)
        : captureNodeNextJwtRealm(globalThis, process, captured.basis);
    hook?.complete({ load: hooks.load, require: hooks.require, compile });
    hookReady = true;
    installation.completed = true;
  } catch (error) {
    defineProperty(loader, '_compile', descriptor);
    hooks?.restore();
    throw error;
  }
}

/** Install fixed Node-only initialization before any application entry or instrumentation. */
export function installNodeJwtGuards(
  serverUrl: string,
  records: readonly unknown[],
  nextHook?: unknown,
): void {
  if (nextHook === undefined && records.length === 0) return;
  if (installation.completed) fail('initialization guard already installed');
  if (!isGuardedNodeVersion(process.versions.node) || process.execArgv.length > 0)
    fail('requires a fixed default Node 24.22.1 or 26.13.0 loader');
  const captured = nodeInitializationBuiltins(createRequire(serverUrl));
  const hook =
    nextHook === undefined ? undefined : initializeNodeNextRequireHook(serverUrl, nextHook);
  try {
    installPreparedGuards(serverUrl, records, hook, captured);
  } catch (error) {
    hook?.restore();
    throw error;
  }
}
