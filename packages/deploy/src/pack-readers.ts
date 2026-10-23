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

/** An uploaded module cannot alias or override the audited main module or one of its imports. */
function unambiguousModules(spec: FunctionSpec): boolean {
  const seen = new Set<string>();
  for (const module of spec.modules) {
    const parts = module.name.split('/');
    if (
      module.name.includes('\\') ||
      module.name.includes(':') ||
      /[\u0000-\u001f\u007f]/u.test(module.name) ||
      parts.some((part) => part === '' || part === '.' || part === '..') ||
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
