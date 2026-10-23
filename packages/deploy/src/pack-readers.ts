import type { DeploymentBundle, FunctionSpec } from '@stayingupwind/core/bundle';
import type { ApprovedPackReaderRollout, ScopePackReaders } from '@stayingupwind/host/cache';

/** Every immutable bundle Function, including one a custom host might let reach the same scope. */
function consumersOf(bundle: DeploymentBundle): readonly (readonly [string, FunctionSpec])[] {
  const functions = bundle.functions;
  return [
    ['app', functions.app],
    ...Object.entries(functions.split ?? {}).map(
      ([name, spec]) => [`split:${name}`, spec] as const,
    ),
    ...(functions.middleware === undefined ? [] : [['middleware', functions.middleware] as const]),
    ...(functions.workflow === undefined ? [] : [['workflow', functions.workflow] as const]),
    ...Object.entries(functions.durableObjects ?? {}).map(
      ([name, spec]) => [`durable-object:${name}`, spec] as const,
    ),
  ];
}

const ASCII_CONTROL_END = 32;
const ASCII_DELETE = 127;
const INVALID_MODULE_PARTS = ['', '.', '..'];

/** Module identities cannot contain ASCII controls, even when an uploader accepts their bytes. */
function hasControlCharacter(name: string): boolean {
  for (let at = 0; at < name.length; at += 1) {
    const code = name.codePointAt(at);
    if (code !== undefined && (code === ASCII_DELETE || code < ASCII_CONTROL_END)) return true;
  }
  return false;
}

/** An uploaded module cannot alias or override the audited main module or one of its imports. */
function unambiguousModules(spec: FunctionSpec): boolean {
  const seen = new Set<string>();
  for (const module of spec.modules) {
    const parts = module.name.split('/');
    if (
      module.name.includes('\\') ||
      module.name.includes(':') ||
      hasControlCharacter(module.name) ||
      parts.some((part) => INVALID_MODULE_PARTS.includes(part)) ||
      seen.has(module.name)
    )
      return false;
    seen.add(module.name);
  }
  return true;
}

/**
 * Bind a trusted all-reader approval to the actual immutable Function inventory. All hashes already
 * belong to the collected module blobs; this performs no hashing, storage read or capability
 * probe. Missing, custom or unapproved bytes leave the deployment on its existing version-one
 * contract. Never build `approved` from fields the project's bundle claims about itself.
 */
export function scopePackReadersOf(
  bundle: DeploymentBundle,
  approved: ApprovedPackReaderRollout | undefined,
): ScopePackReaders | undefined {
  if (approved === undefined) return undefined;
  // Approve only whole main modules that inline the audited reader. hostModuleSha256 identifies
  // that host's source provenance; it is not a claim that a separate uploaded module has that hash.
  // Application modules may vary. A wrapper importing an unapproved reader is never an approval.
  const byDigest = new Map(approved.functions.map((reader) => [reader.mainModuleSha256, reader]));
  // Ambiguous policy entries are not an approval, even if their duplicate digest happens to match.
  if (byDigest.size !== approved.functions.length) return undefined;
  const consumers: ScopePackReaders['consumers'] = [];
  for (const [name, spec] of consumersOf(bundle)) {
    if (!unambiguousModules(spec)) return undefined;
    const modules = spec.modules.filter((module) => module.name === spec.mainModule);
    const main = modules[0];
    if (modules.length !== 1 || main?.type !== 'esm') return undefined;
    const reader = byDigest.get(main.blob.sha256);
    if (reader === undefined) return undefined;
    consumers.push({ name, mainModule: spec.mainModule, ...reader });
  }
  return {
    schemaVersion: 2,
    rolloutId: approved.rolloutId,
    deploymentId: bundle.deploymentId,
    buildId: bundle.buildId,
    platform: approved.platform,
    consumers,
  };
}
